import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, vi, type Mock } from "vitest";
import { waitForFile } from "../../test/helpers/process-wait.js";
import { DEFAULT_VITEST_TEST_TIMEOUT_MS } from "../../test/vitest/vitest.timeouts.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { writeRestartSentinel } from "./restart-sentinel.js";
import { writeTriageUpdateFailure } from "./update-failure-report-artifact.js";
import type { ManagedServiceBoundaryOptions } from "./update-managed-service-handoff-boundary-contract.test-support.js";
import {
  awaitEmulatedRecoveryHandoffExit,
  createManagedServiceCommandFixture,
  LAUNCHD_GATEWAY_IDENTITY_ENV,
  waitForHandoffResponse,
} from "./update-managed-service-handoff-command.test-support.js";
import {
  createManagedServiceCancellationPreload,
  createManagedServiceLaunchdClockPreload,
  prepareManagedServiceTriageClockPreload,
  createManagedServiceUpdaterFixtureScript,
  createManagedServiceManagerFixtureScript,
  isManagedServiceInspectionCommand,
  type ManagedServiceCommandTiming,
  type ManagedServiceManagerBoundaryResult,
} from "./update-managed-service-handoff-lifecycle.test-support.js";
import { prepareManagedServiceParentPreloads } from "./update-managed-service-handoff-parent.test-support.js";
import {
  createManagedServiceBoundaryCleanup,
  createManagedServiceBoundaryParent,
} from "./update-managed-service-handoff-process.test-support.js";
import {
  prepareManagedServiceProfileRequester,
  observeManagedServiceProfileRefusal,
} from "./update-managed-service-handoff-profile.test-support.js";
import {
  prepareManagedServiceBoundaryFiles,
  prepareManagedServiceRuntimeFixture,
  prepareManagedServiceSpawn,
} from "./update-managed-service-handoff-runtime.test-support.js";
import {
  managedServiceStateUpdateScript,
  readManagedServiceHandoffLease,
  readRestartSentinelPayload,
} from "./update-managed-service-handoff-state.test-support.js";
import {
  createManagedServiceActivationScript,
  pathExists,
  readSavedFailure,
} from "./update-managed-service-native.test-support.js";
import { createUpdateRun, getUpdateRun } from "./update-run-ledger.js";

export function createManagedServiceManagerBoundary({
  spawnMock,
  tempDirs,
  cleanups,
}: {
  spawnMock: Mock;
  tempDirs: Set<string>;
  cleanups: Set<() => Promise<void>>;
}) {
  return async function runManagedServiceManagerBoundary(
    kind: "systemd" | "launchd",
    providedOptions?: ManagedServiceBoundaryOptions,
  ): Promise<ManagedServiceManagerBoundaryResult> {
    let options = providedOptions;
    const { spawn } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const { startManagedServiceUpdateHandoff } =
      await import("./update-managed-service-handoff.js");
    const prefix = `openclaw-${kind}-manager-boundary-${options?.updaterOutput === "split-utf8" ? "安装-" : ""}`;
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
    tempDirs.add(root);
    const commandsPath = path.join(root, "manager-commands.log");
    const statePath = path.join(root, "manager-state.json");
    const selectedDriverPath = options?.selectedDriver
      ? path.join(root, `selected-driver-${options.selectedDriver}.cjs`)
      : undefined;
    const updaterPath = path.join(root, "updater-ran");
    const validationStartedPath = path.join(root, "validation-started");
    const validationReleasePath = path.join(root, "validation-release");
    const activationGatePath = path.join(root, "activation-gate");
    const activationReleasePath = path.join(root, "activation-release");
    const mutationPath = path.join(root, "cancelled-service-mutation");
    const updaterPidPath = path.join(root, "updater-pid");
    const commandTimingsPath = path.join(root, "manager-command-timings.jsonl");
    const stopSettlementPath = path.join(root, "stop-settlement.json");
    const { recoveryModulePath, stateDatabasePath, consumeNotification, invocationCwd } =
      await prepareManagedServiceBoundaryFiles({ root, statePath, options });
    const { parent, parentClosed, parentPid, parentStartIdentity } =
      createManagedServiceBoundaryParent(spawn);
    await fs.writeFile(
      path.join(root, kind === "systemd" ? "systemctl" : "launchctl"),
      createManagedServiceManagerFixtureScript({
        kind,
        parentPid,
        statePath,
        commandsPath,
        configPath: path.join(root, "openclaw.json"),
        options,
      }),
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      ...(kind === "launchd" ? LAUNCHD_GATEWAY_IDENTITY_ENV : {}),
      // Source descendants run from the durable helper cwd, outside this checkout.
      TSX_TSCONFIG_PATH: path.resolve("tsconfig.json"),
      OPENCLAW_STATE_DIR: root,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
    };
    options = await prepareManagedServiceProfileRequester(options, env);
    const run = options?.ledger
      ? createUpdateRun(
          {
            trigger: options.requester ? "chat" : (options.trigger ?? "api"),
            origin: {
              ...options.origin,
              ...(options.requester ? { requester: options.requester } : {}),
            },
          },
          { env },
        )
      : undefined;
    const { sourceRuntimeImport, ledgerRuntimeImport } = await prepareManagedServiceRuntimeFixture({
      recoveryModulePath,
      statePath,
      configPath: env.OPENCLAW_CONFIG_PATH,
      validationReleasePath,
      activationGatePath,
      activationReleasePath,
      ledger: Boolean(run),
      options,
    });
    let helper: import("node:child_process").ChildProcess | undefined;
    let helperCompletion: Promise<number | null> | undefined;
    let helperLogPath: string | undefined;
    const cleanup = createManagedServiceBoundaryCleanup(() => [helper, parent]);
    cleanups.add(cleanup);
    try {
      await startManagedServiceUpdateHandoff({
        ...(options?.systemScope ? { supervisor: "systemd" as const } : {}),
        runId: run?.runId,
        ...(options?.beforeParkNotice ? { beforePark: async () => {} } : {}),
        ...(options?.profileRequester ? { requesterAuthority: { assertCurrent() {} } } : {}),
        root,
        timeoutMs: options?.recoveryTimeoutMs,
        restartDrainTimeoutMs: 300_000,
        parentPid,
        invocationCwd,
        requester: options?.requester,
        execPath: resolveTestNodeExecPath(),
        argv1: selectedDriverPath ?? process.argv[1],
        handoffId: `${kind}-boundary`,
        env,
        meta: { handoffId: `${kind}-boundary` },
      });
      const [, generatedArgs, { env: childEnv }] = spawnMock.mock.calls.at(-1) as [
        string,
        string[],
        { env: NodeJS.ProcessEnv },
      ];
      const [scriptPath, generatedParamsPath] = generatedArgs;
      if (!scriptPath || !generatedParamsPath) {
        throw new Error("expected generated managed handoff script and parameters");
      }
      const generated = JSON.parse(await fs.readFile(generatedParamsPath, "utf8")) as Record<
        string,
        unknown
      >;
      helperLogPath = String(generated.logPath);
      const mockedChild = spawnMock.mock.results.at(-1)
        ?.value as import("node:child_process").ChildProcess;
      mockedChild.emit("exit", 0, null);
      tempDirs.add(path.dirname(scriptPath));
      const paramsPath = path.join(root, "manager-helper.json");
      const commandFixture = createManagedServiceCommandFixture({
        kind,
        root,
        statePath,
        stateDatabasePath,
        options,
      });
      let updaterScript = createManagedServiceUpdaterFixtureScript({
        kind,
        root,
        statePath,
        updaterPath,
        logPath: String(generated.logPath),
        stateDatabasePath,
        consumeNotification,
        options,
      });
      if (run && options?.rollbackRestoration) {
        updaterScript = `void (async () => {
          ${ledgerRuntimeImport}
          ledger.recordUpdateRunPhase(${JSON.stringify(run.runId)}, "restarting", {
            before: { version: "1.0.0" }, after: { version: "1.0.0" },
            step: { step: "previous generation restoration", status: "completed", endedAtMs: Date.now() },
          });
          ledger.recordUpdateRunVerification(${JSON.stringify(run.runId)}, {
            serviceRunning: false, pid: ${parentPid}, readyz: false, settled: false,
            channelsReady: false, pluginErrors: ["candidate plugin failed"],
          });
          ${managedServiceStateUpdateScript(statePath, "state.previousGenerationRestored = true")};
          ${updaterScript}
        })().catch((error) => { console.error(error); process.exit(18); });`;
      }
      if (run) {
        updaterScript = `void (async () => {
          ${ledgerRuntimeImport}
          ledger.recordUpdateRunPhase(${JSON.stringify(run.runId)}, "staging");
          ledger.recordUpdateRunPhase(${JSON.stringify(run.runId)}, "validating");
          ${updaterScript}
        })().catch((error) => { console.error(error); process.exit(18); });`;
      }
      if (options?.replaceLedgerWriter) {
        const installedLedgerModule = `${ledgerRuntimeImport}
        export const { finishUpdateRun, recordUpdateRunDiagnostic } = ledger;
      `;
        updaterScript =
          `require("node:fs").writeFileSync(${JSON.stringify(recoveryModulePath)}, ${JSON.stringify(installedLedgerModule)});` +
          updaterScript;
      }
      if (invocationCwd) {
        // Consuming a relative input then removing cwd forces recovery and triage
        // to launch from the durable helper directory, not the vanished caller cwd.
        updaterScript =
          `const inputFs=require("node:fs");if(inputFs.readFileSync("update-input.txt","utf8")!=="selected target")process.exit(42);inputFs.rmSync(process.cwd(),{recursive:true});` +
          updaterScript;
      }
      if (options?.controlDisconnect === "transferred") {
        const continuation = options.validationResult
          ? `process.stdout.write(JSON.stringify({root:${JSON.stringify(root)},status:${JSON.stringify(options.validationResult === "failed" ? "error" : "skipped")},mode:"npm",reason:${JSON.stringify(options.validationResult === "failed" ? "candidate-validation-failed" : "already-current")}}));`
          : createManagedServiceActivationScript({
              ...options,
              sourceRuntimeImport,
              statePath,
              updaterScript,
            });
        updaterScript = `
        const validationFs = require("node:fs");
        const validationStartedAt = Date.now();
        validationFs.writeFileSync(${JSON.stringify(validationStartedPath)}, "validating");
        validationFs.writeFileSync(${JSON.stringify(validationStartedPath)}, String(Date.now() - validationStartedAt));
        const gate = setInterval(() => {
          if (!validationFs.existsSync(${JSON.stringify(validationReleasePath)})) return;
          clearInterval(gate);
          ${continuation}
        }, 5);
      `;
      }
      if (selectedDriverPath) {
        expect(generated.commandArgv).toEqual([
          resolveTestNodeExecPath(),
          selectedDriverPath,
          "update",
          "--yes",
          "--json",
        ]);
        await fs.writeFile(selectedDriverPath, updaterScript);
      }
      await fs.writeFile(
        paramsPath,
        JSON.stringify({
          ...generated,
          parentPid,
          parentStartIdentity: String(parentStartIdentity),
          ...(options?.parentExitTimeoutMs === undefined
            ? {}
            : {
                parentExitDeadlineAt: Date.now() + options.parentExitTimeoutMs,
                parentExitTimeoutMs: options.parentExitTimeoutMs,
              }),
          ...(options?.overdueCommit ? { parentExitDeadlineAt: Date.now() - 1 } : {}),
          ...(options?.systemdHandoffDeadlineMs === undefined
            ? {}
            : { parentExitDeadlineAt: Date.now() + options.systemdHandoffDeadlineMs }),
          ...commandFixture,
          ...(options?.systemScope ? { serviceRecovery: undefined } : {}),
          // Triage hangs must reach the diagnostic cap without timing out healthy recovery.
          ...(options?.recoveryHang ? { recoveryTimeoutMs: 1000 } : {}),
          recovery: options?.originalRecovery ?? { serviceRestartSafe: true, version: "1.0.0" },
          recoveryModulePath,
          ...(selectedDriverPath
            ? {}
            : { commandArgv: [resolveTestNodeExecPath(), "-e", updaterScript] }),
        }),
      );
      if (options?.recoverySentinel) {
        await writeRestartSentinel(
          {
            kind: "update",
            status: "error",
            ts: Date.now(),
            stats: { reason: "build failed", handoffId: `${kind}-boundary`, steps: [] },
          },
          env,
        );
      }
      if (options?.recordedFailure) {
        await writeTriageUpdateFailure(options.recordedFailure, {
          env,
          outputPath: String(generated.triageContextPath),
        });
      }
      const spawnFixture = await prepareManagedServiceSpawn(root, scriptPath, childEnv, options);
      let helperEnv = spawnFixture.env;
      const triageDeadlinePath = path.join(root, "triage-deadline.json");
      if (options?.triageHang) {
        helperEnv = await prepareManagedServiceTriageClockPreload(
          { root, scriptPath, statePath },
          commandFixture.triageCommandArgv,
          String(generated.triageInputPath),
          helperEnv,
        );
      }
      if (options?.launchdTeardown?.clockEachCommandMs || options?.recoveryClockAdvanceMs) {
        const preloadPath = path.join(root, "launchd-clock-preload.cjs");
        await fs.writeFile(
          preloadPath,
          createManagedServiceLaunchdClockPreload({
            commandTimingsPath,
            clockEachCommandMs: options.launchdTeardown?.clockEachCommandMs ?? 0,
            recoveryClockAdvanceMs: options.recoveryClockAdvanceMs,
            recoveryCommandArgv: commandFixture.recoveryCommandArgv,
          }),
        );
        helperEnv = { ...childEnv, NODE_OPTIONS: `--require ${preloadPath}` };
      }
      if (options?.runnerFallback) {
        const preloadPath = path.join(root, "spawn-fallback-preload.cjs");
        await fs.writeFile(preloadPath, "process.execve = undefined;\n");
        helperEnv = { ...helperEnv, NODE_OPTIONS: `--require ${preloadPath}` };
      }
      if (options?.validationClockAdvanceMs) {
        const preloadPath = path.join(root, "validation-clock-preload.cjs");
        await fs.writeFile(
          preloadPath,
          `const fs = require("node:fs"); const now = Date.now;
          Date.now = () => now() + (fs.existsSync(${JSON.stringify(validationStartedPath)}) ? ${options.validationClockAdvanceMs} : 0);`,
        );
        helperEnv = {
          ...helperEnv,
          NODE_OPTIONS: `${helperEnv.NODE_OPTIONS ?? ""} --require ${preloadPath}`.trim(),
        };
      }
      if (options?.cancelAtActivation) {
        const preloadPath = path.join(root, "cancel-activation-preload.cjs");
        await fs.writeFile(
          preloadPath,
          createManagedServiceCancellationPreload({
            scriptPath,
            updaterPidPath,
            activationGatePath,
            activationReleasePath,
            mutationPath,
            gateInspection: options.cancelAtActivation === "inspection",
          }),
        );
        helperEnv = { ...helperEnv, NODE_OPTIONS: `--require ${preloadPath}` };
      }
      helperEnv = await prepareManagedServiceParentPreloads({
        root,
        scriptPath,
        statePath,
        parentPid,
        parentStartIdentity,
        logPath: String(generated.logPath),
        parentExitTimeoutMs: Number(generated.parentExitTimeoutMs),
        stopSettlementPath,
        env: helperEnv,
        options,
      });
      const runningHelper = spawn(resolveTestNodeExecPath(), [scriptPath, paramsPath], {
        env: helperEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      helper = runningHelper;
      let stdout = "";
      runningHelper.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      let stderr = "";
      runningHelper.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      let helperCompleted = false;
      const completion = new Promise<number | null>((resolve, reject) => {
        runningHelper.once("error", reject);
        runningHelper.once("close", (code) => {
          helperCompleted = true;
          resolve(code);
        });
      });
      helperCompletion = completion;
      await waitForHandoffResponse(runningHelper.stdout, "OPENCLAW_UPDATE_HANDOFF_READY");

      const databasePath = String(generated.updateLeaseDatabasePath);
      const owner = String(generated.updateLeaseOwner);
      const readLease = () => readManagedServiceHandoffLease(databasePath, root, owner);
      expect(readLease()).toEqual({
        version: 2,
        executor: { pid: runningHelper.pid, startIdentity: expect.any(String) },
        helper: { pid: runningHelper.pid, startIdentity: expect.any(String) },
        action: { kind: "update" },
      });
      await expect(pathExists(commandsPath)).resolves.toBe(false);
      if (options?.controlDisconnect) {
        await options.beforeDisconnect?.(run, env);
        if (options.controlDisconnect === "transferred") {
          const transferred = waitForHandoffResponse(runningHelper.stdout, "transferred");
          runningHelper.stdin?.write("transfer\n");
          await transferred;
          await expect(pathExists(commandsPath)).resolves.toBe(false);
        }
        if (options.controlDisconnect === "dead-parent") {
          parent.stdin?.end();
          await vi.waitFor(() => expect(parent.exitCode).toBe(0));
        }
        if (
          !options.cancelDuringValidation &&
          !options.cancelAtActivation &&
          !options.beforeParkNotice
        ) {
          runningHelper.stdin?.end();
        }
        if (options.controlDisconnect === "transferred") {
          // Configured plugin cold loading shares the suite saturation budget. Only
          // the updater's validation signal permits revocation or activation below.
          await Promise.race([
            waitForFile(validationStartedPath, DEFAULT_VITEST_TEST_TIMEOUT_MS),
            completion.then(() => {
              throw new Error("Managed helper exited before starting validation");
            }),
          ]);
          await expect(pathExists(commandsPath)).resolves.toBe(false);
          const validationClockAdvanceMs = options.validationClockAdvanceMs;
          if (validationClockAdvanceMs) {
            await vi.waitFor(async () => {
              expect(
                Number(await fs.readFile(validationStartedPath, "utf8")),
              ).toBeGreaterThanOrEqual(validationClockAdvanceMs);
            });
          }
          // A real updater child is now validating, but the service has received no stop.
          expect(parent).toMatchObject({ exitCode: null, signalCode: null });
          await expect(pathExists(commandsPath)).resolves.toBe(false);
          if (options.cancelDuringValidation) {
            const cancelled = waitForHandoffResponse(
              runningHelper.stdout,
              options.systemScope ? "cancel-unavailable" : "cancelled",
            );
            runningHelper.stdin?.write("cancel\n");
            await cancelled;
            if (options.systemScope) {
              await fs.writeFile(validationReleasePath, "settle updater");
            }
          } else {
            if (options.revokeWhileValidating) {
              await fs.writeFile(
                env.OPENCLAW_CONFIG_PATH,
                JSON.stringify({ commands: { ownerAllowFrom: [] } }),
              );
            }
            const notice = options.beforeParkNotice
              ? waitForHandoffResponse(runningHelper.stdout, "before-park")
              : undefined;
            await fs.writeFile(validationReleasePath, "activate");
            if (selectedDriverPath) {
              await waitForFile(statePath + ".park-prefix", 5_000);
              await expect(pathExists(commandsPath)).resolves.toBe(false);
              expect(parent.exitCode).toBeNull();
              expect(parent.signalCode).toBeNull();
              await fs.writeFile(statePath + ".park-tail", "complete request");
            }
            if (notice) {
              await notice;
              const inspections = (await fs.readFile(commandsPath, "utf8").catch(() => ""))
                .trim()
                .split("\n")
                .filter(Boolean);
              expect(
                inspections.every(isManagedServiceInspectionCommand),
                inspections.join("\n"),
              ).toBe(true);
              expect(parent.exitCode).toBeNull();
              if (options.beforeParkNotice === "disconnected") {
                runningHelper.stdin?.end();
              } else if (options.beforeParkNotice !== "stalled") {
                runningHelper.stdin?.write(
                  options.beforeParkNotice === "rejected" ? "notice-failed\n" : "noticed\n",
                );
              } else {
                await spawnFixture.releaseNoticeDeadline(parent.signalCode);
              }
            }
            if (options.cancelAtActivation) {
              await vi.waitFor(
                async () => {
                  await expect(pathExists(activationGatePath)).resolves.toBe(true);
                },
                { timeout: 5_000 },
              );
              const cancelled = waitForHandoffResponse(runningHelper.stdout, "cancelled");
              runningHelper.stdin?.write("cancel\n");
              await cancelled;
              await fs.writeFile(activationReleasePath, "continue");
              await vi.waitFor(
                async () => {
                  expect(helperCompleted || (await pathExists(mutationPath))).toBe(true);
                },
                { timeout: 5_000 },
              );
              await expect(pathExists(mutationPath)).resolves.toBe(false);
              expect(parent).toMatchObject({ exitCode: null, signalCode: null });
            }
          }
        }
        const activated =
          options.controlDisconnect === "transferred" &&
          !options.validationResult &&
          !options.cancelDuringValidation &&
          !options.cancelAtActivation &&
          !options.revokeWhileValidating &&
          (!options.profileRequester || options.beforeParkNotice === "acknowledged");
        if (activated) {
          await vi.waitFor(
            async () => {
              expect(JSON.parse(await fs.readFile(statePath, "utf8"))).toMatchObject({
                parked: true,
              });
            },
            // The spawn fallback imports the actual activation API before requesting the stop.
            { timeout: 30_000 },
          );
          if (options.expireParentWhileStopPending) {
            await vi.waitFor(() => expect(parent.signalCode).toBe("SIGKILL"), { timeout: 5_000 });
            await parentClosed;
          } else {
            parent.stdin?.end();
          }
        }
        const code =
          options.profileRequester && !activated
            ? await observeManagedServiceProfileRefusal(completion, commandsPath)
            : await completion;
        const helperLog = await fs.readFile(String(generated.logPath), "utf8").catch(() => "");
        expect(code, `${stderr}\n${helperLog}`).toBe(options.helperExitCode ?? 0);
        await expect(pathExists(updaterPath)).resolves.toBe(
          activated && !options.expireParentWhileStopPending,
        );
      } else if (options?.parentExitTimeoutMs !== undefined) {
        const timeout = options.parentExitTimeoutMs + (options.launchdTeardown ? 8_000 : 3_000);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          expect(
            await Promise.race([
              completion,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error("managed helper did not restore the stalled parent")),
                  timeout,
                );
              }),
            ]),
            stderr,
          ).toBe(0);
        } finally {
          clearTimeout(timer);
        }
        expect(parent).toMatchObject({ exitCode: null, signalCode: null });
        await expect(pathExists(commandsPath)).resolves.toBe(false);
        expect(stdout).not.toContain("committed\n");
        await expect(pathExists(updaterPath)).resolves.toBe(false);
      } else if (options?.launchdFault === "wrong-parent" || options?.overdueCommit) {
        const cancelled = waitForHandoffResponse(runningHelper.stdout, "cancelled");
        runningHelper.stdin?.write("park\n");
        await cancelled;
        expect(await completion, stderr).toBe(0);
        expect(parent).toMatchObject({ exitCode: null, signalCode: null });
        await expect(pathExists(updaterPath)).resolves.toBe(false);
      } else {
        const parked = waitForHandoffResponse(runningHelper.stdout, "parked");
        runningHelper.stdin?.write("park\n");
        await parked;
        expect(parent.exitCode).toBeNull();
        await expect(pathExists(updaterPath)).resolves.toBe(false);
        if (options?.cancelAfterPark) {
          const restoring = waitForHandoffResponse(runningHelper.stdout, "restore-after-exit");
          runningHelper.stdin?.write("cancel\n");
          await restoring;
          expect(stdout).not.toContain("committed\n");
          parent.stdin?.end();
          expect(await completion, stderr).toBe(0);
          await expect(pathExists(updaterPath)).resolves.toBe(false);
        } else {
          const committed = waitForHandoffResponse(runningHelper.stdout, "committed");
          runningHelper.stdin?.write("commit\n");
          await committed;
          parent.stdin?.end();
          const code = await completion;
          const helperLog = await fs.readFile(String(generated.logPath), "utf8").catch(() => "");
          expect
            .soft(code, `${stderr}\n${helperLog}`)
            .toBe(
              options?.helperExitCode ??
                (options?.systemdHandoffFailure ? 1 : (options?.updaterExitCode ?? 7)),
            );
          await expect(pathExists(updaterPath)).resolves.toBe(
            !options?.systemdHandoffFailure && !options?.revokeOwner,
          );
        }
      }
      expect(readLease()).toBeNull();
      if (options?.diagnosticReadFailure) {
        const db = new DatabaseSync(stateDatabasePath);
        db.exec(
          "ALTER TABLE gateway_restart_sentinel RENAME COLUMN unreadable_thread_id TO thread_id",
        );
        db.close();
      }
      return {
        ...(run ? { run: getUpdateRun(run.runId, { env }) } : {}),
        ...(options?.expireParentWhileStopPending
          ? { stopSettlement: JSON.parse(await fs.readFile(stopSettlementPath, "utf8")) }
          : {}),
        commands: (await fs.readFile(commandsPath, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean),
        parentSignal: parent.signalCode,
        parkAdmitted: stdout.includes("park-admitted\n"),
        state: JSON.parse(await fs.readFile(statePath, "utf8").catch(() => "{}")),
        sentinel: readRestartSentinelPayload({ OPENCLAW_STATE_DIR: root }),
        log: await fs.readFile(String(generated.logPath), "utf8"),
        ...(options?.triageHang
          ? { triageDeadline: JSON.parse(await fs.readFile(triageDeadlinePath, "utf8")) }
          : {}),
        savedFailure: await readSavedFailure(String(generated.triageContextPath)),
        sensitiveFilesRemoved: (
          await Promise.all((generated.sensitivePaths as string[]).map(pathExists))
        ).every((exists) => !exists),
        commandTimings: (await fs.readFile(commandTimingsPath, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as ManagedServiceCommandTiming),
      };
    } catch (error) {
      const helperLog = helperLogPath
        ? await fs.readFile(helperLogPath, "utf8").catch(() => "")
        : "";
      throw new Error(`${String(error)}\n${helperLog.slice(-8192)}`, { cause: error });
    } finally {
      parent.stdin?.end();
      if (options?.cancelAtActivation) {
        await fs.writeFile(activationReleasePath, "continue");
        const updaterPid = Number(await fs.readFile(updaterPidPath, "utf8").catch(() => ""));
        if (updaterPid > 0) {
          try {
            process.kill(-updaterPid, "SIGKILL");
          } catch {}
        }
        // Reap native commands before helper cleanup so fixtures cannot outlive their directory.
        await parentClosed;
        await helperCompletion;
      }
      await cleanup();
      if (options?.recoveryChecksServiceIdentity) {
        await awaitEmulatedRecoveryHandoffExit(statePath);
      }
    }
  };
}
