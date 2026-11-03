import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  commandSuccess,
  gogSchemaSuccess,
  gogServeSchema,
  commandGate,
  createGmailConfig,
  WatcherChild,
} from "./gmail.test-support.js";

const mocks = vi.hoisted(() => ({
  ensureDependency: vi.fn(),
  ensureTailscaleEndpoint: vi.fn(),
  readRuntimeConfig: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  runUtf8CommandWithTimeout: vi.fn(),
  killProcessTree: vi.fn(),
  spawn: vi.fn(),
  confirm: vi.fn(),
  log: { debug: vi.fn(), trace: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  defaultRuntime: { log: vi.fn(), error: vi.fn(), writeJson: vi.fn(), exit: vi.fn() },
}));

vi.mock("@clack/prompts", () => ({
  confirm: mocks.confirm,
  isCancel: (value: unknown) => typeof value === "symbol",
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
vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
  runUtf8CommandWithTimeout: mocks.runUtf8CommandWithTimeout,
}));

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

const ttyDescriptors = [process.stdin, process.stdout].map((stream) =>
  Object.getOwnPropertyDescriptor(stream, "isTTY"),
);
function setTty(value: boolean) {
  for (const stream of [process.stdin, process.stdout]) {
    Object.defineProperty(stream, "isTTY", { value, configurable: true });
  }
}
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
  setTty(false);
  mocks.confirm.mockReset().mockResolvedValue(false);
  signalBaselines = new Map(signals.map((signal) => [signal, process.rawListeners(signal)]));
  children = [];
  mocks.ensureDependency.mockReset().mockResolvedValue(undefined);
  mocks.ensureTailscaleEndpoint.mockReset().mockResolvedValue(undefined);
  mocks.readRuntimeConfig.mockResolvedValue(createGmailConfig(undefined, 1, { mode: "off" }));
  mocks.runCommandWithTimeout.mockReset().mockResolvedValue(commandSuccess);
  mocks.runUtf8CommandWithTimeout.mockReset().mockResolvedValue(gogSchemaSuccess);
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
    [process.stdin, process.stdout].forEach((stream, index) => {
      const descriptor = ttyDescriptors[index];
      if (descriptor) {
        Object.defineProperty(stream, "isTTY", descriptor);
      } else {
        Reflect.deleteProperty(stream, "isTTY");
      }
    });
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
    const service = runGmailService({});
    await vi.advanceTimersByTimeAsync(0);
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
    shutdownHandler("SIGTERM")();
    await vi.advanceTimersByTimeAsync(8_000);
    await service;
  },
);

it("keeps renewal single-flight and cancels it on shutdown", async () => {
  const renewal = commandGate(0);
  mocks.runCommandWithTimeout
    .mockResolvedValueOnce(commandSuccess)
    .mockImplementationOnce((_args, options: { signal: AbortSignal }) => renewal.run(options));
  const service = runGmailService({});
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(2);
  shutdownHandler("SIGTERM")();
  expect(renewal.signal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(2);
  expect(children[0]?.alive).toBe(false);
  await service;
  expectStopped();
});

it.each([
  { signal: "SIGINT", phase: "replacement" },
  { signal: "SIGTERM", phase: "restart delay" },
] as const)(
  "$signal stops the watcher during $phase without restarting or renewing",
  async ({ signal, phase }) => {
    const service = runGmailService({});
    await vi.advanceTimersByTimeAsync(0);
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
    await service;
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

it.each(["usage", "early usage", "usage after retry", "spawn", "bind"])(
  "settles foreground failure on %s",
  async (failure) => {
    if (failure === "spawn") {
      mocks.spawn.mockImplementationOnce(() => {
        const child = new WatcherChild();
        children.push(child);
        queueMicrotask(() => {
          child.alive = false;
          child.emit("error", new Error("ENOENT"));
          child.emit("close", -2);
        });
        return child;
      });
    }
    if (failure === "early usage") {
      mocks.spawn.mockImplementationOnce(() => {
        const child = new WatcherChild(9000);
        children.push(child);
        queueMicrotask(() => child.exit(2));
        return child;
      });
    }
    const service = runGmailService({});
    const rejected = expect(service).rejects.toThrow(/Gog/);
    await vi.advanceTimersByTimeAsync(0);
    if (failure === "usage after retry") {
      children[0]!.exit(1);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    if (failure === "bind") {
      for (const delay of [5_000, 10_000, 20_000, 0]) {
        const child = children[children.length - 1]!;
        child.stderr.emit("data", Buffer.from("EADDRINUSE"));
        child.exit(1);
        await vi.advanceTimersByTimeAsync(delay);
      }
    } else if (!["spawn", "early usage"].includes(failure)) {
      children[children.length - 1]!.exit(2);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(mocks.runCommandWithTimeout).toHaveBeenCalledOnce();
    expect(mocks.runUtf8CommandWithTimeout).toHaveBeenCalledOnce();
    expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
    expectStopped();
  },
);

it.each(["non-tty", "no", "cancel", "yes", "durable", "supported", "invalid"])(
  "handles legacy foreground consent: %s",
  async (mode) => {
    setTty(mode !== "non-tty");
    const config = createGmailConfig(undefined, 1, { mode: "off" });
    config.hooks!.gmail!.allowInsecureTokenArgs = mode === "durable" || mode === "invalid";
    mocks.readRuntimeConfig.mockResolvedValue(config);
    mocks.confirm.mockResolvedValue(
      mode === "yes" ? true : mode === "cancel" ? Symbol("cancel") : false,
    );
    mocks.runUtf8CommandWithTimeout.mockResolvedValue({
      ...commandSuccess,
      stdout:
        mode === "invalid"
          ? "invalid"
          : JSON.stringify(gogServeSchema(mode === "supported" ? undefined : [])),
    });
    const service = runGmailService({});
    const launched = ["yes", "durable", "supported"].includes(mode);
    const completion = launched
      ? service
      : expect(service).rejects.toThrow(/Upgrade Gog|compatibility check/);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.confirm).toHaveBeenCalledTimes(["no", "cancel", "yes"].includes(mode) ? 1 : 0);
    if (["no", "cancel", "yes"].includes(mode)) {
      expect(mocks.confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          initialValue: false,
          signal: expect.any(AbortSignal),
          message: expect.stringContaining("BOTH"),
        }),
      );
    }
    expect(children).toHaveLength(launched ? 1 : 0);
    if (launched) {
      shutdownHandler("SIGINT")();
      await vi.advanceTimersByTimeAsync(8_000);
    }
    await completion;
    expect(config.hooks!.gmail!.allowInsecureTokenArgs).toBe(
      mode === "durable" || mode === "invalid",
    );
    expectStopped();
  },
);

it("cancels a pending foreground prompt without launching or persisting permission", async () => {
  setTty(true);
  mocks.runUtf8CommandWithTimeout.mockResolvedValue({
    ...commandSuccess,
    stdout: JSON.stringify(gogServeSchema([])),
  });
  let promptSignal: AbortSignal | undefined;
  mocks.confirm.mockImplementation(
    ({ signal }: { signal: AbortSignal }) =>
      new Promise((resolve) => {
        promptSignal = signal;
        signal.addEventListener("abort", () => resolve(Symbol("cancel")), { once: true });
      }),
  );
  const service = runGmailService({});
  await vi.advanceTimersByTimeAsync(0);
  expect(promptSignal?.aborted).toBe(false);
  shutdownHandler("SIGTERM")();
  await service;
  expect(promptSignal?.aborted).toBe(true);
  expect(mocks.spawn).not.toHaveBeenCalled();
  expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();
  expectStopped();
});
