import { ChildProcess, type SpawnOptions } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runDelegatedUpdateCandidateRehearsal } from "./update-candidate-delegated-rehearsal.js";
import {
  formatUpdateRehearsalEventLine,
  type UpdateRehearsalEvent,
} from "./update-rehearsal-contract.js";
import type { UpdateRunStep } from "./update-run-record.js";
import type { UpdateStepResult } from "./update-step-result.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), signal: vi.fn(), tmpdir: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
// mock-isolation: the fixture candidate is not a real process tree to signal.
vi.mock("../process/kill-tree.js", () => ({ signalProcessTree: mocks.signal }));
// mock-isolation: keeps the private request workspace inside this test's directory.
vi.mock("./tmp-openclaw-dir.js", () => ({ resolvePreferredOpenClawTmpDir: mocks.tmpdir }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let child: ChildProcess;
let observed: { args: string[]; env: NodeJS.ProcessEnv; request: unknown; mode: number };
let requestPath: string;
let spawned: ReturnType<typeof createDeferredCore<void>>;
/** Receipt answers the updater wrote to the candidate's stdin. */
let answers: unknown[];
/** What the fixture candidate does once started; `pending` leaves it running. */
let fixture: { code: number | null; stdout: string; events?: string; pending?: boolean };

const progress: UpdateRunStep = {
  step: "candidate-doctor",
  status: "in_progress",
  startedAtMs: 1,
  detail: "Running Doctor",
};
// Fixed values: the fallback table below is built before any test directory exists.
const startup: UpdateStepResult = {
  name: "candidate-gateway-startup",
  command: "gateway run",
  cwd: "/fixture/candidate",
  durationMs: 5,
  exitCode: 0,
};
const document = (result: Record<string, unknown> = {}, protocol = 1) =>
  JSON.stringify({
    protocol,
    result: {
      status: "ok",
      phase: "readiness",
      durationMs: 12,
      logTail: [],
      steps: [startup],
      ...result,
    },
  });
const refusal = { status: "error", reason: "doctor-failed", phase: "doctor" };
const lines = (...events: UpdateRehearsalEvent[]) =>
  events.map(formatUpdateRehearsalEventLine).join("");

async function setMarker(marker: unknown): Promise<void> {
  const manifest = { version: "2026.11.4", openclaw: { updateRehearsalProtocol: marker } };
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
}

function run(overrides: Partial<Parameters<typeof runDelegatedUpdateCandidateRehearsal>[0]> = {}) {
  return runDelegatedUpdateCandidateRehearsal({
    root,
    config: { gateway: { port: 18789 } },
    stateDir: path.join(root, "state"),
    env: { OPENCLAW_UPDATE_RUN_HANDOFF: "1", OPENCLAW_PROFILE: "work" },
    ...overrides,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  const { resolvePreferredOpenClawTmpDir } =
    await vi.importActual<typeof import("./tmp-openclaw-dir.js")>("./tmp-openclaw-dir.js");
  root = tempDirs.make("update-delegated-rehearsal-", resolvePreferredOpenClawTmpDir());
  mocks.tmpdir.mockReturnValue(root);
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(path.join(root, "dist", "index.js"), "// candidate entry fixture");
  await setMarker(1);
  fixture = { code: 0, stdout: document() };
  spawned = createDeferredCore();
  answers = [];
  mocks.spawn.mockImplementation((_command: string, args: string[], options: SpawnOptions) => {
    child = new ChildProcess();
    Object.defineProperty(child, "pid", { value: 654 });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on("data", (line) => answers.push(JSON.parse(String(line))));
    requestPath = args[args.indexOf("--request") + 1]!;
    observed = {
      args: args.slice(args.indexOf("update")),
      env: options.env ?? {},
      request: JSON.parse(fsSync.readFileSync(requestPath, "utf8")),
      mode: fsSync.statSync(requestPath).mode & 0o777,
    };
    spawned.resolve();
    if (!fixture.pending) {
      queueMicrotask(() => {
        child.stderr?.emit("data", fixture.events ?? "");
        child.stdout?.emit("data", fixture.stdout);
        child.emit("close", fixture.code);
      });
    }
    return child;
  });
  mocks.signal.mockImplementation((_pid, _signal, options) => {
    child.emit("close", null);
    options.onComplete();
  });
});

afterEach(() => vi.useRealTimers());

/** A live candidate handles the stop request and exits after cleaning up. */
function exitsOnRequest() {
  return vi.spyOn(child, "kill").mockImplementation(() => {
    child.emit("close", null);
    return true;
  });
}

it.each([undefined, 2, "1"])(
  "leaves a target with marker %s to the installed updater",
  async (marker) => {
    await setMarker(marker);
    await expect(run()).resolves.toEqual({
      owner: "installed",
      fallbackReason: "unsupported-target",
    });
    expect(mocks.spawn).not.toHaveBeenCalled();
  },
);

it("relays the candidate's receipts in order and returns its result", async () => {
  const received: unknown[] = [];
  // An event this updater does not know, and that no receipt waits on, is ignored.
  fixture.events = `${lines({ type: "progress", seq: 1, step: progress })}plain diagnostic\n${eventLine(
    '{"type":"note"}',
  )}\n${lines({ type: "heartbeat" }, { type: "step", seq: 2, step: startup })}`;
  const result = await run({
    sourceBundledPlugins: { packageRoot: "/serving/openclaw" },
    timeoutMs: 90_000,
    fullIntegrityCheck: true,
    onProgress: (step) => void received.push(["progress", step]),
    onStep: (step) => void received.push(["step", step]),
  });
  expect(result).toEqual({
    owner: "candidate",
    result: { status: "ok", phase: "readiness", durationMs: 12, logTail: [], steps: [startup] },
  });
  expect(received).toEqual([
    ["progress", progress],
    ["step", startup],
  ]);
  expect(observed.args).toEqual(["update", "rehearse", "--request", requestPath]);
  expect(observed.request).toEqual({
    protocol: 1,
    config: { gateway: { port: 18789 } },
    sourceBundledPlugins: { packageRoot: "/serving/openclaw" },
    timeoutMs: 90_000,
    fullIntegrityCheck: true,
  });
  expect(observed.mode).toBe(0o600);
  // The candidate inspects the serving profile but inherits no update continuation.
  expect(observed.env).toMatchObject({
    OPENCLAW_PROFILE: "work",
    OPENCLAW_DEV_SOURCE_ROOT: root,
    OPENCLAW_VERSION: "2026.11.4",
  });
  expect(observed.env).not.toHaveProperty("OPENCLAW_UPDATE_RUN_HANDOFF");
  await expect(fs.access(requestPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(answers).toEqual([
    { seq: 1, ok: true },
    { seq: 2, ok: true },
  ]);
});

it("answers a receipt only after the updater has committed it", async () => {
  const committed = createDeferredCore();
  fixture.pending = true;
  const result = run({ onProgress: () => committed.promise });
  await spawned.promise;
  child.stderr?.emit("data", lines({ type: "progress", seq: 1, step: progress }));
  await nextTurn();
  // The candidate is still waiting, so its check has not started.
  expect(answers).toEqual([]);
  committed.resolve();
  await nextTurn();
  expect(answers).toEqual([{ seq: 1, ok: true }]);
  child.stdout?.emit("data", document());
  child.emit("close", 0);
  await expect(result).resolves.toMatchObject({ owner: "candidate" });
});

it("treats a candidate refusal as binding", async () => {
  fixture = { code: 3, stdout: document(refusal) };
  await expect(run()).resolves.toMatchObject({
    owner: "candidate",
    result: { status: "error", reason: "doctor-failed", phase: "doctor" },
  });
});

it.each([
  [
    "an execution failure",
    2,
    JSON.stringify({ protocol: 1, error: "rehearsal-execution-failed" }),
    "exit-2",
  ],
  ["a crash", null, "", "crash"],
  ["output that is not JSON", 0, "Doctor complete.", "malformed-json"],
  ["a pass reported with the refusal status", 3, document(), "invalid-result"],
  ["a refusal reported with the pass status", 0, document(refusal), "invalid-result"],
  ["an unknown phase", 0, document({ phase: "warp" }), "invalid-result"],
  ["an unknown failure reason", 3, document({ ...refusal, reason: "vibes" }), "invalid-result"],
  ["a step without an exit status", 0, document({ steps: [{ name: "x" }] }), "invalid-result"],
  ["another protocol", 0, document({}, 2), "invalid-result"],
] as const)(
  "returns the rehearsal to the installed updater after %s",
  async (_name, code, stdout, reason) => {
    fixture = { code, stdout, events: "[openclaw] Reason: fixture diagnostic\n" };
    await expect(run()).resolves.toEqual({
      owner: "installed",
      fallbackReason: reason,
      diagnostic: "fixture diagnostic",
    });
  },
);

it("ends the rehearsal when the updater cannot record a receipt", async () => {
  const failure = new Error("ledger writer lost");
  const onStep = vi.fn();
  fixture.pending = true;
  const result = run({ onProgress: () => Promise.reject(failure), onStep });
  await spawned.promise;
  const stop = exitsOnRequest();
  child.stderr?.emit(
    "data",
    lines({ type: "progress", seq: 1, step: progress }, { type: "step", seq: 2, step: startup }),
  );
  await expect(result).rejects.toBe(failure);
  expect(stop).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  expect(onStep).not.toHaveBeenCalled();
  // The candidate is told, so it stops instead of starting the next check.
  expect(answers).toEqual([
    { seq: 1, ok: false },
    { seq: 2, ok: false },
  ]);
});

it("records a progress receipt whose text is longer than the ledger keeps", async () => {
  const onProgress = vi.fn();
  const detail = `Temporary-copy cleanup /${"nested/".repeat(400)}`;
  fixture.events = lines({ type: "progress", seq: 1, step: { ...progress, detail } });
  await expect(run({ onProgress })).resolves.toMatchObject({ owner: "candidate" });
  // Bounded the way the ledger bounds it, not dropped while the candidate waits.
  expect(onProgress).toHaveBeenCalledExactlyOnceWith({
    ...progress,
    detail: detail.slice(0, 1024),
  });
  expect(answers).toEqual([{ seq: 1, ok: true }]);
});

const eventLine = (payload: string) => `openclaw-update-rehearsal-event: ${payload}`;

it.each([
  ["a receipt it cannot read", `${eventLine('{"type":"step","seq":1,"step":{}}')}\n`],
  ["an event that is not JSON", `${eventLine('{"type":"step","seq":1,')}\n`],
  ["an event too long for its line reader", eventLine("x".repeat(70_000))],
])("takes the rehearsal back after %s", async (_name, data) => {
  fixture.pending = true;
  const result = run();
  await spawned.promise;
  let pipeClosedFirst: boolean | undefined;
  const stop = vi.spyOn(child, "kill").mockImplementation(() => {
    // Closing the pipe is what releases a candidate that is waiting on an answer.
    pipeClosedFirst = child.stdin?.writableEnded;
    child.emit("close", null);
    return true;
  });
  // The candidate keeps proving it is alive, so silence would never end this wait.
  child.stderr?.emit("data", data);
  child.stderr?.emit("data", lines({ type: "heartbeat" }));
  // The dropped line also leaves its "[oversized log line omitted]" diagnostic.
  await expect(result).resolves.toMatchObject({
    owner: "installed",
    fallbackReason: "unreadable-event",
  });
  expect(stop).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  expect(pipeClosedFirst).toBe(true);
});

it("stops waiting only after the candidate has been silent, however long its checks run", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  fixture.pending = true;
  const settled = vi.fn();
  const result = run();
  void result.then(settled);
  await spawned.promise;
  // Two hours of heartbeats: slow work is not a stall.
  for (let minute = 0; minute < 120; minute += 10) {
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    child.stderr?.emit("data", lines({ type: "heartbeat" }));
  }
  await vi.advanceTimersByTimeAsync(14 * 60_000);
  expect(settled).not.toHaveBeenCalled();
  expect(mocks.signal).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  await expect(result).resolves.toEqual({ owner: "installed", fallbackReason: "stalled" });
  expect(mocks.signal).toHaveBeenCalledWith(654, "SIGTERM", expect.anything());
});

it.each([
  ["lets a cancelled candidate remove its copies and exit", true],
  ["forces a cancelled candidate only after its cleanup allowance", false],
] as const)("%s", async (_name, exits) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const controller = new AbortController();
  const cancelled = new Error("operator deadline");
  fixture.pending = true;
  const rejection = expect(run({ signal: controller.signal })).rejects.toBe(cancelled);
  await spawned.promise;
  const stop = exits ? exitsOnRequest() : vi.spyOn(child, "kill").mockReturnValue(true);
  controller.abort(cancelled);
  await vi.advanceTimersByTimeAsync(4 * 60_000);
  expect(stop).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  if (exits) {
    // Settled on the candidate's own exit, well inside the allowance.
    await rejection;
    return;
  }
  // Nothing is forced while the candidate may still be removing its copies.
  expect(mocks.signal).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2 * 60_000);
  await rejection;
  expect(mocks.signal).toHaveBeenCalledWith(654, "SIGKILL", expect.anything());
});
