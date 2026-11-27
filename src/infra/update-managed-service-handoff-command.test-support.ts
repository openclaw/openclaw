import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { vi } from "vitest";
import { isPidAlive } from "../shared/pid-alive.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { readManagedHandoffArtifacts } from "./update-managed-service-handoff-artifacts.test-support.js";
import type {
  ManagedServiceManagerBoundaryResult,
  ManagedServiceManagerBoundaryOptions,
} from "./update-managed-service-handoff-lifecycle.test-support.js";
import { managedServiceStateUpdateScript } from "./update-managed-service-handoff-state.test-support.js";
import { signalMockManagedUpdateHandoffReady } from "./update-managed-service-handoff.test-support.js";

const testNodeExecPath = resolveTestNodeExecPath();
const recoveryReadyMarker = "OPENCLAW_TEST_RECOVERY_DESCENDANT_READY";
const failed = "managed-service-handoff-failed";
const cancelled = "managed-service-handoff-cancelled";
const restoreFailed = "managed-service-handoff-restore-failed";
const restartArgs = ["gateway", "restart", "--preserve-definition", "--json"];

export function createManagedServiceChildMock(params?: { pid?: number }) {
  return Object.assign(new EventEmitter(), {
    pid: params?.pid ?? process.pid,
    exitCode: null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    unref: vi.fn(),
  });
}

export function createReadyManagedServiceChild(
  args: string[],
  cleanups: Set<() => void>,
  readyDelayMs = 0,
) {
  const child = createManagedServiceChildMock();
  process.nextTick(() => {
    const ready = () =>
      signalMockManagedUpdateHandoffReady({
        child,
        paramsPath: readManagedHandoffArtifacts(args).paramsPath,
        cleanups,
      });
    if (readyDelayMs > 0) {
      setTimeout(ready, readyDelayMs);
    } else {
      ready();
    }
  });
  return child;
}

type ManagerBoundary = (
  kind: "systemd" | "launchd",
  options?: ManagedServiceManagerBoundaryOptions,
) => Promise<ManagedServiceManagerBoundaryResult>;

function failedUpdate(reason = failed) {
  return {
    status: "error",
    mode: "npm",
    reason,
    recovery: { serviceRestartSafe: true, version: "1.0.0" },
  };
}

function restoreOutcome(
  expect: typeof import("vitest").expect,
  status: string,
  reason: string,
  exitCode: number,
  exact = false,
) {
  const log = { exitCode, ...(exact ? { stderrTail: restoreFailed } : {}) };
  const restoreSteps = [expect.objectContaining({ name: "service-restore", log })];
  const steps = exact ? restoreSteps : expect.arrayContaining(restoreSteps);
  return { payload: { status, stats: { reason, steps } } };
}

/** A LaunchAgent gateway's own environment; the handoff keeps only the label for its children. */
export const LAUNCHD_GATEWAY_IDENTITY_ENV = {
  OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway",
  XPC_SERVICE_NAME: "ai.openclaw.gateway",
  OPENCLAW_SERVICE_MARKER: "openclaw",
  OPENCLAW_SERVICE_KIND: "gateway",
} as const;

/** The pre-fix CLI emulation restarts launchd after it exits; never leave that shell behind. */
export async function awaitEmulatedRecoveryHandoffExit(statePath: string): Promise<void> {
  const state = JSON.parse(await fs.readFile(statePath, "utf8").catch(() => "{}")) as {
    recoveryHandoffPid?: number;
  };
  const pid = state.recoveryHandoffPid;
  if (typeof pid !== "number") {
    return;
  }
  const deadline = Date.now() + 6_000;
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) {
      throw new Error(`emulated recovery handoff ${pid} is still running`);
    }
    await sleep(50);
  }
}

export function createManagedServiceCommandFixture(params: {
  kind: "systemd" | "launchd";
  root: string;
  statePath: string;
  stateDatabasePath: string;
  options?: ManagedServiceManagerBoundaryOptions;
}) {
  const { kind, root, statePath, options } = params;
  const update = (source: string) => managedServiceStateUpdateScript(statePath, source);
  const checksServiceIdentity = kind === "launchd" && options?.recoveryChecksServiceIdentity;
  const recovery =
    kind === "systemd"
      ? { kind, unit: "openclaw-gateway.service" }
      : {
          kind,
          uid: 501,
          label: "ai.openclaw.gateway",
          plistPath: path.join(root, "ai.openclaw.gateway.plist"),
        };
  return {
    serviceRecovery: recovery,
    recoveryCommandArgv: [
      testNodeExecPath,
      ...(checksServiceIdentity ? ["--input-type=module"] : []),
      "-e",
      [
        ...(checksServiceIdentity
          ? [
              `import { createRequire } from "node:module";`,
              `const require = createRequire(import.meta.url);`,
            ]
          : []),
        `void (async () => {`,
        ...(checksServiceIdentity
          ? [
              `const { register } = await import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm/api")).href)});`,
              // The recovery command runs from the helper's temp dir; name the repo tsconfig for path aliases.
              `register({ tsconfig: ${JSON.stringify(fileURLToPath(new URL("../../tsconfig.json", import.meta.url)))} });`,
              `const { isCurrentProcessInsideLaunchdService } = await import(${JSON.stringify(new URL("../daemon/launchd-current-service.ts", import.meta.url).href)});`,
            ]
          : []),
        `const fs = require("node:fs");`,
        `const { spawnSync } = require("node:child_process");`,
        `${update("state.guardedRestart = process.argv.slice(1)")};`,
        ...(checksServiceIdentity
          ? [
              `const recoveryInsideService = await isCurrentProcessInsideLaunchdService("ai.openclaw.gateway");`,
              `${update(
                `state.recoveryInsideService = recoveryInsideService;
                state.recoveryEnv = Object.fromEntries(["LAUNCH_JOB_LABEL", "LAUNCH_JOB_NAME", "XPC_SERVICE_NAME", "OPENCLAW_SERVICE_MARKER", "OPENCLAW_SERVICE_KIND", "OPENCLAW_LAUNCHD_LABEL"].map((key) => [key, process.env[key]]))`,
              )};`,
              // Reproduce the old CLI's early success while its detached restart waits for exit.
              `if (recoveryInsideService) {`,
              `  const { spawn } = require("node:child_process");`,
              `  const child = spawn("/bin/sh", ["-c", ${JSON.stringify('attempts=0; while kill -0 "$1" 2>/dev/null && [ "$attempts" -lt 100 ]; do attempts=$((attempts + 1)); sleep 0.05; done; launchctl enable gui/501/ai.openclaw.gateway; launchctl bootstrap gui/501 "$2"')}, "openclaw-test-recovery", String(process.pid), ${JSON.stringify(path.join(root, "ai.openclaw.gateway.plist"))}], { detached: true, stdio: "ignore" });`,
              `  ${update("state.recoveryHandoffPid = child.pid")};`,
              `  child.unref();`,
              `  console.log(JSON.stringify({ action: "restart", ok: true, result: "scheduled" }));`,
              `  process.exit(0);`,
              `}`,
            ]
          : []),
        `${update("state.recoveryAllowance = process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS")};`,
        ...(options?.recoverySentinel
          ? [
              `const { DatabaseSync } = require("node:sqlite");`,
              `const db = new DatabaseSync(${JSON.stringify(params.stateDatabasePath)});`,
              `const row = db.prepare("SELECT payload_json FROM gateway_restart_sentinel WHERE sentinel_key = 'current'").get();`,
              `const state = ${update("state.sentinelAtRecovery = JSON.parse(row.payload_json)")};`,
              ...(options.recoverySentinel === "consumed"
                ? [
                    `db.prepare("DELETE FROM gateway_restart_sentinel WHERE sentinel_key = 'current'").run();`,
                  ]
                : options.recoverySentinel === "replaced"
                  ? [
                      `const replacement = { ...state.sentinelAtRecovery, stats: { ...state.sentinelAtRecovery.stats, reason: "newer update failure" } };`,
                      `db.prepare("UPDATE gateway_restart_sentinel SET payload_json = ?, stats_json = ?, updated_at_ms = updated_at_ms + 1 WHERE sentinel_key = 'current'").run(JSON.stringify(replacement), JSON.stringify(replacement.stats));`,
                    ]
                  : []),
              `db.close();`,
            ]
          : []),
        ...(options?.recoveryHang
          ? [
              `const { spawn } = require("node:child_process");`,
              `const recoveryDescendantPid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }).pid;`,
              `${update("state.recoveryDescendantPid = recoveryDescendantPid")};`,
              `console.log(${JSON.stringify(recoveryReadyMarker)});`,
              `setInterval(() => {}, 1000);`,
            ]
          : options?.recoveryExitCode === undefined || options.recoveryExitCode === 0
            ? (kind === "systemd"
                ? [
                    ["--user", "reset-failed", recovery.unit],
                    ["--user", "start", recovery.unit],
                    ["--user", "show", recovery.unit],
                  ]
                : [
                    ["enable", `gui/501/ai.openclaw.gateway`],
                    ["bootstrap", "gui/501", path.join(root, "ai.openclaw.gateway.plist")],
                    ["print", "gui/501/ai.openclaw.gateway"],
                  ]
              ).map(
                (args) =>
                  `if (spawnSync(${JSON.stringify(kind === "systemd" ? "systemctl" : "launchctl")}, ${JSON.stringify(args)}).status !== 0) process.exit(1);`,
              )
            : [`process.exit(${options.recoveryExitCode});`]),
        ...(checksServiceIdentity
          ? [`console.log(JSON.stringify({ action: "restart", ok: true, result: "restarted" }));`]
          : []),
        `})().catch((error) => { console.error(error); process.exitCode = 1; });`,
      ].join(""),
      "--",
      "gateway",
      "restart",
      "--preserve-definition",
      "--json",
    ],
    triageCommandArgv: options?.triageMissing
      ? [path.join(root, "missing-triage")]
      : [
          testNodeExecPath,
          "-e",
          [
            `void (async () => {`,
            `const fs = require("node:fs");`,
            `const args = process.argv.slice(1);`,
            `const contextPath = args[args.indexOf("--update-result") + 1];`,
            `${update(
              `
              state.triageCalls = (state.triageCalls || 0) + 1;
              state.triageArgs = args;
              state.triageInput = JSON.parse(fs.readFileSync(contextPath, "utf8"));
              state.triageInputMode = fs.statSync(contextPath).mode & 0o777;
              state.triageObservedRestored = state.restored === true;
              state.triageObservedRecovery = Array.isArray(state.guardedRestart);
              state.triageRecoveryAllowance = process.env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS;
            `,
            )};`,
            ...(options?.triageHang
              ? [
                  `const { spawn } = require("node:child_process");`,
                  `const triageDescendantPid = spawn(process.execPath, ["-e", ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(path.join(root, "triage-descendant-ready"))}, String(process.pid)); setInterval(() => {}, 1000);`)}], { stdio: "ignore" }).pid;`,
                  `${update("state.triageDescendantPid = triageDescendantPid")};`,
                  `setInterval(() => {}, 1000);`,
                ]
              : [
                  `console.log(JSON.stringify({ promptPath: "triage-prompt.md", bundlePath: "support.zip" }));`,
                  `process.exit(${options?.triageExitCode ?? 0});`,
                ]),
            `})().catch((error) => { console.error(error); process.exitCode = 1; });`,
          ].join(""),
          "--",
          "triage",
          "--json",
          "--non-interactive",
        ],
  };
}

export async function prepareManagedServiceRecoveryClockPreload(
  params: { root: string; scriptPath: string; statePath: string; timeoutMs: number },
  commandArgv: string[],
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const configPath = path.join(params.root, "recovery-clock.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      scriptPath: params.scriptPath,
      statePath: params.statePath,
      timeoutMs: params.timeoutMs,
      commandArgv,
      readyMarker: recoveryReadyMarker,
      deadlinePath: path.join(params.root, "recovery-deadline.json"),
    }),
  );
  const preloadUrl = new URL(
    "../../test/fixtures/managed-service-recovery-clock.mjs",
    import.meta.url,
  );
  preloadUrl.searchParams.set("config", configPath);
  return { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --import=${preloadUrl.href}`.trim() };
}

export async function waitForHandoffResponse(
  output: Readable | null,
  expected: string,
): Promise<void> {
  if (!output) {
    throw new Error("expected managed handoff helper stdout");
  }
  await new Promise<void>((resolve, reject) => {
    let buffered = "";
    const onData = (chunk: Buffer | string) => {
      buffered = `${buffered}${chunk.toString()}`.slice(-1024);
      if (buffered.includes(`${expected}\n`)) {
        output.removeListener("data", onData);
        output.removeListener("end", onEnd);
        resolve();
      }
    };
    const onEnd = () => reject(new Error(`managed handoff helper exited before ${expected}`));
    output.on("data", onData);
    output.once("end", onEnd);
  });
}

export function registerManagedRecoveryCommandTests(
  runBoundary: ManagerBoundary,
  itUnix: ReturnType<typeof import("vitest").it.runIf>,
  expect: typeof import("vitest").expect,
): void {
  itUnix("verifies launchd after a slow guarded restart", async () => {
    const recoveryTimeoutMs = 120_000;
    const { state, sentinel, commandTimings } = await runBoundary("launchd", {
      recoveryTimeoutMs,
      recoveryClockAdvanceMs: 31_000,
      updaterExitCode: 0,
      helperExitCode: 1,
      updaterNotification: "published",
      updaterResult: {
        status: "skipped",
        mode: "git",
        reason: "no-upstream",
        recovery: { serviceRestartSafe: true, version: "1.0.0", buildId: "original-git-build" },
      },
    });
    expect(state.restored).toBe(true);
    expect(sentinel).toMatchObject({
      payload: {
        status: "skipped",
        stats: { steps: [{ name: "service-restore", log: { exitCode: 0 } }] },
      },
    });
    const inspections = commandTimings.filter(({ action }) => action === "print");
    expect(inspections.at(-1)!.startedAtMs - inspections.at(-2)!.startedAtMs).toBe(31_000);
    expect(inspections.at(-1)!.timeoutMs).toBe(recoveryTimeoutMs);
  });

  itUnix("restores launchd synchronously outside the configured service", async () => {
    const { state, sentinel, log } = await runBoundary("launchd", {
      recoveryChecksServiceIdentity: true,
      updaterNotification: "published",
      updaterResult: failedUpdate("global update (omit optional)"),
    });
    // The guarded CLI sees the service identity without launchd's own labels or markers.
    expect(state.recoveryEnv, log).toEqual({ OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.gateway" });
    expect(state.guardedRestart).toEqual(restartArgs);
    expect(state.recoveryInsideService, log).toBe(false);
    expect(state.restored).toBe(true);
    // The updater's published reason survives; only the restore step records recovery.
    expect(sentinel).toMatchObject(
      restoreOutcome(expect, "error", "global update (omit optional)", 0),
    );
  });

  itUnix.each([
    ["systemd", "refusal"],
    ["launchd", "refusal"],
    ["systemd", "timeout"],
  ] as const)("keeps %s parked after guarded recovery %s", async (kind, failure) => {
    const recoveryTimeoutMs = 60_000;
    const { commands, sentinel, state, log, recoveryDeadline } = await runBoundary(kind, {
      ...(failure === "timeout"
        ? { recoveryHang: true, recoveryTimeoutMs }
        : { recoveryExitCode: 1 }),
      updaterNotification: "published",
      updaterResult: failedUpdate(),
    });
    expect(state.restored).toBeUndefined();
    if (failure === "timeout") {
      expect(typeof state.recoveryDescendantPid).toBe("number");
      expect(recoveryDeadline).toEqual({
        requestedMs: recoveryTimeoutMs,
        descendantPid: state.recoveryDescendantPid,
      });
      expect(log).toContain("verified recovery command exceeded its update timeout");
      expect(log.indexOf("managed update recovery command exited")).toBeGreaterThan(
        log.indexOf("verified recovery command exceeded its update timeout"),
      );
      expect(log.indexOf("managed update helper completed")).toBeGreaterThan(
        log.indexOf("managed update recovery command exited"),
      );
      await expect.poll(() => isPidAlive(Number(state.recoveryDescendantPid))).toBe(false);
    } else {
      expect(
        commands.some((command) => /(?:^| )(?:start|enable|bootstrap|kickstart) /.test(command)),
      ).toBe(false);
    }
    expect(sentinel).toMatchObject(restoreOutcome(expect, "error", failed, 1, true));
  });
}

export function registerManagedLaunchdTeardownTests(
  runBoundary: ManagerBoundary,
  itUnix: ReturnType<typeof import("vitest").it.runIf>,
  expect: typeof import("vitest").expect,
): void {
  itUnix.each([
    ["slow bootout completes before updater", { bootoutDelayMs: 5_250 }, true],
    ["cancel restores after bootstrap EIO", { pendingBootstrapFailures: 2 }, false],
    ["cancel retries operation-in-progress bootstrap", { pendingOperationInProgress: 1 }, false],
  ] as const)(
    "%s",
    async (_label, teardown, updaterRan) => {
      const { parentSignal, sentinel, state } = await runBoundary("launchd", {
        launchdTeardown: { loadedPrints: 2, ...teardown },
        ...(updaterRan
          ? {
              updaterNotification: "published" as const,
              updaterResult: {
                status: "error",
                mode: "npm",
                recovery: { serviceRestartSafe: true, version: "1.0.0" },
              },
            }
          : { cancelAfterPark: true }),
      });
      expect(state).toMatchObject({
        disabled: false,
        parked: true,
        unloaded: true,
        restored: true,
        ...(updaterRan ? { bootoutCompleted: true, updaterObservedUnloaded: true } : {}),
      });
      expect(parentSignal).toBe(null);
      expect(sentinel).toMatchObject(
        restoreOutcome(
          expect,
          updaterRan ? "error" : "skipped",
          updaterRan ? failed : cancelled,
          0,
        ),
      );
    },
    20_000,
  );

  itUnix.each([
    { recoveryTimeoutMs: 30_000, commandWorkMs: 5_000, restored: false },
    { recoveryTimeoutMs: 120_000, commandWorkMs: 6_000, restored: true },
  ])(
    "honors a $recoveryTimeoutMs ms launchd restoration budget with $commandWorkMs ms commands",
    async ({ recoveryTimeoutMs, commandWorkMs, restored }) => {
      const { commandTimings, sentinel, state } = await runBoundary("launchd", {
        cancelAfterPark: true,
        recoveryTimeoutMs,
        launchdTeardown: { clockEachCommandMs: commandWorkMs, loadedPrints: 4 },
      });
      const restoreIndex = commandTimings.findIndex(({ action }) => action === "bootout") + 1;
      expect(restoreIndex).toBeGreaterThan(0);
      const restoration = commandTimings.slice(restoreIndex);
      const restoreStartedAtMs = restoration[0]?.startedAtMs ?? 0;

      const actions = restoration.map(({ action }) => action);
      // Parent exit and bootout completion can add read-only observations before
      // the fixture consumes its loaded states; mutations and deadlines stay exact.
      expect(actions.slice(0, 2)).toEqual(["print", "enable"]);
      expect(actions.filter((action) => action !== "print")).toEqual([
        "enable",
        ...(restored ? ["bootstrap"] : []),
      ]);
      expect(actions.at(-1)).toBe("print");
      for (const { startedAtMs, timeoutMs } of restoration) {
        const elapsedMs = startedAtMs - restoreStartedAtMs;
        expect(elapsedMs).toBeLessThan(recoveryTimeoutMs);
        expect(elapsedMs + timeoutMs).toBeLessThanOrEqual(recoveryTimeoutMs);
      }
      expect(state).toMatchObject({ disabled: false, parked: true });
      if (restored) {
        expect(actions.at(-2)).toBe("bootstrap");
        expect(state).toMatchObject({
          restored: true,
          unloaded: true,
        });
        expect(restoration.at(-1)!.startedAtMs - restoreStartedAtMs).toBeGreaterThan(30_000);
      } else {
        expect(restoration.at(-1)?.timeoutMs).toBeLessThan(commandWorkMs);
        expect(state.restored).toBeUndefined();
      }
      expect(sentinel).toMatchObject(
        restoreOutcome(
          expect,
          restored ? "skipped" : "error",
          restored ? cancelled : restoreFailed,
          restored ? 0 : 1,
        ),
      );
    },
    15_000,
  );

  itUnix.each(["wrong-parent", "nested-parent", "foreign-job", "duplicate-pid"] as const)(
    "rejects launchd %s identity without native mutation",
    async (launchdFault) => {
      const { commands, sentinel, state } = await runBoundary("launchd", {
        launchdFault,
      });

      expect(commands).toEqual(["print gui/501/ai.openclaw.gateway"]);
      expect(state).toEqual({});
      expect(sentinel).toMatchObject({
        payload: {
          status: "skipped",
          stats: { reason: cancelled },
        },
      });
    },
  );

  itUnix.each([
    ["a missing PID", "missing-restored-pid"],
    ["a dead PID", "dead-restored-pid"],
  ] as const)("rejects launchd restoration reporting running with %s", async (_label, fault) => {
    const { sentinel, state } = await runBoundary("launchd", {
      launchdFault: fault,
      cancelAfterPark: true,
    });

    expect(state).toMatchObject({ disabled: false, parked: true, restored: true });
    expect(sentinel).toMatchObject(restoreOutcome(expect, "error", restoreFailed, 1));
  });

  itUnix.each([true, false])(
    "preserves large launchd inspection framing (cancel=%s)",
    async (cancel) => {
      const { sentinel, state } = await runBoundary("launchd", {
        launchdOutputPadding: 9_000,
        ...(cancel
          ? { cancelAfterPark: true }
          : { updaterNotification: "published", updaterResult: failedUpdate() }),
      });
      expect(state).toMatchObject({ parked: true, restored: true, healthProbed: true });
      expect(sentinel).toMatchObject(
        restoreOutcome(expect, cancel ? "skipped" : "error", cancel ? cancelled : failed, 0),
      );
    },
  );

  itUnix.each([
    ["nested-restored-pid", true],
    ["nested-restored-pid", false],
    ["foreign-restored-job", true],
    ["foreign-restored-job", false],
    ["duplicate-restored-pid", true],
    ["duplicate-restored-pid", false],
  ] as const)("refuses launchd %s after restoration (cancel=%s)", async (launchdFault, cancel) => {
    const { sentinel, state, commands } = await runBoundary("launchd", {
      launchdFault,
      ...(cancel
        ? { cancelAfterPark: true }
        : { updaterNotification: "published", updaterResult: failedUpdate() }),
    });
    expect(state).toMatchObject({ parked: true, restored: true });
    expect(state.healthProbed).toBeUndefined();
    expect(commands.filter((command) => command.startsWith("bootstrap "))).toHaveLength(1);
    expect(
      commands.filter((command) => command.startsWith("kickstart ")).length,
    ).toBeLessThanOrEqual(1);
    expect(sentinel).toMatchObject(
      restoreOutcome(expect, "error", cancel ? restoreFailed : failed, 1, !cancel),
    );
  });
}
