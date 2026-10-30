import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  commandSuccess,
  commandGate,
  createGmailConfig,
  WatcherChild,
} from "./gmail.test-support.js";

const mocks = vi.hoisted(() => ({
  ensureDependency: vi.fn(),
  ensureTailscaleEndpoint: vi.fn(),
  readRuntimeConfig: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  killProcessTree: vi.fn(),
  spawn: vi.fn(),
  log: { debug: vi.fn(), trace: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  defaultRuntime: { log: vi.fn(), error: vi.fn(), writeJson: vi.fn(), exit: vi.fn() },
}));

vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => mocks.log }));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    { spawn: mocks.spawn },
  );
});

// mock-isolation: all command completion and cancellation is controlled by this fixture.
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: mocks.runCommandWithTimeout }));

// mock-isolation: terminate only the fixture's fake child processes.
vi.mock("../process/kill-tree.js", () => ({ killProcessTree: mocks.killProcessTree }));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    captureRuntimeConfigAsyncReader: () => mocks.readRuntimeConfig,
  };
});

// mock-isolation: capture service output and exit instead of affecting this test process.
vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.defaultRuntime }));

vi.mock("./gmail-setup-utils.js", () => ({
  ensureDependency: mocks.ensureDependency,
  ensureGcloudAuth: vi.fn(),
  ensureSubscription: vi.fn(),
  ensureTailscaleEndpoint: mocks.ensureTailscaleEndpoint,
  ensureTopic: vi.fn(),
  resolveProjectIdFromGogCredentials: vi.fn(),
  runGcloud: vi.fn(),
}));

vi.mock("../infra/executable-path.js", () => ({
  resolveExecutable: vi.fn((name: string) => name),
}));

const { runGmailService } = await import("./gmail-ops.js");
const { stopGmailWatcher } = await import("./gmail-watcher.js");

const signals = ["SIGINT", "SIGTERM"] as const;

let children: WatcherChild[];
let signalBaselines: Map<(typeof signals)[number], ReturnType<typeof process.rawListeners>>;

function shutdownHandler(signal: (typeof signals)[number]) {
  const added = process
    .rawListeners(signal)
    .filter((fn) => !signalBaselines.get(signal)?.includes(fn));
  expect(added).toHaveLength(1);
  return () => added[0]!(signal);
}

function expectStopped() {
  for (const signal of signals) {
    expect(process.rawListeners(signal)).toEqual(signalBaselines.get(signal));
  }
  expect(children.filter((child) => child.alive)).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  signalBaselines = new Map(signals.map((signal) => [signal, process.rawListeners(signal)]));
  children = [];
  mocks.ensureDependency.mockReset().mockResolvedValue(undefined);
  mocks.ensureTailscaleEndpoint.mockReset().mockResolvedValue(undefined);
  mocks.readRuntimeConfig.mockResolvedValue(createGmailConfig(undefined, 1, { mode: "off" }));
  mocks.runCommandWithTimeout.mockReset().mockResolvedValue(commandSuccess);
  mocks.spawn.mockReset().mockImplementation(() => {
    const child = new WatcherChild(9000 + children.length);
    children.push(child);
    return child;
  });
  mocks.killProcessTree.mockImplementation((pid: number) => {
    const child = children.find((candidate) => candidate.pid === pid);
    if (child?.alive) {
      queueMicrotask(() => child.exit(null, "SIGTERM"));
    }
  });
});

afterEach(async () => {
  try {
    const handler = process
      .rawListeners("SIGINT")
      .find((fn) => !signalBaselines.get("SIGINT")?.includes(fn));
    handler?.("SIGINT");
    await vi.advanceTimersByTimeAsync(10_000);
    await stopGmailWatcher();
    expectStopped();
  } finally {
    vi.useRealTimers();
  }
});

it.each(["rejected renewal", "timed-out registration"])(
  "keeps serving and renewing after %s",
  async (failure) => {
    if (failure === "rejected renewal") {
      mocks.runCommandWithTimeout
        .mockResolvedValueOnce(commandSuccess)
        .mockRejectedValueOnce(new Error("renewal failed"));
    } else {
      mocks.runCommandWithTimeout.mockResolvedValue({
        code: 124,
        signal: "SIGTERM",
        killed: true,
        termination: "timeout",
        stdout: `${"x".repeat(30_000)}\nregistration stdout tail`,
        stderr: `${"noise\n".repeat(1000)}\u001b[31mregistration stderr tail\u001b[0m`,
      });
    }
    await runGmailService({});
    await vi.advanceTimersByTimeAsync(120_000);
    expect(children.filter((child) => child.alive)).toHaveLength(1);
    expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(3);
    if (failure === "timed-out registration") {
      expect(mocks.log.error).toHaveBeenCalledTimes(3);
      const [message] = mocks.log.error.mock.calls[0]!;
      expect(message.length).toBeLessThan(2000);
      expect(message).toContain("gog gmail watch start failed");
      expect(message).toContain("termination=timeout");
      expect(message).toContain("code=124");
      expect(message).toContain("signal=SIGTERM");
      expect(message).toContain("registration stdout tail");
      expect(message).toContain("registration stderr tail");
      expect(message).not.toContain("\u001b");
    }
  },
);

it("keeps renewal single-flight and cancels it on shutdown", async () => {
  const renewal = commandGate(0);
  mocks.runCommandWithTimeout
    .mockResolvedValueOnce(commandSuccess)
    .mockImplementationOnce((_args, options: { signal: AbortSignal }) => renewal.run(options));
  await runGmailService({});
  await vi.advanceTimersByTimeAsync(120_000);
  expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(2);
  shutdownHandler("SIGTERM")();
  expect(renewal.signal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(2);
  expect(children[0]?.alive).toBe(false);
  expectStopped();
});

it.each([
  { signal: "SIGINT", phase: "replacement" },
  { signal: "SIGTERM", phase: "restart delay" },
] as const)(
  "$signal stops the watcher during $phase without restarting or renewing",
  async ({ signal, phase }) => {
    await runGmailService({});
    children[0]!.exit();
    await vi.advanceTimersByTimeAsync(phase === "replacement" ? 5_000 : 1_000);
    const countAtShutdown = children.length;
    const shutdown = shutdownHandler(signal);
    shutdown();
    shutdown();
    shutdownHandler(signal === "SIGINT" ? "SIGTERM" : "SIGINT")();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(countAtShutdown);
    expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(1);
    expect(mocks.killProcessTree).toHaveBeenCalledTimes(
      (process.platform === "win32" ? 0 : 1) + (phase === "replacement" ? 1 : 0),
    );
    if (phase === "replacement") {
      expect(mocks.killProcessTree).toHaveBeenCalledWith(
        children[1]!.pid,
        expect.objectContaining({ graceMs: 3_000 }),
      );
      expect(children[1]?.alive).toBe(false);
    }
    expectStopped();
  },
);

it.each([
  { signal: "SIGINT", boundary: "tailscale" },
  { signal: "SIGTERM", boundary: "watch" },
] as const)(
  "$signal cancels in-flight $boundary startup without a late child",
  async ({ signal, boundary }) => {
    const pending = commandGate();
    if (boundary === "tailscale") {
      mocks.ensureTailscaleEndpoint.mockImplementation(pending.run);
    } else {
      mocks.runCommandWithTimeout.mockImplementation((_args, options: { signal: AbortSignal }) =>
        pending.run(options),
      );
    }
    const starting = runGmailService({ tailscale: boundary === "tailscale" ? "serve" : "off" });
    await vi.advanceTimersByTimeAsync(0);
    expect(pending.signal).toBeDefined();
    shutdownHandler(signal)();
    expect(pending.signal?.aborted).toBe(true);
    pending.resolve(commandSuccess);
    await starting;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(0);
    expectStopped();
    expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(boundary === "tailscale" ? 0 : 1);
  },
);

it.each(["tailscale", "spawn"])("cleans up signals after %s startup failure", async (boundary) => {
  if (boundary === "tailscale") {
    mocks.ensureTailscaleEndpoint.mockRejectedValueOnce(new Error("fixture setup failed"));
  } else {
    mocks.spawn.mockImplementationOnce(() => {
      throw new Error("fixture setup failed");
    });
  }
  await expect(
    runGmailService({ tailscale: boundary === "tailscale" ? "serve" : "off" }),
  ).rejects.toThrow("fixture setup failed");
  expect(children).toHaveLength(0);
  expectStopped();
});
