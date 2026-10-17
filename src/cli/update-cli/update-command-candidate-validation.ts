import os from "node:os";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { tryReadJson } from "../../infra/json-files.js";
import { validateUpdateCandidateCanary } from "../../infra/update-candidate-canary.js";
import { assertUpdateDatabaseEngineContexts } from "../../infra/update-database-engine-admission.js";
import { createUpdateDoctorConfigWarningStep } from "../../infra/update-doctor-config.js";
import { isFailedUpdateStep } from "../../infra/update-run-step.js";
import { recordUpdateRunStepAsync } from "../../infra/update-run-write.async.js";
import { reportUpdateStepCompletion } from "../../infra/update-runner-command.js";
import type { UpdateRunResult, UpdateStepProgress } from "../../infra/update-runner-types.js";
import { resolveBundledPluginsDir } from "../../plugins/bundled-dir.js";
import { defaultRuntime } from "../../runtime.js";
import {
  parsePackageOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../../state/openclaw-schema-versions.js";
import { prepareOpenClawStateReadSource } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { isCandidateAdmissionContextCovered } from "./schema-preflight.js";
import { UpdatePreMutationError, type UpdateCommandOptions } from "./shared.js";
import type { inspectUpdateDatabaseContexts } from "./update-command-database-context.js";
import type { createUpdateCommandExecutionGuards } from "./update-command-execution-guards.js";
import type { MutableUpdateExecutionParams } from "./update-command-execution.types.js";
import { isUpdatedInstallGatewayExecutorSupported } from "./update-command-service-command.js";
import { resolveUpdatedInstallCommandEnv } from "./update-command-service-env.js";

export async function preflightUpdateCandidatePlugins(
  execution: Pick<MutableUpdateExecutionParams, "channel" | "opts" | "updateStepTimeoutMs">,
  params: {
    targetVersion: string | null;
    candidateAdmissionChecks?: readonly string[];
    readAdmission: () => Promise<Awaited<ReturnType<typeof inspectUpdateDatabaseContexts>>>;
  },
): Promise<void> {
  const admission = await params.readAdmission();
  const context = admission.foreground ? admission.contexts[0]! : admission.contexts.at(-1)!;
  if (
    params.candidateAdmissionChecks?.includes("plugin-availability") &&
    isCandidateAdmissionContextCovered(context.env)
  ) {
    return;
  }
  const { preflightConfiguredNpmPluginTargets } =
    await import("./update-command-plugin-preflight.js");
  const warnings = await preflightConfiguredNpmPluginTargets({
    config: context.configSnapshot.sourceConfig,
    env: context.env,
    targetVersion: params.targetVersion,
    channel: execution.channel,
    timeoutMs: execution.updateStepTimeoutMs,
  });
  for (const warning of warnings) {
    defaultRuntime[execution.opts.json ? "error" : "log"](warning.message);
  }
}

export async function validateUpdateCandidateWithProgress(
  params: Pick<Parameters<typeof validateUpdateCandidateCanary>[0], "root" | "config"> & {
    sourcePackageRoot?: string;
    env: NodeJS.ProcessEnv;
    assertCurrent: () => void;
    writeOptions: ReturnType<
      ReturnType<typeof createUpdateCommandExecutionGuards>["captureWriteOptions"]
    >;
  },
  execution: {
    packageUpdateNodeRunner?: string;
    timeoutMs?: number;
    opts: Pick<UpdateCommandOptions, "json">;
    progress: UpdateStepProgress;
  },
  run: UpdateCommandOptions["run"],
) {
  const assertCurrent = params.assertCurrent;
  const writeOptions = run ? { ...params.writeOptions } : undefined;
  const originalContext = writeOptions?.context;
  const source = originalContext
    ? prepareOpenClawStateReadSource({
        path: originalContext.admission.databasePath,
        env: writeOptions?.env,
      })
    : undefined;
  if (originalContext && source) {
    const initial = source.current();
    originalContext.admission.assertCurrent();
    if (
      initial.admission.identity.key !== originalContext.admission.identity.key ||
      initial.admission.identity.birthtime !== originalContext.admission.identity.birthtime ||
      initial.maintenanceScope !== originalContext.maintenanceScope ||
      initial.existingSchemaPath !== originalContext.existingSchemaPath
    ) {
      throw new Error("Candidate progress lost its original state source.");
    }
  }
  const validate = () =>
    validateUpdateCandidateCanary({
      ...params,
      sourceBundledPlugins: params.sourcePackageRoot
        ? { packageRoot: params.sourcePackageRoot, directory: resolveBundledPluginsDir(params.env) }
        : undefined,
      assertCurrent,
      stateDir: resolveStateDir(params.env),
      nodeRunner: execution.packageUpdateNodeRunner,
      timeoutMs: execution.timeoutMs,
      onProgress: async (step) => {
        assertCurrent();
        if (run) {
          await recordUpdateRunStepAsync(run.runId, step, {
            ...writeOptions,
            context: source?.workerContext(),
          });
        }
        assertCurrent();
        defaultRuntime[execution.opts.json ? "error" : "log"](
          `${step.step}: ${step.detail ?? step.status}`,
        );
      },
      onStep: (step) =>
        reportUpdateStepCompletion(execution.progress, { ...step, index: 0, total: 0 }),
    });
  const validation =
    source && run
      ? await runOpenClawStateWorkerOperation(
          source.workerContext(),
          // Keep the actual progress writer alive throughout even a silent copy.
          validate,
          { existingOnly: true, assertCurrent },
        )
      : await validate();
  if (!validation) {
    throw new Error("Candidate progress database disappeared before snapshot admission.");
  }
  assertCurrent();
  const changes = validation.doctorConfigChanges ?? [];
  if (validation.status === "ok" && validation.doctorConfigWrites !== true && changes.length) {
    const warning = createUpdateDoctorConfigWarningStep(params.root, changes);
    validation.steps.push(warning);
    await reportUpdateStepCompletion(execution.progress, { ...warning, index: 0, total: 0 });
    assertCurrent();
  }
  return validation;
}

export function assertUpdateCandidateSteps(steps: UpdateRunResult["steps"]): void {
  const failed = steps.find(isFailedUpdateStep);
  if (failed) {
    throw new UpdatePreMutationError(failed.name, failed.stderrTail ?? "Update checks failed.", {
      failureFacts: failed.failureFacts,
    });
  }
}

/** Reject candidates that cannot retain the installed updater's native authority. */
export async function assertUpdateCandidateExecutor(params: {
  root: string;
  env: NodeJS.ProcessEnv;
  run: UpdateCommandOptions["run"];
  shouldRestart: boolean;
  serviceOwned: boolean;
  invocationCwd?: string;
  timeoutMs: number;
  nodeRunner?: string;
  assertCurrent: () => void;
}): Promise<void> {
  if (!params.shouldRestart || !params.run || !params.serviceOwned) {
    return;
  }
  params.assertCurrent();
  const executor = params.run.executorFence;
  if (!executor) {
    throw new UpdatePreMutationError(
      "target-native-unsupported",
      "Starting the update requires its original update process.",
    );
  }
  const supported = await isUpdatedInstallGatewayExecutorSupported({
    root: params.root,
    env: resolveUpdatedInstallCommandEnv({
      processEnv: params.env,
      invocationCwd: params.invocationCwd,
    }),
    executor,
    timeoutMs: params.timeoutMs,
    nodeRunner: params.nodeRunner,
  });
  params.assertCurrent();
  if (!supported) {
    throw new UpdatePreMutationError(
      "target-native-unsupported",
      "Target runtime cannot fence update-owned native commands; refusing before Gateway stop or package activation.",
    );
  }
}

/** Staged package metadata owns database support; Git retains its inspected revision facts. */
export async function admitUpdateCandidateDatabaseMetadata(
  root: string,
  installKind: "package" | "git",
  contexts: readonly { config: OpenClawConfig; env: NodeJS.ProcessEnv }[],
  previousVersions?: OpenClawSchemaVersions,
): Promise<OpenClawSchemaVersions | undefined> {
  if (installKind === "git") {
    return previousVersions;
  }
  const manifest = await tryReadJson<unknown>(path.join(root, "package.json"));
  const declaration = asNullableRecord(asNullableRecord(manifest)?.openclaw);
  await assertUpdateDatabaseEngineContexts(
    contexts,
    declaration?.databaseEngines,
    declaration?.postgresFamilies,
  );
  return parsePackageOpenClawSchemaVersions(manifest) ?? previousVersions;
}

/** Candidate proof belongs to the selected source contexts and precedes mutable preparation. */
export function createUpdateDatabaseFamilyAdmission(
  execution: Pick<
    MutableUpdateExecutionParams,
    | "root"
    | "updateInstallKind"
    | "packageUpdateNodeRunner"
    | "updateStepTimeoutMs"
    | "channel"
    | "tag"
    | "packageInstallSpec"
    | "packageInstallTarget"
    | "opts"
    | "shouldRestart"
  >,
) {
  type Context = { config: OpenClawConfig; env: NodeJS.ProcessEnv };
  let pending: readonly Context[] = [];
  let admitted = true;
  return {
    selectContexts(contexts: readonly Context[], checks?: readonly string[]) {
      pending = contexts.filter(
        ({ config, env }) =>
          config.database?.families &&
          !(checks?.includes("database-families") && isCandidateAdmissionContextCovered(env)),
      );
      admitted = pending.length === 0;
      return !admitted;
    },
    async validate(candidateRoot: string) {
      if (!pending.length) {
        return;
      }
      const { runUpdateCandidateAdmission } =
        await import("../../infra/update-candidate-admission.js");
      const { resolveUpdateInstallRoot } = await import("../../infra/update-install-root.js");
      const { readPackageVersion } = await import("../../infra/package-json.js");
      const { VERSION } = await import("../../version.js");
      const { detectPackageManager } = await import("../../infra/detect-package-manager.js");
      const packageManager =
        execution.packageInstallTarget?.manager ?? (await detectPackageManager(candidateRoot));
      if (!packageManager) {
        throw new UpdatePreMutationError(
          "database-engine-preflight",
          "Cannot determine the candidate package manager for family admission.",
        );
      }
      const [installedVersion, candidateVersion] = await Promise.all([
        readPackageVersion(execution.root),
        readPackageVersion(candidateRoot),
      ]);
      for (const { env } of pending) {
        const result = await runUpdateCandidateAdmission({
          candidateRoot,
          nodeRunner: execution.packageUpdateNodeRunner,
          timeoutMs: execution.updateStepTimeoutMs,
          env,
          context: {
            protocol: 1,
            installation: {
              root: execution.root,
              canonicalRoot: resolveUpdateInstallRoot(execution.root),
              version: installedVersion,
              installKind: execution.updateInstallKind,
              packageManager,
            },
            target: {
              spec: execution.packageInstallSpec ?? execution.tag,
              version: candidateVersion,
              source: "artifact",
              channel: execution.channel,
              tag: execution.tag,
            },
            request: {
              yes: Boolean(execution.opts.yes),
              noRestart: !execution.shouldRestart,
              acceptCapabilities: Boolean(execution.opts.acceptCapabilities),
              json: Boolean(execution.opts.json),
              timeoutMs: execution.updateStepTimeoutMs,
            },
            run: { id: execution.opts.run?.runId ?? "database-family-admission" },
            supervisor: { version: VERSION, host: os.hostname(), pid: process.pid },
          },
        });
        if (
          result.verdict?.verdict !== "admit" ||
          !result.verdict.facts.checks.some(
            (check) => check.name === "database-families" && check.status === "ok",
          )
        ) {
          throw new UpdatePreMutationError(
            "database-engine-preflight",
            "Update refused: the candidate did not prove support for database.families and the selected PostgreSQL families. Stay on the current version or choose a family-aware candidate. " +
              (result.verdict?.reasons[0]?.message ??
                result.warning?.message ??
                "The candidate omitted its database-families admission check."),
          );
        }
      }
      admitted = true;
    },
    assertAdmitted() {
      if (!admitted) {
        throw new UpdatePreMutationError(
          "database-engine-preflight",
          "Update refused: the candidate has not proved support for database.families before mutation.",
        );
      }
    },
  };
}
