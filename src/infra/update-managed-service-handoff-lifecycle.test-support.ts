import fs from "node:fs/promises";
import path from "node:path";
import type { TriageUpdateFailure } from "../commands/triage-update.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import { buildRestartSentinelRow } from "./restart-sentinel-store.js";
import { managedServiceStateUpdateScript } from "./update-managed-service-handoff-state.test-support.js";
import type { UpdateRequester } from "./update-requester-authority.js";
import { buildUpdateRestartSentinelPayload } from "./update-restart-sentinel-payload.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import type { UpdateRunResult } from "./update-runner-types.js";

const testNodeExecPath = resolveTestNodeExecPath();

export function isManagedServiceInspectionCommand(command: string): boolean {
  return /^(?:--user )?(?:show|print) /.test(command);
}

type ManagedSystemdPostExitState = {
  activeState: string;
  generation?: "cleared" | "parked" | "replacement";
  id?: string;
  invocation?: "cleared" | "parked" | "replacement";
  loadState?: string;
  mainPid?: "parent" | "replacement" | "none";
};

export type ManagedServiceManagerBoundaryOptions = {
  ledger?: boolean;
  rollbackRestoration?: boolean;
  cancelAfterPark?: boolean;
  parentExitTimeoutMs?: number;
  launchdOutputPadding?: number;
  launchdFault?:
    | "wrong-parent"
    | "nested-parent"
    | "foreign-job"
    | "duplicate-pid"
    | "missing-restored-pid"
    | "nested-restored-pid"
    | "foreign-restored-job"
    | "duplicate-restored-pid"
    | "dead-restored-pid";
  launchdTeardown?: {
    bootoutDelayMs?: number;
    clockEachCommandMs?: number;
    loadedPrints?: number;
    pendingBootstrapFailures?: number;
    pendingOperationInProgress?: number;
  };
  overdueCommit?: boolean;
  systemdFault?: "start-failed" | "dead-restored-pid";
  systemdHandoffDeadlineMs?: number;
  systemdHandoffFailure?: boolean;
  systemdPostExitStates?: ManagedSystemdPostExitState[];
  systemdStopDelayMs?: number;
  expireParentWhileStopPending?: boolean;
  originalRecovery?: UpdateRunResult["recovery"];
  revokeOwner?: boolean;
  disableChannelOnRevoke?: true;
  requester?: UpdateRequester;
  updaterExitCode?: number;
  recoveryExitCode?: number;
  recoveryTimeoutMs?: number;
  recoveryChecksServiceIdentity?: true;
  recoveryHang?: boolean;
  recoveryClockAdvanceMs?: number;
  recoverySentinel?: "retained" | "consumed" | "replaced";
  triageExitCode?: number;
  triageHang?: boolean;
  triageMissing?: boolean;
  recordedFailure?: TriageUpdateFailure;
  helperExitCode?: number;
  updaterResult?: unknown;
  updaterOutput?: "malformed" | "overflow" | "missing" | "split-utf8";
  updaterSignal?: boolean;
  updaterNotification?: "published" | "consumed" | "consumed-before-exit";
  gatewayHealth?: "ready" | "unready" | "wrong-version" | "wrong-build" | "exited" | "throw";
  diagnosticReadFailure?: "before-recovery" | "after-recovery";
};

export type ManagedServiceCommandTiming = {
  action: string;
  startedAtMs: number;
  timeoutMs: number;
};

export type ManagedServiceManagerBoundaryResult = {
  run?: UpdateRunRecord;
  commands: string[];
  parentSignal: NodeJS.Signals | null;
  state: Record<string, unknown>;
  sentinel: unknown;
  log: string;
  stdout: string;
  stderr: string;
  commandTimings: ManagedServiceCommandTiming[];
  recoveryDeadline?: { requestedMs: number; descendantPid?: number };
  triageDeadline?: { requestedMs: number; descendantPid: number };
  savedFailure: { path: string; mode: number; contents: TriageUpdateFailure } | null;
  sensitiveFilesRemoved: boolean;
  parkAdmitted?: boolean;
  stopSettlement?: {
    pid: number;
    closed: boolean;
    code: number | null;
    signal: string | null;
    parentKilledWhileStopPending: boolean;
    failedWhileStopPending: boolean;
  };
};

function expectHandoff(
  expect: typeof import("vitest").expect,
  sentinel: unknown,
  status: string,
  reason: string,
  restoreExit?: number,
) {
  const stats: Record<string, unknown> = { reason };
  if (restoreExit !== undefined) {
    stats.steps = expect.arrayContaining([
      expect.objectContaining({ name: "service-restore", log: { exitCode: restoreExit } }),
    ]);
  }
  expect(sentinel).toMatchObject({ payload: { status, stats } });
}

type SystemdBoundary = (
  kind: "systemd",
  options?: ManagedServiceManagerBoundaryOptions,
) => Promise<ManagedServiceManagerBoundaryResult>;

export function registerManagedSystemdHandoffConvergenceTests(
  runManagedServiceManagerBoundary: SystemdBoundary,
  itUnix: ReturnType<typeof import("vitest").it.runIf>,
  expect: typeof import("vitest").expect,
): void {
  const postExit = (
    activeState: string,
    overrides: Omit<ManagedSystemdPostExitState, "activeState"> = {},
  ): ManagedSystemdPostExitState => ({ activeState, mainPid: "none", ...overrides });
  // KillMode=mixed can leave the exact parked identity in ActiveState=failed.
  const parkedFailure = postExit("failed", { generation: "parked", invocation: "parked" });
  itUnix.each([
    ["deactivating stop job", [postExit("deactivating"), postExit("inactive")], 100],
    ["failed parked unit", [parkedFailure], 0],
  ] as const)("accepts the stopped systemd unit: %s", async (_label, observations, delay) => {
    const { sentinel, state } = await runManagedServiceManagerBoundary("systemd", {
      systemdPostExitStates: [...observations],
      systemdStopDelayMs: delay,
      updaterExitCode: 0,
      updaterResult: { status: "ok", mode: "npm" },
    });

    expect(state).toMatchObject({ parked: true, stopCompleted: true });
    if (delay) {
      expect([state.reset, state.restored]).toEqual([undefined, undefined]);
    }
    expect(sentinel).toBeNull();
  });

  itUnix("restores a failed unit that retained the parked generation", async () => {
    const { commands, sentinel, state } = await runManagedServiceManagerBoundary("systemd", {
      cancelAfterPark: true,
      systemdPostExitStates: [parkedFailure],
    });
    expect(commands.every((command) => command.startsWith("--user "))).toBe(true);
    expect(commands[1]).toContain("stop openclaw-gateway.service");
    expect(state).toMatchObject({ parked: true, restored: true });
    expect(state.guardedRestart).toBeUndefined();
    expectHandoff(expect, sentinel, "skipped", "managed-service-handoff-cancelled", 0);
  });

  itUnix.each([
    postExit("inactive", { generation: "replacement", invocation: "replacement" }),
    postExit("inactive", { generation: "cleared", invocation: "parked" }),
    postExit("inactive", { generation: "parked", invocation: "cleared" }),
    postExit("deactivating", { mainPid: "replacement" }),
    postExit("active", { mainPid: "replacement" }),
    postExit("activating"),
    postExit("failed", { generation: "replacement", invocation: "replacement" }),
    postExit("inactive", { mainPid: "parent" }),
    postExit("inactive", { id: "replacement.service" }),
    postExit("inactive", { loadState: "not-found" }),
  ])("fails closed after stop completion when systemd reports %j", async (invalidState) => {
    const { commands, sentinel, state } = await runManagedServiceManagerBoundary("systemd", {
      systemdHandoffFailure: true,
      systemdPostExitStates: [invalidState],
    });

    expect(state).toMatchObject({ parked: true, stopCompleted: true });
    expect(commands.filter((command) => command.includes("reset-failed"))).toHaveLength(0);
    expectHandoff(expect, sentinel, "error", "managed-service-handoff-restore-failed", 1);
  });

  itUnix("rejects an overdue commit before its delayed deadline callback executes", async () => {
    const { commands, parentSignal, sentinel, state } = await runManagedServiceManagerBoundary(
      "systemd",
      { overdueCommit: true },
    );

    expect(parentSignal).toBeNull();
    expect(
      commands.filter((command) => /(?:stop|start) openclaw-gateway\.service/.test(command)),
    ).toEqual([]);
    expect(state).toEqual({});
    expect(sentinel).toMatchObject({
      payload: {
        status: "skipped",
        stats: { reason: "managed-service-handoff-cancelled", steps: [] },
      },
    });
  });

  itUnix(
    "fails closed when the exact systemd stop job exhausts the parent-exit deadline",
    async () => {
      const { sentinel, state } = await runManagedServiceManagerBoundary("systemd", {
        systemdHandoffDeadlineMs: 5_000,
        systemdHandoffFailure: true,
        systemdStopDelayMs: 6_000,
      });

      expect(state).toMatchObject({ parked: true });
      expect([state.reset, state.restored, state.stopCompleted]).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      expectHandoff(expect, sentinel, "error", "managed-service-handoff-restore-failed");
    },
  );
}

export function createManagedServiceManagerFixtureScript(params: {
  kind: "systemd" | "launchd";
  parentPid: number;
  statePath: string;
  commandsPath: string;
  configPath: string;
  options?: ManagedServiceManagerBoundaryOptions;
}): string {
  const { commandsPath, kind, options, parentPid, statePath } = params;
  const update = (source: string) => managedServiceStateUpdateScript(statePath, source);
  return `#!${testNodeExecPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
fs.appendFileSync(${JSON.stringify(commandsPath)}, args.join(" ") + "\\n");
const action = args.find((arg) => ["show", "stop", "reset-failed", "start", "print", "disable", "bootout", "enable", "bootstrap", "kickstart"].includes(arg));
void (async () => {
  const { isPidDefinitelyDead } = action === ${JSON.stringify(kind === "systemd" ? "stop" : "print")}
    ? await import(${JSON.stringify(new URL("../shared/pid-alive.ts", import.meta.url).href)})
    : {};
  if (${JSON.stringify(kind)} === "systemd" && action === "stop") {
    ${update("state.parked = true")};
    while (!isPidDefinitelyDead(${parentPid})) sleep(10);
    sleep(${options?.systemdStopDelayMs ?? 0});
    ${update(
      `${
        options?.revokeOwner
          ? `const config = JSON.parse(fs.readFileSync(${JSON.stringify(params.configPath)}, "utf8"));
          config.commands = { ...config.commands, ownerAllowFrom: [] };
          ${options?.disableChannelOnRevoke ? "config.channels = { ...config.channels, slack: { ...config.channels?.slack, enabled: false } };" : ""}
          fs.writeFileSync(${JSON.stringify(params.configPath)}, JSON.stringify(config));
          state.ownerRevokedAfterExit = true;`
          : ""
      }
      state.stopCompleted = true`,
    )};
    return;
  }
  ${update(
    `
if (${JSON.stringify(kind)} === "systemd") {
  if (action === "reset-failed") state.reset = true;
  if (action === "start" && ${JSON.stringify(options?.systemdFault)} === "start-failed") {
    state.startFailed = true;
    process.stderr.write("start limit hit\\n");
    process.exitCode = 1;
  } else if (action === "start") state.restored = true;
  if (action === "show") {
    const active = !state.parked || state.restored;
    const restoredPid = ${JSON.stringify(options?.systemdFault)} === "dead-restored-pid" ? 2147483647 : ${process.pid};
    const postExitStates = ${JSON.stringify(options?.systemdPostExitStates ?? [])};
    const observation = state.parked && !state.restored && postExitStates.length
      ? postExitStates[Math.min(state.postExitShows || 0, postExitStates.length - 1)]
      : undefined;
    if (observation) state.postExitShows = (state.postExitShows || 0) + 1;
    const observedPid = observation?.mainPid === "parent" ? ${parentPid}
      : observation?.mainPid === "replacement" ? ${process.pid}
      : observation?.mainPid === "none" ? 0
      : state.restored ? restoredPid : active ? ${parentPid} : 0;
    const identityIndex = (observed) => state.restored || observed === "replacement" ? 2
      : state.previousGenerationRestored ? 3
      : observed === "parked" ? 1 : observed === "cleared" ? 0
      : active || observation?.activeState === "deactivating" ? 1 : 0;
    process.stdout.write([
      "Id=" + (observation?.id || "openclaw-gateway.service"),
      "LoadState=" + (observation?.loadState || "loaded"),
      "ActiveState=" + (observation?.activeState || (active ? "active" : "inactive")),
      "MainPID=" + observedPid,
      "ExecMainStartTimestampMonotonic=" + ["0", "111", "222", "333"][identityIndex(observation?.generation)],
      "InvocationID=" + ["", "a".repeat(32), "b".repeat(32), "c".repeat(32)][identityIndex(observation?.invocation)],
    ].join("\\n") + "\\n");
  }
  } else {
  if (action === "disable") state.disabled = true;
  if (action === "bootout") {
    state.parked = true;
    state.loadedPrintsRemaining = ${options?.launchdTeardown?.loadedPrints ?? 0};
    state.pendingBootstrapFailures = ${options?.launchdTeardown?.pendingBootstrapFailures ?? 0};
    state.pendingOperationInProgress = ${options?.launchdTeardown?.pendingOperationInProgress ?? 0};
  }
  if (action === "enable") state.disabled = false;
  if (action === "bootstrap" || action === "kickstart") {
    state.bootstrapAttempts = (state.bootstrapAttempts || 0) + 1;
    if (state.pendingOperationInProgress > 0 || !state.unloaded) {
      if (state.pendingOperationInProgress > 0) {
        state.pendingOperationInProgress -= 1;
        state.operationInProgressObserved = (state.operationInProgressObserved || 0) + 1;
      }
      process.stderr.write("Bootstrap failed: 37: Operation already in progress\\n");
      process.exitCode = 37;
    } else if (action === "bootstrap" && state.pendingBootstrapFailures > 0) {
      state.pendingBootstrapFailures -= 1;
      process.stderr.write("Bootstrap failed: 5: Input/output error\\n");
      process.exitCode = 5;
    } else state.restored = true;
  }
  if (action === "print") {
    const parentAlive = !isPidDefinitelyDead(${parentPid});
    if (state.parked && !state.restored && !parentAlive) {
      if (state.loadedPrintsRemaining > 0) {
        state.loadedPrintsRemaining -= 1;
        state.loadedPrintsObserved = (state.loadedPrintsObserved || 0) + 1;
      } else {
        state.unloaded = true;
        process.stderr.write("Could not find service\\n");
        process.exitCode = 113;
        return state;
      }
    }
    const fault = ${JSON.stringify(options?.launchdFault)};
    const restoredPid = fault === "dead-restored-pid" ? 2147483647 : ${process.pid};
    const currentPid = fault === "wrong-parent" || fault === "nested-parent" ? ${process.pid} : ${parentPid};
    const pidLine = state.restored && ["missing-restored-pid", "nested-restored-pid"].includes(fault)
      ? "" : "\\tpid = " + (state.restored ? restoredPid : currentPid) + "\\n";
    const nestedPid = !state.parked && fault === "nested-parent" ? ${parentPid}
      : state.restored && fault === "nested-restored-pid" ? ${process.pid} : undefined;
    const nested = nestedPid ? "\\tresource coalition = {\\n\\t\\tpid = " + nestedPid + "\\n\\t}\\n" : "";
    const foreign = (!state.parked && fault === "foreign-job") || (state.restored && fault === "foreign-restored-job");
    const duplicate = (!state.parked && fault === "duplicate-pid") || (state.restored && fault === "duplicate-restored-pid");
    process.stdout.write((foreign ? "gui/501/ai.openclaw.other" : args[1]) + " = {\\n\\tstate = running\\n" + "\\tenvironment = {\\n\\t\\tPADDING = " + "x".repeat(${options?.launchdOutputPadding ?? 0}) + "\\n\\t}\\n" + nested + pidLine + (duplicate ? pidLine : "") + "}\\n");
  }
}
  `,
  )};
  if (action === "bootout" && ${options?.launchdTeardown?.bootoutDelayMs ?? 0}) {
    await new Promise((resolve) => setTimeout(resolve, ${options?.launchdTeardown?.bootoutDelayMs ?? 0}));
    ${update("state.bootoutCompleted = true")};
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;
}

export function createManagedServiceUpdaterFixtureScript(params: {
  kind: "systemd" | "launchd";
  root: string;
  statePath: string;
  updaterPath: string;
  logPath: string;
  stateDatabasePath: string;
  consumeNotification: string;
  options?: ManagedServiceManagerBoundaryOptions;
}): string {
  const { kind, root, statePath, updaterPath, stateDatabasePath, consumeNotification, options } =
    params;
  const update = (source: string) => managedServiceStateUpdateScript(statePath, source);
  const updaterResult = options?.updaterResult
    ? { root, ...(options.updaterResult as UpdateRunResult) }
    : null;
  const notification =
    updaterResult && options?.updaterNotification
      ? buildUpdateRestartSentinelPayload({
          result: {
            ...updaterResult,
            steps: updaterResult.steps ?? [],
            durationMs: updaterResult.durationMs ?? 0,
          },
          meta: {
            root,
            handoffId: `${kind}-boundary`,
            note: "Preserve this updater notification across handoff.",
          },
        })
      : null;
  // Use the canonical row shape without moving publication ahead of the child.
  const notificationRow = notification
    ? buildRestartSentinelRow(notification, notification.ts)
    : null;
  const consume =
    options?.updaterNotification === "consumed-before-exit" ||
    (options?.updaterNotification === "consumed" &&
      (updaterResult?.status === "ok" ||
        (updaterResult?.recovery?.serviceRestartSafe && updaterResult.recovery.service)));
  return `void (async () => {
const fs = require("node:fs");
if (${kind === "launchd"}) {
const state = ${update("if (state.unloaded) state.updaterObservedUnloaded = true")};
if (!state.unloaded) process.exit(19);
}
fs.writeFileSync(${JSON.stringify(updaterPath)}, "ran");
if (${Boolean(notification && notificationRow)}) {
const notification = ${JSON.stringify(notification)};
const row = ${JSON.stringify(notificationRow)};
const db = new (require("node:sqlite").DatabaseSync)(${JSON.stringify(stateDatabasePath)});
db.prepare("INSERT INTO gateway_restart_sentinel (" + Object.keys(row).join(", ") + ") VALUES (" + Object.keys(row).map(() => "?").join(", ") + ")").run(...Object.values(row)); db.close();
${update("state.publishedSentinel = { version: 1, payload: notification, revision: notification.ts }")};
if (${Boolean(consume)}) { ${consumeNotification} }
}
if (${options?.diagnosticReadFailure === "before-recovery"}) {
const db = new (require("node:sqlite").DatabaseSync)(${JSON.stringify(stateDatabasePath)}); db.exec("ALTER TABLE gateway_restart_sentinel RENAME COLUMN thread_id TO unreadable_thread_id"); db.close();
}
const result = JSON.stringify(${JSON.stringify(updaterResult)});
const mode = ${JSON.stringify(options?.updaterOutput)};
const output = mode === "missing" ? "" : mode === "malformed" ? "diagnostic before JSON\\n" + result : mode === "overflow" ? " ".repeat(4 * 1024 * 1024) + result : result;
let remaining = Buffer.from(output);
if (${options?.updaterOutput === "split-utf8"}) {
const split = remaining.findIndex((byte) => byte >= 0x80) + 1;
if (!split) throw new Error("expected a Unicode installation root");
const prefix = remaining.subarray(0, split);
const logPath = ${JSON.stringify(params.logPath)};
const logOffset = fs.statSync(logPath).size;
fs.writeSync(1, prefix);
// Wait for a distinct pipe read before sending the remaining UTF-8 bytes.
const deadline = Date.now() + 5000;
while (!fs.readFileSync(logPath).subarray(logOffset).includes(prefix)) {
  if (Date.now() >= deadline) throw new Error("helper did not receive the UTF-8 prefix");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
remaining = remaining.subarray(split);
}
process.stdout.write(remaining, () => { ${options?.updaterSignal ? 'process.kill(process.pid, "SIGTERM");' : `process.exit(${options?.updaterExitCode ?? 7});`} });
})().catch((error) => { console.error(error); process.exitCode = 1; });`;
}

export function createManagedServiceCancellationPreload(params: {
  scriptPath: string;
  updaterPidPath: string;
  activationGatePath: string;
  activationReleasePath: string;
  mutationPath: string;
  gateInspection: boolean;
}): string {
  return `
  if (process.argv[1] === ${JSON.stringify(params.scriptPath)}) {
    const fs = require("node:fs");
    const children = require("node:child_process");
    const spawn = children.spawn;
    const kill = process.kill;
    let updaterPid;
    let inspectionHeld = false;
    // Keep termination pending until activation observes accepted cancellation.
    // The test process owns final cleanup of this exact synthetic updater group.
    process.kill = (pid, signal) => signal === "SIGKILL" && pid === -updaterPid
      ? true : kill.call(process, pid, signal);
    children.spawn = (command, args, options) => {
      const mutation = (command === "systemctl" && args.includes("stop")) ||
        (command === "launchctl" && ["disable", "bootout"].includes(args[0]));
      if (mutation) fs.writeFileSync(${JSON.stringify(params.mutationPath)}, args.join(" "));
      const child = spawn(command, args, options);
      if (command === process.execPath && args[0] === "-e" && !updaterPid) {
        updaterPid = child.pid;
        fs.writeFileSync(${JSON.stringify(params.updaterPidPath)}, String(updaterPid));
        const killChild = child.kill.bind(child);
        child.kill = (signal) => signal === "SIGKILL" ? true : killChild(signal);
      }
      const inspection = (command === "systemctl" && args.includes("show")) ||
        (command === "launchctl" && args[0] === "print");
      if (${params.gateInspection} && inspection && !inspectionHeld) {
        inspectionHeld = true;
        const emit = child.emit.bind(child);
        child.emit = (event, ...values) => {
          if (event !== "close") return emit(event, ...values);
          fs.writeFileSync(${JSON.stringify(params.activationGatePath)}, "inspection");
          const timer = setInterval(() => {
            if (!fs.existsSync(${JSON.stringify(params.activationReleasePath)})) return;
            clearInterval(timer);
            emit(event, ...values);
          }, 5);
          return true;
        };
      }
      return child;
    };
  }`;
}

export async function prepareManagedServiceTriageClockPreload(
  params: { root: string; scriptPath: string; statePath: string },
  triageCommandArgv: string[],
  triageInputPath: string,
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const preloadPath = path.join(params.root, "triage-clock-preload.cjs");
  const commandArgv = [...triageCommandArgv, "--update-result", triageInputPath];
  // Only the generated helper advances its diagnostic timer. The installed
  // command, its descendant, recovery, and lease clocks stay native.
  const source = `if (process.argv[1] === ${JSON.stringify(params.scriptPath)}) {
    const fs = require("node:fs");
    const children = require("node:child_process");
    const spawn = children.spawn;
    const setTimeout = global.setTimeout;
    const clearTimeout = global.clearTimeout;
    const polls = new Map();
    let diagnostic;
    let captured = false;
    children.spawn = (command, args, options) => {
      const child = spawn(command, args, options);
      if (command === ${JSON.stringify(commandArgv[0])} &&
          (args.at(-1) === ${JSON.stringify(JSON.stringify(commandArgv))} ||
           JSON.stringify(args.slice(-${commandArgv.length - 1})) === ${JSON.stringify(JSON.stringify(commandArgv.slice(1)))})) {
        diagnostic = child;
        child.once("close", () => { diagnostic = undefined; });
      }
      return child;
    };
    global.clearTimeout = (timer) => {
      clearInterval(polls.get(timer));
      polls.delete(timer);
      return clearTimeout(timer);
    };
    global.setTimeout = (callback, delay, ...args) => {
      const timer = setTimeout(callback, delay, ...args);
      if (!diagnostic || delay !== 60_000) return timer;
      if (captured) throw new Error("duplicate diagnostic deadline");
      captured = true;
      const poll = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(path.join(params.root, "triage-descendant-ready"))})) return;
        const descendantPid = Number(fs.readFileSync(${JSON.stringify(path.join(params.root, "triage-descendant-ready"))}, "utf8"));
        const state = JSON.parse(fs.readFileSync(${JSON.stringify(params.statePath)}, "utf8"));
        if (state.triageDescendantPid !== descendantPid) return;
        process.kill(descendantPid, 0);
        global.clearTimeout(timer);
        fs.writeFileSync(${JSON.stringify(path.join(params.root, "triage-deadline.json"))}, JSON.stringify({ requestedMs: delay, descendantPid }));
        callback.apply(timer, args);
      }, 5);
      polls.set(timer, poll);
      return timer;
    };
  }`;
  await fs.writeFile(preloadPath, source);
  return { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --require ${preloadPath}`.trim() };
}

export function createManagedServiceLaunchdClockPreload(params: {
  commandTimingsPath: string;
  clockEachCommandMs: number;
  recoveryClockAdvanceMs?: number;
  recoveryCommandArgv: string[];
}): string {
  return [
    'const fs = require("node:fs");',
    'const children = require("node:child_process");',
    "const actualSpawn = children.spawn;",
    "const actualSetTimeout = global.setTimeout;",
    "const startedAt = Date.now();",
    "let elapsed = 0;",
    "Date.now = () => startedAt + elapsed;",
    "global.setTimeout = (callback, delay, ...args) => {",
    "  if (delay === 500) {",
    "    elapsed += delay;",
    "    return actualSetTimeout(callback, 0, ...args);",
    "  }",
    "  return actualSetTimeout(callback, delay, ...args);",
    "};",
    "children.spawn = (command, args, options) => {",
    "  let timedOut = false;",
    '  if (command === "launchctl") {',
    "    const timeoutMs = options.timeout;",
    "    const startedAtMs = Date.now();",
    `    fs.appendFileSync(${JSON.stringify(params.commandTimingsPath)}, JSON.stringify({ action: args[0], startedAtMs, timeoutMs }) + "\\n");`,
    `    elapsed += Math.min(${params.clockEachCommandMs}, timeoutMs);`,
    `    timedOut = ${params.clockEachCommandMs} > timeoutMs;`,
    "  }",
    // Expired simulated work must not execute the manager's completed side effect.
    '  const child = timedOut ? actualSpawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options) : actualSpawn(command, args, options);',
    '  if (timedOut) child.once("spawn", () => child.kill("SIGKILL"));',
    // Advance only when the exact guarded restart closes, before the helper resumes.
    `  if (command === ${JSON.stringify(params.recoveryCommandArgv[0])} && (args.at(-1) === ${JSON.stringify(JSON.stringify(params.recoveryCommandArgv))} || JSON.stringify(args.slice(-${params.recoveryCommandArgv.length - 1})) === ${JSON.stringify(JSON.stringify(params.recoveryCommandArgv.slice(1)))})) {`,
    `    child.once("close", () => { elapsed += ${params.recoveryClockAdvanceMs ?? 0}; });`,
    "  }",
    "  return child;",
    "};",
  ].join("\n");
}

export function registerManagedHandoffOwnerTests(
  runManagedServiceManagerBoundary: SystemdBoundary,
  itUnix: ReturnType<typeof import("vitest").it.runIf>,
  expect: typeof import("vitest").expect,
): void {
  const allowedRequesters = ["unchanged", "internal", "channel-less"] as const;
  itUnix.each(["revoked", "revoked with disabled channel", ...allowedRequesters] as const)(
    "rechecks the %s requester after helper readiness and parent exit",
    async (owner) => {
      const revoked = owner === "revoked" || owner === "revoked with disabled channel";
      const { state, sentinel, log, sensitiveFilesRemoved } =
        await runManagedServiceManagerBoundary("systemd", {
          requester: {
            channel:
              owner === "internal" ? "webchat" : owner === "channel-less" ? undefined : "slack",
            accountId: "primary",
            senderId: "owner",
          },
          revokeOwner: revoked,
          ...(owner === "revoked with disabled channel" ? { disableChannelOnRevoke: true } : {}),
          helperExitCode: revoked ? 1 : 0,
          updaterExitCode: 0,
          updaterResult: { status: "ok", mode: "npm" },
        });
      expect(state).toMatchObject({ parked: true, stopCompleted: true });
      expect(state.ownerChecked).toBe(revoked || owner === "unchanged" ? true : undefined);
      if (revoked) {
        expect(state).toMatchObject({
          ownerRevokedAfterExit: true,
          restored: true,
          healthProbed: true,
        });
        expectHandoff(expect, sentinel, "error", "owner_required", 0);
        expect(log).toContain("owner_required");
        expect(log).not.toContain("starting managed update command");
      } else {
        expect(log).toContain("starting managed update command");
      }
      expect(sensitiveFilesRemoved).toBe(true);
    },
  );
}
