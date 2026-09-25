import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import JSON5 from "json5";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayInstallEntrypoint } from "../daemon/gateway-entrypoint.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import {
  parseOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../state/openclaw-schema-versions.js";
import { hasErrnoCode } from "./errors.js";
import { readPackageVersion } from "./package-json.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveSqliteInspectionBudget } from "./sqlite-readonly-worker.js";
import { launchCanary, terminateCanary, waitBounded } from "./update-candidate-canary-process.js";
import { waitForUpdateCandidateReadiness } from "./update-candidate-canary-readiness.js";
import {
  prepareUpdateCandidateRehearsal,
  type UpdateCandidateRehearsal,
} from "./update-candidate-rehearsal.js";
import type { UpdateDoctorConfigChange } from "./update-doctor-config.js";
import {
  applyUpdateDoctorLintReport,
  parseUpdateDoctorLintReport,
  UPDATE_DOCTOR_DISPOSAL_WARNING_PREFIX,
} from "./update-doctor-lint.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
  type UpdatePostInstallDoctorResult,
} from "./update-doctor-result.js";
import {
  createUpdateFailureFact,
  parseConfigFailureFacts,
  type UpdateFailureFact,
} from "./update-failure-facts.js";
import { cleanupUpdateTemporaryDirectory } from "./update-maintenance.js";
import { resolveUpdateDoctorExecutionPolicy } from "./update-runner-doctor.js";
import { UpdateSnapshotCapacityError } from "./update-snapshot-capacity.js";
import type { UpdateStepResult } from "./update-step-result.js";

type CanaryPhase =
  | "snapshot"
  | "doctor"
  | "lint"
  | "config"
  | "plugins"
  | "runtime"
  | "startup"
  | "readiness";

type CanaryResult = {
  phase: CanaryPhase;
  durationMs: number;
  logTail: string[];
  steps: UpdateStepResult[];
  candidateSchemaVersions?: OpenClawSchemaVersions;
  gatewayRestartCompletion?: boolean;
  doctorConfigWrites?: boolean;
  doctorConfigChanges?: UpdateDoctorConfigChange[];
  listenerIsolation?: {
    gateway: { host: "127.0.0.1"; port: number };
    mcpAppSandbox: "disabled";
  };
} & (
  | { status: "ok" }
  | {
      status: "error";
      reason: "doctor-failed" | "candidate-checks-timeout" | "runtime-verification-failed";
    }
);

/** Rehearse the exact candidate against private SQLite snapshots while the serving generation stays up. */
export async function validateUpdateCandidateCanary(params: {
  root: string;
  config: OpenClawConfig;
  stateDir: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  nodeRunner?: string;
  assertCurrent?: () => void;
  /** Emit at completion; replaying after the canary shifts persisted step timestamps. */
  onStep?: (step: UpdateStepResult) => void;
}): Promise<CanaryResult> {
  const started = Date.now();
  let rehearsal: UpdateCandidateRehearsal | undefined;
  const sourceEnv = params.env ?? process.env;
  const logTail: string[] = [];
  const stepLogTail: string[] = [];
  let activeStep = { name: "candidate-runtime", command: "Checking update runtime" };
  let stepStartedAt = started;
  let activeLintStep: UpdateStepResult | undefined;
  const steps: UpdateStepResult[] = [];
  const cleanupRehearsal = async () => {
    if (!rehearsal) {
      return;
    }
    for (const directory of rehearsal.cleanupDirectories) {
      await cleanupUpdateTemporaryDirectory({
        directory,
        root: params.root,
        name:
          directory === rehearsal.stateDir
            ? "candidate-state-cleanup"
            : "candidate-plugin-inventory-cleanup",
        onWarning: (step) => {
          steps.push(step);
          params.onStep?.(step);
        },
      });
    }
  };
  let candidateSchemaVersions: OpenClawSchemaVersions | undefined;
  let gatewayRestartCompletion = false;
  let doctorConfigWrites = false;
  let doctorConfigChanges: UpdateDoctorConfigChange[] = [];
  let listenerIsolation: CanaryResult["listenerIsolation"];
  let phase: CanaryPhase = "runtime";
  let env: NodeJS.ProcessEnv = { ...sourceEnv };
  const capture = (chunk: Buffer | string) => {
    const safe = redactSupportString(
      String(chunk),
      { env, stateDir: params.stateDir },
      { maxLength: 20_000 },
    );
    const lines = safe
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => line.slice(-512));
    for (const tail of [logTail, stepLogTail]) {
      tail.push(...lines);
      tail.splice(0, Math.max(0, tail.length - 40));
    }
    return safe;
  };
  const launch = (
    entry: string,
    args: string[],
    observers: Pick<Parameters<typeof launchCanary>[0], "onLine" | "onStdout"> = {},
  ) =>
    launchCanary({
      ...observers,
      entry,
      args,
      root: params.root,
      env,
      nodeRunner: params.nodeRunner,
      stateDir: params.stateDir,
      assertCurrent: params.assertCurrent,
      capture,
    });
  const stopCanary = async (running: ReturnType<typeof launch>, name: string, deadline: number) => {
    const cleanupStarted = Date.now();
    if (await terminateCanary(running.child, running.closed, deadline)) {
      return true;
    }
    const step: UpdateStepResult = {
      name: `${name}-cleanup`,
      command: "SIGTERM, SIGKILL",
      cwd: params.root,
      durationMs: Date.now() - cleanupStarted,
      exitCode: null,
      advisory: {
        kind: "recoverable-maintenance",
        message:
          "Update cleanup deadline elapsed before process close and termination requests both completed. Update validation results are unchanged.",
      },
    };
    steps.push(step);
    params.onStep?.(step);
    return false;
  };
  try {
    const entry = await resolveGatewayInstallEntrypoint(params.root);
    if (!entry) {
      throw new Error("The update is missing its Gateway executable");
    }
    const continuationEntry = path.join(
      params.root,
      "dist",
      runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
    );
    try {
      await fs.lstat(continuationEntry);
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        throw error;
      }
      const message = "This version uses the current updater to finish installation";
      const step: UpdateStepResult = {
        name: "candidate-recovery",
        command: "--check",
        cwd: params.root,
        durationMs: Date.now() - started,
        exitCode: null,
        stdoutTail: message,
        advisory: { kind: "candidate-runtime-unavailable", message },
      };
      steps.push(step);
      params.onStep?.(step);
      // Older targets also lack the isolated canary CLI; retain their shipped finalization path.
      return { status: "ok", phase, durationMs: Date.now() - started, logTail, steps };
    }
    const policy = resolveUpdateDoctorExecutionPolicy({
      targetVersion: await readPackageVersion(params.root),
      allowGatewayServiceRepair: false,
    });
    if (!policy.fix) {
      throw new Error("Cannot check migrations without changing the running service");
    }
    phase = "snapshot";
    activeStep = { name: "candidate-state-snapshot", command: "Preparing update checks" };
    stepStartedAt = Date.now();
    rehearsal = await prepareUpdateCandidateRehearsal({
      candidateRoot: params.root,
      config: params.config,
      stateDir: params.stateDir,
      env: sourceEnv,
      nodeRunner: params.nodeRunner,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    });
    // Copying private state has its own size/progress budget; preserve the
    // runtime validation budget after large snapshots finish.
    const snapshotDuration = Date.now() - stepStartedAt;
    const snapshotStep: UpdateStepResult = {
      ...activeStep,
      cwd: params.root,
      durationMs: snapshotDuration,
      exitCode: 0,
      snapshotCapacity: rehearsal.snapshotCapacity,
    };
    steps.push(snapshotStep);
    params.onStep?.(snapshotStep);
    env = { ...rehearsal.env };
    const { port, stateDir: copiedStateDir } = rehearsal;
    const doctorResultOptions = { tmpdir: () => copiedStateDir };
    listenerIsolation = {
      gateway: { host: "127.0.0.1", port },
      mcpAppSandbox: "disabled",
    };
    const commands: Array<{ phase: CanaryPhase; name: string; args: string[]; entry?: string }> = [
      {
        phase: "doctor",
        name: "candidate-doctor",
        args: ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"],
      },
      {
        phase: "lint",
        name: "candidate-doctor-lint",
        args: ["doctor", "--lint", "--json", "--severity-min", "error"],
      },
      {
        phase: "config",
        name: "candidate-config",
        args: ["config", "validate", "--json"],
      },
      {
        phase: "plugins",
        name: "candidate-plugins",
        args: ["plugins", "list", "--json"],
      },
      {
        phase: "runtime",
        name: "candidate-recovery",
        // After a schema bump only a fresh candidate may finalize the run;
        // prove its full recovery import graph before live state changes.
        entry: continuationEntry,
        args: ["--check"],
      },
    ];
    // Each fresh process may inspect the private state again, including the Gateway.
    const processBudget = resolveSqliteInspectionBudget(
      "update validation",
      copiedStateDir,
      rehearsal.snapshotCapacity.sqliteBytes + (rehearsal.snapshotCapacity.pluginBytes ?? 0),
    ).timeoutMs;
    const budget = Math.max(1, params.timeoutMs ?? processBudget);
    let deadline = 0;
    let workDeadline = 0;
    const startBudget = () => {
      deadline = Date.now() + budget;
      workDeadline = deadline - Math.min(2_000, Math.floor(budget / 10));
    };
    const remaining = () => {
      params.signal?.throwIfAborted();
      params.assertCurrent?.();
      const milliseconds = workDeadline - Date.now();
      if (milliseconds <= 0) {
        throw new Error("Update validation deadline exceeded");
      }
      return milliseconds;
    };
    for (const command of commands) {
      phase = command.phase;
      activeLintStep = undefined;
      env.OPENCLAW_UPDATE_IN_PROGRESS = phase === "doctor" ? "1" : "0";
      activeStep = { name: command.name, command: command.args.join(" ") };
      stepStartedAt = Date.now();
      stepLogTail.length = 0;
      startBudget();
      remaining();
      const doctorResultPath =
        phase === "doctor"
          ? createUpdatePostInstallDoctorResultPath(doctorResultOptions)
          : undefined;
      env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV] = doctorResultPath;
      const configBeforeDoctor: unknown = doctorResultPath
        ? JSON5.parse(await fs.readFile(rehearsal.configPath, "utf8"))
        : undefined;
      let checksCompletedAt: number | undefined;
      const disposalWarnings: string[] = [];
      const running = launch(command.entry ?? entry, command.args, {
        onLine: (line) => {
          const plain = stripVTControlCharacters(line).trim();
          if (phase === "lint" && plain.startsWith(UPDATE_DOCTOR_DISPOSAL_WARNING_PREFIX)) {
            disposalWarnings.push(redactSupportString(plain, { env, stateDir: params.stateDir }));
          }
          if (phase === "doctor" && /^(?:└\s*)?Doctor complete\.$/u.test(plain)) {
            checksCompletedAt ??= Date.now();
          }
        },
        onStdout: (stdout) => {
          if (phase === "lint") {
            try {
              parseUpdateDoctorLintReport(stdout);
              checksCompletedAt ??= Date.now();
            } catch {
              checksCompletedAt = undefined;
            }
          }
        },
      });
      let code: number | null = null;
      let doctorAdvisory: UpdateStepResult["advisory"];
      let doctorReceipt: UpdatePostInstallDoctorResult | null = null;
      const pluginFailures: UpdateFailureFact[] = [];
      const pluginObservations: string[] = [];
      let timedOut = false;
      let timeoutMessage: string | undefined;
      let exitWarning: string | undefined;
      try {
        const outcome = await waitBounded(running.result, remaining(), params.signal);
        // Freeze the winning outcome before teardown can make a killed child
        // emit a successful close event.
        code = outcome.status === "completed" ? outcome.value : 1;
        timedOut = outcome.status === "deadline";
        if (timedOut) {
          const elapsed = Date.now() - stepStartedAt;
          // Freeze this child's result before termination can emit late completion output.
          const lintReport =
            phase === "lint" && checksCompletedAt !== undefined && !running.outputExceeded()
              ? parseUpdateDoctorLintReport(running.stdout(), env)
              : undefined;
          const completed = checksCompletedAt !== undefined && (phase === "doctor" || lintReport);
          timeoutMessage = `Update ${phase} checks phase timed out (${elapsed}ms)`;
          if (completed && checksCompletedAt !== undefined) {
            exitWarning = `Update ${phase} exit phase timed out after ${Date.now() - checksCompletedAt}ms (${elapsed}ms total); checks completed; ${running.processExited() ? "output pipes stayed open" : "process did not exit"}. Continuing with recorded check results.`;
            code =
              phase === "doctor" ||
              (lintReport &&
                (lintReport.ok || lintReport.advisoryOnly) &&
                !lintReport.failureFacts.length)
                ? 0
                : 1;
          }
        }
      } finally {
        await stopCanary(running, command.name, deadline);
        if (doctorResultPath) {
          doctorReceipt = await consumeUpdatePostInstallDoctorResult(
            doctorResultPath,
            doctorResultOptions,
          );
          if (doctorReceipt?.status === "error") {
            code = 1;
          }
          doctorConfigChanges = doctorReceipt?.configChanges ?? [];
          // Shipped Doctors predate typed receipts; observe only their private write window.
          if (!doctorReceipt?.configChanges && isRecord(configBeforeDoctor)) {
            const after: unknown = JSON5.parse(await fs.readFile(rehearsal.configPath, "utf8"));
            if (isRecord(after)) {
              doctorConfigChanges = [
                ...new Set([...Object.keys(configBeforeDoctor), ...Object.keys(after)]),
              ]
                .filter((key) => !isDeepStrictEqual(configBeforeDoctor[key], after[key]))
                .toSorted()
                .map((key) => ({ kind: "key", key }));
            }
          }
          if (
            code === UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE &&
            doctorReceipt?.status === "advisory"
          ) {
            doctorAdvisory = {
              kind: "recoverable-maintenance",
              message: doctorReceipt.advisory.details.join("\n"),
            };
          }
        }
      }
      activeLintStep =
        phase === "lint"
          ? {
              ...activeStep,
              cwd: params.root,
              durationMs: Date.now() - stepStartedAt,
              exitCode: running.child.exitCode,
              signal: running.child.signalCode,
              killed: running.child.killed,
              termination: timedOut ? "timeout" : running.child.signalCode ? "signal" : "exit",
              outputLimitExceeded: running.outputExceeded(),
              doctorLintFindings: [],
            }
          : undefined;
      params.signal?.throwIfAborted();
      const lintReport = activeLintStep
        ? applyUpdateDoctorLintReport(activeLintStep, running.stdout(), code, env)
        : undefined;
      doctorAdvisory ??= activeLintStep?.advisory;
      if (code === 0 && phase === "plugins") {
        const fail = (message: string) => {
          code = 1;
          capture(message);
          if (pluginFailures.length < 5) {
            const fact = { check: "plugins", code: "candidate-plugins-failed", message };
            pluginFailures.push(createUpdateFailureFact(fact, env));
          }
        };
        const inventory: unknown = running.outputExceeded()
          ? undefined
          : JSON.parse(running.stdout());
        const plugins =
          isRecord(inventory) && Array.isArray(inventory.plugins) ? inventory.plugins : undefined;
        const registry =
          isRecord(inventory) && isRecord(inventory.registry) ? inventory.registry : undefined;
        const diagnostics = [
          ...(isRecord(inventory) && Array.isArray(inventory.diagnostics)
            ? inventory.diagnostics
            : []),
          ...(Array.isArray(registry?.diagnostics) ? registry.diagnostics : []),
        ];
        const failedPluginIds = new Set<string>();
        if (
          !plugins ||
          plugins.some((plugin) => !isRecord(plugin) || typeof plugin.id !== "string")
        ) {
          fail("Plugin checks returned an invalid inventory");
        } else {
          for (const plugin of plugins) {
            if (isRecord(plugin) && plugin.status === "error" && typeof plugin.id === "string") {
              failedPluginIds.add(plugin.id);
            }
          }
          for (const diagnostic of diagnostics) {
            if (isRecord(diagnostic) && diagnostic.level === "error") {
              if (typeof diagnostic.pluginId !== "string") {
                fail(
                  typeof diagnostic.message === "string"
                    ? diagnostic.message
                    : "Plugin registry reported an unattributed error",
                );
              } else {
                failedPluginIds.add(diagnostic.pluginId);
              }
            }
          }
          for (const pluginId of failedPluginIds) {
            const message = `Plugin "${pluginId}" could not be loaded during the update preview.`;
            pluginObservations.push(message);
            capture(message);
          }
        }
      }
      if (code === 0 && phase === "runtime") {
        const contract: unknown = running.outputExceeded()
          ? undefined
          : JSON.parse(running.stdout());
        candidateSchemaVersions = parseOpenClawSchemaVersions(contract);
        gatewayRestartCompletion = isRecord(contract) && contract.gatewayRestartCompletion === true;
        doctorConfigWrites = isRecord(contract) && contract.doctorConfigWrites === "pid-start-v1";
        if (!candidateSchemaVersions) {
          code = 1;
          capture("The update did not report its supported database versions");
        }
      }
      const step: UpdateStepResult = activeLintStep ?? {
        ...activeStep,
        cwd: params.root,
        durationMs: Date.now() - stepStartedAt,
        exitCode: timedOut ? null : code,
        ...(timedOut ? { termination: "timeout" as const } : {}),
      };
      if (doctorAdvisory) {
        step.advisory = doctorAdvisory;
      } else if (exitWarning && code === 0) {
        step.advisory = { kind: "recoverable-maintenance", message: exitWarning };
      }
      const lintWarnings = [...disposalWarnings, ...(exitWarning ? [exitWarning] : [])];
      if (lintWarnings.length) {
        step.warnings = [...(step.warnings ?? []), ...lintWarnings];
      }
      if (code === 0 && pluginObservations.length > 0) {
        step.stdoutTail = pluginObservations.join("\n");
      }
      const failureMessage =
        timeoutMessage && !exitWarning
          ? timeoutMessage
          : `Update ${phase === "lint" ? "health check" : phase} failed`;
      if (code !== 0 && !doctorAdvisory) {
        let findings =
          doctorReceipt?.status === "error" ? doctorReceipt.failureFacts : pluginFailures;
        if (!findings?.length && lintReport) {
          findings = lintReport.failureFacts;
        }
        if (!findings?.length && phase === "config" && !running.outputExceeded()) {
          findings = parseConfigFailureFacts(running.stdout(), env);
        }
        step.failureFacts = findings?.length
          ? findings
          : [
              createUpdateFailureFact(
                {
                  check: phase,
                  code:
                    timedOut && !exitWarning
                      ? "candidate-checks-timeout"
                      : phase === "doctor" || phase === "lint"
                        ? "doctor-failed"
                        : `candidate-${phase}-failed`,
                  message: timedOut
                    ? failureMessage
                    : (running.firstStderrLine() ?? failureMessage),
                },
                env,
              ),
            ];
      }
      steps.push(step);
      if (code !== 0 && !doctorAdvisory) {
        throw new Error(failureMessage);
      }
      params.onStep?.(step);
    }
    if (!candidateSchemaVersions) {
      throw new Error("The update did not report its supported database versions");
    }
    phase = "startup";
    activeStep = { name: "candidate-gateway-startup", command: "gateway run" };
    stepStartedAt = Date.now();
    stepLogTail.length = 0;
    startBudget();
    remaining();
    const args = ["gateway", "run", "--update-canary", "--bind", "loopback"];
    const running = launch(entry, [...args, "--port", String(port)]);
    try {
      const probeFailure = await waitForUpdateCandidateReadiness({
        port,
        workDeadline,
        started,
        signal: params.signal,
        assertCurrent: params.assertCurrent,
        hasExited: running.hasExited,
        getExitReason: running.firstStderrLine,
        env,
        stateDir: params.stateDir,
        onEndpoint: (endpoint) => {
          phase = endpoint === "startupz" ? "startup" : "readiness";
        },
        capture,
      });
      if (probeFailure) {
        capture("Update checks reached their time limit; Gateway readiness remains unverified.");
      }
      const step: UpdateStepResult = {
        ...activeStep,
        cwd: params.root,
        durationMs: Date.now() - stepStartedAt,
        exitCode: probeFailure ? null : 0,
        ...(probeFailure
          ? {
              advisory: { kind: "candidate-runtime-unavailable", message: probeFailure.message },
              failureFacts: [probeFailure.fact],
            }
          : {}),
      };
      steps.push(step);
      params.onStep?.(step);
    } finally {
      await stopCanary(running, "candidate-gateway-startup", deadline);
    }
    return {
      status: "ok",
      phase,
      durationMs: Date.now() - started,
      logTail,
      candidateSchemaVersions,
      gatewayRestartCompletion,
      ...(doctorConfigWrites ? { doctorConfigWrites } : {}),
      ...(doctorConfigChanges.length ? { doctorConfigChanges } : {}),
      listenerIsolation,
      steps,
    };
  } catch (error) {
    const durationMs = Date.now() - stepStartedAt;
    const displayPhase = phase === "lint" ? "health" : phase;
    const failureLine = capture(
      `${displayPhase}: ${error instanceof Error ? error.message : String(error)} (${durationMs}ms)`,
    );
    let failed = steps.at(-1);
    if (!failed || (failed.exitCode === 0 && failed !== activeLintStep) || failed.advisory) {
      failed = activeLintStep ?? {
        ...activeStep,
        cwd: params.root,
        durationMs: Date.now() - stepStartedAt,
        exitCode: 1,
      };
      steps.push(failed);
    }
    if (error instanceof UpdateSnapshotCapacityError) {
      failed.snapshotCapacity = error.capacity;
    }
    failed.failureFacts ??= [
      createUpdateFailureFact(
        {
          check: phase === "readiness" ? "readyz" : phase === "startup" ? "startupz" : phase,
          code:
            phase === "doctor" || phase === "lint" ? "doctor-failed" : `candidate-${phase}-failed`,
          message: error instanceof Error ? error.message : String(error),
        },
        env,
      ),
    ];
    // Keep the aggregate log, but do not replay a complete fact as generated timing metadata.
    const repeatsFact =
      failed.termination !== "timeout" &&
      failed.failureFacts.some(
        (fact) => failureLine === `${displayPhase}: ${fact.message} (${durationMs}ms)`,
      );
    failed.stderrTail = stepLogTail.slice(0, repeatsFact ? -1 : undefined).join("\n");
    params.onStep?.(failed);
    return {
      status: "error",
      reason: failed.failureFacts.some((fact) => fact.code === "candidate-checks-timeout")
        ? "candidate-checks-timeout"
        : phase === "doctor" || phase === "lint"
          ? "doctor-failed"
          : "runtime-verification-failed",
      phase,
      durationMs: Date.now() - started,
      logTail,
      candidateSchemaVersions,
      gatewayRestartCompletion,
      ...(doctorConfigChanges.length ? { doctorConfigChanges } : {}),
      listenerIsolation,
      steps,
    };
  } finally {
    await cleanupRehearsal();
  }
}
