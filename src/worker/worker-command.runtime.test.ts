import { Console } from "node:console";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WORKER_PROTOCOL_FEATURES,
  WORKER_RPC_SET_VERSION,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { WorkerBrowserRuntime } from "./browser-runtime.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { runWorkerCommand } from "./worker-command.runtime.js";
import {
  buildWorkerProcessTurn,
  parseWorkerProcessMessage,
  serializeWorkerProcessInput,
  type WorkerProcessMessage,
  type WorkerProcessResult,
} from "./worker-process-protocol.js";
import { runWorkerProcess } from "./worker-process.js";
import { createWorkerRuntimeEnvironment, runWorkerDescriptor } from "./worker.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const completed = { status: "completed" as const, transcriptLeafId: null, transcriptNextSeq: 1 };
const stateDir = "/tmp/openclaw-managed-worker-state";

const managedRuntime = vi.hoisted(() => ({
  backgroundCount: 0,
  close: vi.fn(),
  waitForExecScope: vi.fn(),
  disposeProfile: vi.fn(),
}));

vi.mock("../agents/bash-process-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/bash-process-registry.js")>()),
  getActiveBackgroundExecSessionCount: () => managedRuntime.backgroundCount,
  waitForExecScope: managedRuntime.waitForExecScope,
}));

vi.mock("./github-binding.runtime.js", () => ({
  disposeWorkerGitHubEnvironment: managedRuntime.disposeProfile,
}));

vi.mock("./worker.runtime.js", () => ({
  runWorkerDescriptor: vi.fn(),
  createWorkerRuntimeEnvironment: vi.fn(),
}));

const descriptor = {
  version: 4,
  connectionEndpoint: { kind: "unix", socketPath: "/tmp/openclaw-worker/gateway.sock" },
  admission: {
    environmentId: "environment-1",
    credential: ["worker", "fixture", "value"].join("-"),
    sessionId: "session-1",
    ownerEpoch: 1,
    rpcSetVersion: WORKER_RPC_SET_VERSION,
    handshake: {
      bundleHash: "a".repeat(64),
      openclawVersion: "2026.7.12",
      protocolFeatures: [...WORKER_PROTOCOL_FEATURES],
    },
  },
  assignment: {
    agentId: "agent-1",
    operationalRunInstance: { instanceId: "instance-run-1", runId: "run-1" },
    agentRuntimeIdentityToken: "signed-runtime-token",
    runId: "run-1",
    turnId: "turn-1",
    prompt: "Inspect the workspace.",
    suppressPromptTranscript: false,
    workspaceDir: "/tmp/openclaw-worker/workspace",
    modelRef: { provider: "provider-1", model: "model-1" },
    inferenceOptions: { reasoning: "medium", maxTokens: 512 },
    initialMessages: [
      { role: "user", content: [{ type: "text", text: "Earlier context." }], timestamp: 1 },
    ],
    transcript: { baseLeafId: "leaf-7", nextSeq: 8 },
    liveEvents: { ackedSeq: 12, nextSeq: 13 },
    toolAuthority: { allowedToolNames: ["read", "exec"] },
  },
} satisfies WorkerLaunchDescriptor;

function commandInput() {
  const input = new PassThrough();
  input.end(JSON.stringify(descriptor));
  return input;
}

function processHarness(properties: Record<string, unknown> = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const originalConsole = globalThis.console;
  const previousLogging = { ...loggingState };
  const replacements = { stdin: commandInput(), stdout, stderr, ...properties };
  const originalProperties = new Map(
    Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(process, key)]),
  );
  for (const [key, value] of Object.entries(replacements)) {
    Object.defineProperty(process, key, { configurable: true, value });
  }
  globalThis.console = new Console({ stdout, stderr });
  loggingState.consolePatched = false;
  loggingState.forceConsoleToStderr = false;
  loggingState.rawConsole = null;
  loggingState.streamErrorHandlersInstalled = false;
  return {
    stdout,
    stderr,
    restore: () => {
      for (const [key, propertyDescriptor] of originalProperties) {
        if (propertyDescriptor) {
          Object.defineProperty(process, key, propertyDescriptor);
        } else {
          Reflect.deleteProperty(process, key);
        }
      }
      globalThis.console = originalConsole;
      Object.assign(loggingState, previousLogging);
      stdout.destroy();
      stderr.destroy();
    },
  };
}

function lifetimeHarness() {
  const controller = new AbortController();
  const started = createDeferred<boolean>();
  const contract = {
    dispose: vi.fn(),
    reportConnectionFailure: vi.fn(),
    signal: controller.signal,
    started: started.promise,
    terminateOwnedTree: vi.fn(),
  };
  return {
    ...contract,
    contract,
    disconnectAfterStart: () => controller.abort(new Error("worker supervisor lifetime ended")),
    disconnectBeforeStart: () => started.resolve(false),
    open: () => started.resolve(true),
  };
}

function managedHarness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const results: WorkerProcessResult[] = [];
  output.on("data", (chunk: Buffer) => {
    const result = parseWorkerProcessMessage(JSON.parse(chunk.toString("utf8")));
    if (result?.type === "result") {
      results.push(result);
    }
  });
  const launch = makeLaunch({
    workspaceDir: process.cwd(),
    permissionMode: "full",
    workerContainmentRoot: process.cwd(),
  });
  const send = (value: unknown) => input.write(`${JSON.stringify(value)}\n`);
  return {
    input,
    output,
    results,
    nextMessage: () =>
      new Promise<WorkerProcessMessage>((resolve, reject) => {
        output.once("data", (chunk: Buffer) => {
          const message = parseWorkerProcessMessage(JSON.parse(chunk.toString("utf8")));
          if (message) {
            resolve(message);
          } else {
            reject(new Error("Invalid worker message"));
          }
        });
      }),
    launch,
    send,
    turn: (value: WorkerLaunchDescriptor = launch, idleRetention = false) =>
      send(buildWorkerProcessTurn(value, idleRetention)),
  };
}

function makeLaunch(
  assignment: Partial<WorkerLaunchDescriptor["assignment"]>,
  base: WorkerLaunchDescriptor = descriptor,
) {
  const launch: WorkerLaunchDescriptor = structuredClone(base);
  Object.assign(launch.assignment, assignment);
  return launch;
}

function nextRun(base: WorkerLaunchDescriptor) {
  return makeLaunch(
    {
      turnId: "turn-2",
      runId: "run-2",
      operationalRunInstance: { instanceId: "instance-run-2", runId: "run-2" },
    },
    base,
  );
}

function aborted(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function barrier() {
  const entered = createDeferred();
  const released = createDeferred();
  return {
    entered: entered.promise,
    release: released.resolve,
    wait: () => {
      entered.resolve();
      return released.promise;
    },
  };
}

function gatedCommandHarness(mode: "standalone" | "managed") {
  if (mode === "standalone") {
    return { input: commandInput(), output: new PassThrough() };
  }
  const { input, output, turn } = managedHarness();
  turn();
  return { input, output, managed: true };
}

function waitForRuntimeAbort(
  result: Awaited<ReturnType<typeof runWorkerDescriptor>> = completed,
  onAbort = () => {},
) {
  const started = createDeferred<AbortSignal>();
  vi.mocked(runWorkerDescriptor).mockImplementationOnce(async (_launch, options) => {
    const signal = options?.signal;
    if (!signal) {
      throw new Error("expected managed worker abort signal");
    }
    started.resolve(signal);
    await aborted(signal);
    onAbort();
    return result;
  });
  return started.promise;
}

describe("worker command lifetime gate", () => {
  beforeEach(() => {
    vi.mocked(runWorkerDescriptor).mockReset().mockResolvedValue(completed);
    managedRuntime.backgroundCount = 0;
    managedRuntime.waitForExecScope.mockReset().mockResolvedValue(undefined);
    managedRuntime.disposeProfile.mockReset().mockResolvedValue(undefined);
    managedRuntime.close.mockReset().mockResolvedValue(undefined);
    vi.mocked(createWorkerRuntimeEnvironment).mockReset().mockResolvedValue({
      stateDir,
      close: managedRuntime.close,
    });
  });

  it("keeps worker process stdout valid JSON when runtime diagnostics are emitted", async () => {
    const { stdout, stderr, restore } = processHarness();
    setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "compact" });
    vi.mocked(runWorkerDescriptor).mockImplementationOnce(async () => {
      createSubsystemLogger("state/db").info("worker state diagnostic");
      return completed;
    });
    let output = "";
    let diagnostics = "";
    try {
      await runWorkerProcess();
      output = String(stdout.read() ?? "");
      diagnostics = String(stderr.read() ?? "");
    } finally {
      restore();
    }

    expect(JSON.parse(output)).toEqual(completed);
    expect(diagnostics).toContain("worker state diagnostic");
  });

  it.each([
    [
      "inherited type",
      () =>
        Object.assign(Object.create({ type: "openclaw-worker-start-v1" }), { unexpected: true }),
    ],
    ["duplicate descriptor", () => ({ type: "openclaw-worker-start-v1", lineageFds: [3, 3] })],
  ] as const)("rejects an internal worker IPC start with %s", async (_label, makeInvalidStart) => {
    const { restore } = processHarness({
      connected: true,
      channel: {},
      send: vi.fn(),
      disconnect: vi.fn(),
    });
    const invalidStart = makeInvalidStart();

    try {
      const running = runWorkerProcess({ internalWorkerIpc: true });
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      process.emit("message", invalidStart);

      await expect(running).rejects.toThrow("invalid internal worker IPC start message");
      expect(runWorkerDescriptor).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("passes the build-composed Browser runtime into the worker boundary", async () => {
    const output = new PassThrough();
    const browserRuntime = {
      createAttachedBrowserToolRuntime: vi.fn(),
    } as unknown as WorkerBrowserRuntime;

    await runWorkerCommand({ input: commandInput(), output, browserRuntime });

    expect(runWorkerDescriptor).toHaveBeenCalledWith(
      descriptor,
      expect.objectContaining({ browserRuntime }),
    );
  });

  it.each([
    { mode: "standalone", start: true },
    { mode: "standalone", start: false },
    { mode: "managed", start: true },
    { mode: "managed", start: false },
  ] as const)(
    "waits for start and honors pre-start disconnect ($mode, start: $start)",
    async ({ mode, start }) => {
      const harness = gatedCommandHarness(mode);
      const lifetime = lifetimeHarness();
      const running = runWorkerCommand({ ...harness, lifetime: lifetime.contract });
      if (start) {
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        expect(runWorkerDescriptor).not.toHaveBeenCalled();
        expect(harness.input.readableLength > 0).toBe(mode === "managed");
        lifetime.open();
      } else {
        lifetime.disconnectBeforeStart();
      }
      await running;
      expect(runWorkerDescriptor).toHaveBeenCalledTimes(start ? 1 : 0);
      expect(lifetime.terminateOwnedTree).not.toHaveBeenCalled();
      expect(lifetime.dispose).toHaveBeenCalledOnce();
    },
  );

  it.each(["standalone", "managed"] as const)(
    "aborts the worker path and terminates its owned tree on IPC disconnect (%s)",
    async (mode) => {
      const harness = gatedCommandHarness(mode);
      let runtimeSignal: AbortSignal | undefined;
      vi.mocked(runWorkerDescriptor).mockImplementation(async (_descriptor, options) => {
        const signal = options?.signal;
        if (!signal) {
          throw new Error("expected worker lifetime abort signal");
        }
        runtimeSignal = signal;
        await aborted(signal);
        throw signal.reason instanceof Error ? signal.reason : new Error("worker interrupted");
      });
      const lifetime = lifetimeHarness();
      lifetime.terminateOwnedTree.mockImplementation(() => {
        expect(runtimeSignal?.aborted).toBe(true);
      });
      const running = runWorkerCommand({ ...harness, lifetime: lifetime.contract });
      lifetime.open();
      await vi.waitFor(() => expect(runWorkerDescriptor).toHaveBeenCalledOnce());

      lifetime.disconnectAfterStart();

      await expect(running).rejects.toThrow("worker supervisor lifetime ended");
      expect(lifetime.terminateOwnedTree).toHaveBeenCalledOnce();
      expect(lifetime.dispose).toHaveBeenCalledOnce();
    },
  );

  it("retains state across turns and cancels only the exact active turn", async () => {
    const harness = managedHarness();
    const lifetime = lifetimeHarness();
    managedRuntime.backgroundCount = 1;
    vi.mocked(runWorkerDescriptor).mockResolvedValueOnce({
      status: "completed",
      transcriptLeafId: "first-leaf",
      transcriptNextSeq: 2,
    });
    const secondStarted = waitForRuntimeAbort({
      status: "failed",
      reason: "turn-failed",
      transcriptLeafId: "second-leaf",
      transcriptNextSeq: 3,
    });
    const running = runWorkerCommand({ ...harness, managed: true, lifetime: lifetime.contract });
    lifetime.open();
    harness.turn();
    await vi.waitFor(() => expect(harness.results).toHaveLength(1));
    expect(harness.results[0]).toEqual({
      type: "result",
      turnId: "turn-1",
      retainWorker: true,
      result: { status: "completed", transcriptLeafId: "first-leaf", transcriptNextSeq: 2 },
    });
    expect(lifetime.dispose).not.toHaveBeenCalled();

    harness.turn(nextRun(harness.launch));
    const secondSignal = await secondStarted;
    harness.send({ type: "cancel", turnId: "turn-1" });
    expect(secondSignal.aborted).toBe(false);
    const cancellationResult = harness.nextMessage();
    harness.send({ type: "cancel", turnId: "turn-2" });
    try {
      expect(await cancellationResult).toMatchObject({
        turnId: "turn-2",
        result: { status: "failed", reason: "turn-failed" },
        retainWorker: false,
      });
    } finally {
      harness.input.end();
      await running;
    }

    expect(createWorkerRuntimeEnvironment).toHaveBeenCalledOnce();
    expect(
      vi.mocked(runWorkerDescriptor).mock.calls.map(([, options]) => options?.environmentStateDir),
    ).toEqual([stateDir, stateDir]);
    expect(managedRuntime.close).toHaveBeenCalledOnce();
    expect(lifetime.dispose).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "joins finalizers and profile disposal before idle readiness (cancelled: %s)",
    async (cancelled) => {
      const harness = managedHarness();
      harness.launch.assignment.github = {
        token: "synthetic-turn-token",
        login: "worker-fixture",
        branch: "session-fixture",
        gitAuthor: { name: "Fixture", email: "fixture@openclaw.invalid" },
      };
      const joining = barrier();
      const disposing = barrier();
      managedRuntime.waitForExecScope.mockImplementationOnce(joining.wait);
      managedRuntime.disposeProfile.mockImplementationOnce(disposing.wait);
      const running = runWorkerCommand({ ...harness, managed: true });
      const first = harness.nextMessage();
      harness.turn(harness.launch, true);
      await joining.entered;
      expect(harness.results).toEqual([]);
      expect(managedRuntime.disposeProfile).not.toHaveBeenCalled();
      joining.release();
      await disposing.entered;
      expect(harness.results).toEqual([]);
      if (cancelled) {
        harness.send({ type: "cancel", turnId: "turn-1" });
      }
      disposing.release();
      expect(await first).toMatchObject(
        cancelled
          ? { retainWorker: false, turnId: "turn-1" }
          : { retainWorker: true, retention: "idle", turnId: "turn-1" },
      );
      expect(managedRuntime.disposeProfile).toHaveBeenCalledWith(stateDir, "turn-1");
      if (cancelled) {
        await running;
        expect(managedRuntime.close).toHaveBeenCalledOnce();
        return;
      }

      const next = nextRun(harness.launch);
      next.admission.credential = "synthetic-replacement-credential";
      const second = Promise.race([harness.nextMessage(), running]);
      harness.turn(next, true);
      expect(await second).toMatchObject({ retention: "idle", turnId: "turn-2" });
      expect(vi.mocked(runWorkerDescriptor).mock.lastCall?.[0]).toEqual(next);
      expect(createWorkerRuntimeEnvironment).toHaveBeenCalledOnce();
      harness.input.end();
      await running;
      expect(managedRuntime.close).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "settles background retention without stale idle readiness (new turn: %s)",
    async (newTurn) => {
      const harness = managedHarness();
      harness.launch.assignment.github = {
        token: "synthetic-background-token",
        login: "fixture",
        branch: "fixture",
      };
      const settled = createDeferred();
      const disposed = createDeferred();
      const secondTurn = barrier();
      managedRuntime.disposeProfile.mockImplementationOnce(async () => disposed.resolve());
      managedRuntime.backgroundCount = 1;
      managedRuntime.waitForExecScope.mockReturnValueOnce(settled.promise);
      const running = runWorkerCommand({ ...harness, managed: true });
      const first = harness.nextMessage();
      harness.turn(harness.launch, true);
      expect(await first).toMatchObject({ retention: "background", turnId: "turn-1" });
      const nextMessage = harness.nextMessage();
      if (newTurn) {
        vi.mocked(runWorkerDescriptor).mockImplementationOnce(async () => {
          await secondTurn.wait();
          return completed;
        });
        const next = structuredClone(harness.launch);
        next.assignment.turnId = "turn-2";
        delete next.assignment.github;
        harness.turn(next, true);
        await secondTurn.entered;
      }
      managedRuntime.backgroundCount = 0;
      settled.resolve();
      await disposed.promise;
      expect(managedRuntime.disposeProfile).toHaveBeenCalledExactlyOnceWith(stateDir, "turn-1");
      if (newTurn) {
        expect(harness.results).toHaveLength(1);
      }
      secondTurn.release();
      expect(await nextMessage).toMatchObject(
        newTurn
          ? { type: "result", turnId: "turn-2", retention: "idle" }
          : { type: "idle-ready", turnId: "turn-1" },
      );
      expect(managedRuntime.disposeProfile).toHaveBeenCalledTimes(newTurn ? 2 : 1);
      if (newTurn) {
        expect(managedRuntime.disposeProfile).toHaveBeenLastCalledWith(stateDir, "turn-2");
      }
      harness.input.end();
      await running;
    },
  );

  it.each(["owner", "output"] as const)(
    "closes state when %s ends during a pending result write",
    async (ending) => {
      const harness = managedHarness();
      const writing = createDeferred<(error?: Error | null) => void>();
      const output = new Writable({
        write: (_chunk, _encoding, callback) => {
          writing.resolve(callback);
        },
      });
      managedRuntime.backgroundCount = 1;
      const running = runWorkerCommand({ ...harness, output, managed: true });
      harness.turn();
      const completeWrite = await writing.promise;
      if (ending === "owner") {
        harness.input.end();
        await running;
        completeWrite();
      } else {
        const rejected = expect(running).rejects.toThrow("fixture result output failed");
        completeWrite(new Error("fixture result output failed"));
        await rejected;
      }
      expect(managedRuntime.close).toHaveBeenCalledOnce();
    },
  );

  it.each(["duplicate", "workspace"] as const)(
    "refuses a retained worker's %s identity change before admission",
    async (change) => {
      const harness = managedHarness();
      managedRuntime.backgroundCount = 1;
      const running = runWorkerCommand({ ...harness, managed: true });
      harness.turn();
      await vi.waitFor(() => expect(harness.results).toHaveLength(1));
      const next = structuredClone(harness.launch);
      if (change !== "duplicate") {
        next.assignment.turnId = "turn-2";
      }
      if (change === "workspace") {
        next.assignment.workspaceDir = path.dirname(process.cwd());
      }
      const rejected = expect(running).rejects.toThrow(
        change === "duplicate" ? "already executed" : "binding changed",
      );
      harness.turn(next);
      await rejected;
      expect(runWorkerDescriptor).toHaveBeenCalledOnce();
      expect(managedRuntime.close).toHaveBeenCalledOnce();
    },
  );

  it("rejects a canonical device folder retargeted while worker environment setup waits", async () => {
    const root = fs.realpathSync.native(tempDirs.make("worker-device-folder-"));
    const folder = path.join(root, "folder");
    const replacement = path.join(root, "replacement");
    fs.mkdirSync(folder);
    fs.mkdirSync(replacement);
    const harness = managedHarness();
    harness.launch.assignment.workspaceDir = folder;
    harness.launch.assignment.workerContainmentRoot = folder;
    const setup = barrier();
    vi.mocked(createWorkerRuntimeEnvironment).mockImplementationOnce(async () => {
      await setup.wait();
      return { stateDir, close: managedRuntime.close };
    });
    const running = runWorkerCommand({ ...harness, managed: true });
    const rejected = expect(running).rejects.toThrow("canonical workspace changed");
    harness.send(buildWorkerProcessTurn(harness.launch, false, true));
    await setup.entered;
    fs.renameSync(folder, path.join(root, "original"));
    fs.symlinkSync(replacement, folder, "dir");
    setup.release();
    await rejected;
    expect(runWorkerDescriptor).not.toHaveBeenCalled();
    expect(managedRuntime.close).toHaveBeenCalledOnce();
  });

  it.each(["concurrent turn", "oversized frame"] as const)(
    "aborts before closing on %s",
    async (failure) => {
      const harness = managedHarness();
      const started = waitForRuntimeAbort();
      const running = runWorkerCommand({ ...harness, managed: true });
      harness.turn();
      const signal = await started;
      const rejected = expect(running).rejects.toThrow(
        failure === "concurrent turn" ? "already active" : "exceeds the protocol payload limit",
      );
      if (failure === "concurrent turn") {
        harness.turn(makeLaunch({ turnId: "turn-2" }, harness.launch));
      } else {
        harness.input.write(
          Buffer.concat([
            Buffer.from(
              serializeWorkerProcessInput({
                type: "cancel",
                turnId: harness.launch.assignment.turnId,
              }),
            ),
            Buffer.alloc(WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES + 1, 120),
          ]),
        );
      }
      await rejected;
      if (failure === "concurrent turn") {
        expect(signal.aborted).toBe(true);
      } else {
        expect(signal.reason).toMatchObject({ message: "worker turn cancelled" });
      }
      expect(harness.results).toEqual([]);
      expect(managedRuntime.close).toHaveBeenCalledOnce();
    },
  );

  it("bounds an unterminated managed input line before attempting admission", async () => {
    const harness = managedHarness();
    const running = runWorkerCommand({ ...harness, managed: true });
    const rejected = expect(running).rejects.toThrow("exceeds the protocol payload limit");
    harness.input.write(Buffer.alloc(WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES + 1, 120));
    await rejected;
    expect(runWorkerDescriptor).not.toHaveBeenCalled();
    expect(createWorkerRuntimeEnvironment).not.toHaveBeenCalled();
  });

  it("handles a turn and its cancellation in the same input chunk", async () => {
    const harness = managedHarness();
    const running = runWorkerCommand({ ...harness, managed: true });
    harness.input.write(
      serializeWorkerProcessInput(buildWorkerProcessTurn(harness.launch)) +
        serializeWorkerProcessInput({ type: "cancel", turnId: harness.launch.assignment.turnId }),
    );

    await running;

    expect(runWorkerDescriptor).toHaveBeenCalledOnce();
    expect(vi.mocked(runWorkerDescriptor).mock.calls[0]?.[1]?.signal?.reason).toMatchObject({
      message: "worker turn cancelled",
    });
  });

  it.each(["standalone", "managed"] as const)(
    "preserves ordinary two-image input through the %s parser",
    async (mode) => {
      const harness = managedHarness();
      harness.launch.assignment.suppressPromptTranscript = true;
      harness.launch.assignment.prompt = [
        { type: "text", text: "Compare images" },
        { type: "image", mimeType: "image/png", data: "A".repeat(1_200_000) },
        { type: "image", mimeType: "image/png", data: "B".repeat(1_200_000) },
      ];
      const running = runWorkerCommand({ ...harness, managed: mode === "managed" });
      if (mode === "managed") {
        harness.input.write(serializeWorkerProcessInput(buildWorkerProcessTurn(harness.launch)));
      } else {
        harness.input.end(JSON.stringify(harness.launch));
      }
      await running;
      expect(runWorkerDescriptor).toHaveBeenCalledOnce();
      const prompt = vi.mocked(runWorkerDescriptor).mock.calls[0]?.[0].assignment.prompt;
      expect(prompt).toEqual(harness.launch.assignment.prompt);
    },
  );

  it.each(["standalone", "managed"] as const)(
    "enforces %s input at cap + 1 bytes",
    async (mode) => {
      const harness = managedHarness();
      const prefix = "wss://worker.invalid/";
      const suffix = "/__openclaw__/worker";
      harness.launch.connectionEndpoint = {
        kind: "websocket",
        url: prefix + "\0".repeat(4_096 - prefix.length - suffix.length) + suffix,
        tlsFingerprint: "a".repeat(64),
        cloudflareAccess: { clientId: "\0".repeat(4_096), clientSecret: "\0".repeat(4_096) },
      };
      harness.launch.assignment.systemPrompt = '"\\\0\n漢😀'.repeat(100);
      const encode = () =>
        `${JSON.stringify(mode === "managed" ? buildWorkerProcessTurn(harness.launch) : harness.launch)}\n`;
      const targetBytes = WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES + 1;
      const delimiterBytes = mode === "managed" ? 1 : 0;
      harness.launch.assignment.systemPrompt += "x".repeat(
        targetBytes + delimiterBytes - Buffer.byteLength(encode()),
      );
      const encoded = encode();
      expect(Buffer.byteLength(encoded) - delimiterBytes).toBe(targetBytes);
      if (mode === "managed") {
        expect(() => serializeWorkerProcessInput(buildWorkerProcessTurn(harness.launch))).toThrow(
          "exceeds the protocol payload limit",
        );
      }
      const running = runWorkerCommand({ ...harness, managed: mode === "managed" });
      const outcome = expect(running).rejects.toThrow("exceeds the protocol payload limit");
      if (mode === "managed") {
        // Raw input independently verifies the receiver, including serializer-rejected bytes.
        const bytes = Buffer.from(encoded);
        const split = bytes.indexOf(Buffer.from("漢")) + 1;
        harness.input.write(bytes.subarray(0, split));
        harness.input.write(bytes.subarray(split));
      } else {
        harness.input.end(encoded);
      }
      await outcome;
      expect(runWorkerDescriptor).not.toHaveBeenCalled();
    },
  );
});
