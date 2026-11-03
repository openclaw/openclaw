import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import {
  commandSuccess,
  gogSchemaSuccess,
  gogServeSchema,
  commandGate,
  createGmailConfig,
  WatcherChild,
} from "./gmail.test-support.js";

let allChildren: WatcherChild[];

const mocks = vi.hoisted(() => ({
  hasBinary: vi.fn(() => true),
  resolveExecutable: vi.fn((name: string) => name),
  runCommandWithTimeout: vi.fn(),
  runUtf8CommandWithTimeout: vi.fn(),
  spawn: vi.fn(),
  ensureTailscaleEndpoint: vi.fn(),
  log: { debug: vi.fn(), trace: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  killProcessTree: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    { spawn: mocks.spawn },
  );
});

// mock-isolation: binary availability belongs to the controlled watcher fixture.
vi.mock("../skills/loading/config.js", () => ({ hasBinary: mocks.hasBinary }));

// mock-isolation: resolve synthetic executables without inspecting host installations.
vi.mock("../infra/executable-path.js", () => ({ resolveExecutable: mocks.resolveExecutable }));

// mock-isolation: command completion is driven by the fixture, not real tools.
vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
  runUtf8CommandWithTimeout: mocks.runUtf8CommandWithTimeout,
}));

// mock-isolation: terminate only the fixture's fake child processes.
vi.mock("../process/kill-tree.js", () => ({ killProcessTree: mocks.killProcessTree }));

vi.mock("./gmail-setup-utils.js", () => ({
  ensureTailscaleEndpoint: mocks.ensureTailscaleEndpoint,
}));
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => mocks.log }));

const { startGmailWatcher, stopGmailWatcher } = await import("./gmail-watcher.js");

let nextMockPid = 1234;

function createMockWatcherChild(spawned = true) {
  const child = new WatcherChild(spawned ? nextMockPid++ : undefined);
  allChildren.push(child);
  return child;
}

function startWatcher(
  config = createGmailConfig(),
  options: Partial<Parameters<typeof startGmailWatcher>[1]> = {},
) {
  return startGmailWatcher(config, {
    ...options,
    scheduler: options.scheduler ?? createTestGatewayScheduler(),
  });
}

async function startMockWatcher(
  spawned = true,
  config = createGmailConfig(),
  options: Partial<Parameters<typeof startGmailWatcher>[1]> = {},
) {
  mocks.runCommandWithTimeout.mockResolvedValue(commandSuccess);
  mocks.spawn.mockImplementation(() => createMockWatcherChild(spawned));
  await startWatcher(config, options);
  return allChildren;
}

const childAt = (children: WatcherChild[], index = 0) =>
  expectDefined(children[index], "watcher child");

async function stopChildren(children: WatcherChild[]) {
  const stopping = stopGmailWatcher();
  await vi.advanceTimersByTimeAsync(8_000);
  await stopping;
  for (const child of children) {
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

beforeEach(async () => {
  // Retire the previous test's children before replacing its process registry.
  await stopGmailWatcher();
  vi.useFakeTimers();
  allChildren = [];
  mocks.ensureTailscaleEndpoint.mockReset();
  Object.values(mocks.log).forEach((fn) => fn.mockClear());
  mocks.runCommandWithTimeout.mockReset();
  mocks.runUtf8CommandWithTimeout.mockReset().mockResolvedValue(gogSchemaSuccess);
  mocks.spawn.mockReset();
  mocks.killProcessTree.mockReset().mockImplementation((pid: number) => {
    const child = allChildren.find((candidate) => candidate.pid === pid);
    if (child) {
      queueMicrotask(() => child.emit("close", 0, null));
    }
  });
  mocks.spawn.mockImplementation(() => createMockWatcherChild(false));
});

afterEach(async () => {
  try {
    await stopChildren(allChildren);
  } finally {
    vi.useRealTimers();
  }
});

it("does not let a stale cancelled startup clear newer watcher config", async () => {
  const oldController = new AbortController();
  const oldWatchStart = createDeferred<typeof commandSuccess>();
  const spawnedChildren = allChildren;
  mocks.runCommandWithTimeout
    .mockReturnValueOnce(oldWatchStart.promise)
    .mockResolvedValue(commandSuccess);

  const staleStart = startWatcher(createGmailConfig(), { signal: oldController.signal });
  await vi.advanceTimersByTimeAsync(0);

  await expect(startWatcher(createGmailConfig("newer@example.com"))).resolves.toEqual({
    started: true,
  });

  oldController.abort();
  oldWatchStart.resolve(commandSuccess);
  await expect(staleStart).resolves.toEqual({ started: false, reason: "startup cancelled" });

  spawnedChildren[0]?.emit("close", 1, null);
  await vi.advanceTimersByTimeAsync(5000);

  expect(mocks.spawn).toHaveBeenCalledTimes(2);
  expect(mocks.spawn.mock.calls[1]?.[1]).toContain("newer@example.com");
});

it("renews once after multiple starts and coalesces missed renewals after sleep", async () => {
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  mocks.runCommandWithTimeout.mockResolvedValue(commandSuccess);
  await startWatcher(createGmailConfig(), { scheduler });
  await startWatcher(createGmailConfig(), { scheduler });
  expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(2);

  await clock.advanceBy(720 * 60_000);
  expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(3);
  await clock.advanceBy(3 * 720 * 60_000);
  expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(4);
  await stopGmailWatcher();
  await clock.advanceBy(720 * 60_000);
  expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(4);
});

it.each(["watcher", "scheduler"])(
  "retires a stalled renewal on %s stop before replacement",
  async (stopOwner) => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const stalled = commandGate(1);
    mocks.runCommandWithTimeout
      .mockResolvedValueOnce(commandSuccess)
      .mockImplementationOnce((_args, options: { signal?: AbortSignal }) => stalled.run(options))
      .mockResolvedValue(commandSuccess);

    await startWatcher(createGmailConfig("old@example.com", 1), { scheduler });
    const tick = clock.advanceBy(60_000);
    expect(stalled.signal?.aborted).toBe(false);

    if (stopOwner === "scheduler") {
      await scheduler.stop();
    }
    await stopGmailWatcher();
    await tick;
    expect(stalled.signal?.aborted).toBe(true);

    await startWatcher(createGmailConfig("new@example.com", 1), {
      scheduler: createTestGatewayScheduler(clock.clock),
    });
    await clock.advanceBy(60_000);

    expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(4);
    expect(mocks.runCommandWithTimeout.mock.calls[3]?.[0]).toContain("new@example.com");
  },
);

it("cancels stale respawn timeout when re-entry happens during 5s window", async () => {
  const spawnedChildren = await startMockWatcher(false);
  expect(spawnedChildren).toHaveLength(1);

  childAt(spawnedChildren).emit("close", 1, null);

  await startWatcher();
  expect(spawnedChildren).toHaveLength(2);

  await vi.advanceTimersByTimeAsync(6000);
  expect(spawnedChildren).toHaveLength(2);
});

it("ignores a retired child's late close while replacement startup is pending", async () => {
  const pendingStart = createDeferred<typeof commandSuccess>();
  const children = await startMockWatcher();
  mocks.killProcessTree.mockImplementation(() => {});
  mocks.runCommandWithTimeout.mockImplementationOnce(() => pendingStart.promise);
  const restarting = startWatcher(createGmailConfig("new@example.com"));
  try {
    await vi.advanceTimersByTimeAsync(8_000);
    childAt(children).exit(1, null);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(children).toHaveLength(1);
    expect(mocks.killProcessTree).toHaveBeenCalledTimes(1);
    pendingStart.resolve(commandSuccess);
    await restarting;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(children).toHaveLength(2);
    expect(mocks.spawn.mock.calls[1]?.[1]).toContain("new@example.com");
  } finally {
    pendingStart.resolve(commandSuccess);
    await restarting;
  }
});

it("preserves the shutdown grace period when the watcher exits before its descendants", async () => {
  mocks.runCommandWithTimeout.mockResolvedValue(commandSuccess);
  const child = createMockWatcherChild();
  mocks.spawn.mockReturnValueOnce(child);
  mocks.killProcessTree.mockImplementation(() => {
    queueMicrotask(() => child.exit(0, null));
  });

  await startWatcher();
  let stopped = false;
  const stopping = stopGmailWatcher().then(() => {
    stopped = true;
  });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(stopped).toBe(false);
  await vi.advanceTimersByTimeAsync(25);
  await stopping;

  expect(mocks.killProcessTree).toHaveBeenCalledExactlyOnceWith(
    child.pid,
    expect.objectContaining({ graceMs: 3_000 }),
  );
  expect(child.kill).not.toHaveBeenCalled();
});

it.each(["darwin", "win32"] as const)(
  "restarts initial and replacement children with inherited pipes on %s",
  async (platform) => {
    await withMockedPlatform(platform, async () => {
      const children = await startMockWatcher();
      // Descendants keep both pipes open after exit, even if tree cleanup fails.
      mocks.killProcessTree.mockImplementation(() => {});
      try {
        for (let index = 0; index < 2; index++) {
          const child = childAt(children, index);
          let closedStreams = 0;
          for (const stream of [child.stdout, child.stderr]) {
            stream.once("close", () => {
              if (++closedStreams === 2) {
                child.emit("close", null, "SIGKILL");
              }
            });
          }
          child.emit("exit", null, "SIGKILL");
          await vi.advanceTimersByTimeAsync(6_100);
          expect(children).toHaveLength(index + 2);
          expect(child).toMatchObject({
            stdout: { destroyed: true },
            stderr: { destroyed: true },
          });
          if (platform === "win32") {
            expect(mocks.killProcessTree).not.toHaveBeenCalled();
          } else {
            expect(mocks.killProcessTree).toHaveBeenCalledTimes(index + 1);
            expect(mocks.killProcessTree).toHaveBeenLastCalledWith(child.pid, {
              force: true,
              detached: true,
            });
          }
        }
        await vi.advanceTimersByTimeAsync(6_000);
        expect(children).toHaveLength(3);
      } finally {
        await stopChildren(children);
      }
    });
  },
);

it("does not taskkill an exited Windows child while inherited pipes drain", async () => {
  await withMockedPlatform("win32", async () => {
    const children = await startMockWatcher();
    const child = childAt(children);
    Object.assign(child, { exitCode: 1, signalCode: null });
    child.emit("exit", 1, null);
    const stopping = stopGmailWatcher();
    await vi.advanceTimersByTimeAsync(8_000);
    await stopping;
    expect(mocks.killProcessTree).not.toHaveBeenCalled();
    expect(child).toMatchObject({ stdout: { destroyed: true }, stderr: { destroyed: true } });
    expect(children).toHaveLength(1);
  });
});

it("swallows stdout and stderr stream errors during startup without crashing", async () => {
  mocks.runCommandWithTimeout.mockResolvedValue(commandSuccess);
  mocks.spawn.mockImplementation(() => {
    const child = createMockWatcherChild(false);
    queueMicrotask(() => {
      child.stdout.emit("error", new Error("stdout read failed"));
      child.stderr.emit("error", new Error("stderr read failed"));
    });
    return child;
  });
  await expect(startWatcher()).resolves.toEqual({ started: true });
});

it.each([
  { name: "failed spawn", spawned: false, expectedChildren: 1 },
  { name: "error from a running child", spawned: true, expectedChildren: 2 },
  { name: "bind conflict", spawned: true, expectedChildren: 2 },
])("handles $name without losing restart policy", async ({ name, spawned, expectedChildren }) => {
  const children = await startMockWatcher(spawned);
  const child = childAt(children);
  if (name === "bind conflict") {
    child.stderr.emit("data", Buffer.from("listen: EADDRINUSE"));
  }
  child.emit("error", new Error(spawned ? "gog stream error" : "spawn gog ENOENT"));
  child.emit("close", name === "bind conflict" ? 2 : spawned ? 1 : -2, null);

  await vi.advanceTimersByTimeAsync(6000);
  expect(children).toHaveLength(expectedChildren);
  if (name === "bind conflict") {
    childAt(children, 1).stderr.emit("data", Buffer.from("listen: EADDRINUSE"));
    childAt(children, 1).emit("close", 1, null);
    await stopGmailWatcher();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(2);
  }
});

it("bounds bind retries despite late oversized stderr and keeps renewing after exhaustion", async () => {
  const children = await startMockWatcher(true, createGmailConfig(undefined, 1), {
    scheduler: createTestGatewayScheduler("fake-timers"),
  });
  children[0]!.exit();
  await vi.advanceTimersByTimeAsync(5_000);
  for (const delayMs of [5_000, 10_000, 20_000, 60_000]) {
    const child = childAt(children, children.length - 1);
    child.stderr.emit("data", Buffer.from("address alre"));
    child.alive = false;
    child.emit("exit", 1, null);
    child.stderr.emit("data", Buffer.from(`ady in use ${"x".repeat(800)}`));
    child.emit("close", 1, null);
    await vi.advanceTimersByTimeAsync(delayMs);
  }
  expect(children).toHaveLength(5);
  expect(children.filter((child) => child.alive)).toHaveLength(0);
  expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(2);
});

it.each(["token-env", "hook-token-env", "both"])(
  "requires consent when schema lacks %s",
  async (missing) => {
    const flags = ["token-env", "hook-token-env"].filter(
      (name) => missing !== "both" && name !== missing,
    );
    mocks.runUtf8CommandWithTimeout.mockResolvedValue({
      ...commandSuccess,
      stdout: JSON.stringify(gogServeSchema(flags)),
    });
    const config = createGmailConfig(undefined, 1, { mode: "serve" });
    const confirm = vi.fn().mockResolvedValue(false);
    expect((await startWatcher(config, { confirmInsecureTokenArgs: confirm })).started).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();
    expect(mocks.ensureTailscaleEndpoint).not.toHaveBeenCalled();
  },
);

it.each([
  "bad-json",
  "version",
  "command",
  "name",
  "flags",
  "duplicate",
  "literal",
  "env-type",
  "exit",
  "signal",
  "timeout",
  "limit",
  "truncated",
  "spawn",
])("never downgrades an indeterminate schema check: %s", async (failure) => {
  const schema = gogServeSchema();
  const result = { ...gogSchemaSuccess };
  if (failure === "version") {
    schema.schema_version = 2;
  }
  if (failure === "command") {
    schema.command.type = "argument";
  }
  if (failure === "name") {
    schema.command.name = "start";
  }
  if (failure === "duplicate") {
    schema.command.flags.push({ name: "token", type: "string" });
  }
  if (failure === "literal") {
    schema.command.flags = schema.command.flags.filter((flag) => flag.name !== "token");
  }
  if (failure === "env-type") {
    schema.command.flags.find((flag) => flag.name === "token-env")!.type = "bool";
  }
  result.stdout =
    failure === "bad-json"
      ? "not json"
      : failure === "flags"
        ? JSON.stringify({ ...schema, command: { ...schema.command, flags: [null] } })
        : JSON.stringify(schema);
  mocks.runUtf8CommandWithTimeout.mockResolvedValue({
    ...result,
    ...(failure === "exit" ? { code: 1 } : {}),
    ...(failure === "signal" ? { signal: "SIGTERM" } : {}),
    ...(failure === "timeout" ? { termination: "timeout" } : {}),
    ...(failure === "limit" ? { outputLimitExceeded: true } : {}),
    ...(failure === "truncated" ? { stdoutTruncatedBytes: 1 } : {}),
  });
  if (failure === "spawn") {
    mocks.runUtf8CommandWithTimeout.mockRejectedValue(new Error("private diagnostic"));
  }
  const config = createGmailConfig();
  config.hooks!.gmail!.allowInsecureTokenArgs = true;
  const confirm = vi.fn().mockResolvedValue(true);
  const resultStart = await startWatcher(config, { confirmInsecureTokenArgs: confirm });
  expect(resultStart).toMatchObject({
    started: false,
    reason: expect.stringContaining("compatibility check failed"),
  });
  expect(resultStart.reason).not.toContain("private diagnostic");
  expect(confirm).not.toHaveBeenCalled();
  expect(mocks.runCommandWithTimeout).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it.each([false, true])(
  "prefers env and isolates credentials across retries with permission=%s",
  async (permission) => {
    vi.stubEnv("OPENCLAW_GOG_WATCH_PUSH_TOKEN", "inherited-push");
    vi.stubEnv("OPENCLAW_GOG_WATCH_HOOK_TOKEN", "inherited-hook");
    try {
      const config = createGmailConfig();
      config.hooks!.gmail!.allowInsecureTokenArgs = permission;
      const confirm = vi.fn().mockResolvedValue(true);
      const children = await startMockWatcher(true, config, { confirmInsecureTokenArgs: confirm });
      for (const diagnostic of ["transient", "EADDRINUSE"]) {
        childAt(children, children.length - 1).stderr.emit("data", Buffer.from(diagnostic));
        childAt(children, children.length - 1).exit(1);
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(children).toHaveLength(3);
      for (const [, args, options] of mocks.spawn.mock.calls) {
        expect(args).toEqual(expect.arrayContaining(["--token-env", "--hook-token-env"]));
        expect(args).not.toContain("push-token");
        expect(args).not.toContain("hook-token");
        expect(options.env).toMatchObject({
          OPENCLAW_GOG_WATCH_PUSH_TOKEN: "push-token",
          OPENCLAW_GOG_WATCH_HOOK_TOKEN: "hook-token",
          PATH: process.env.PATH,
        });
      }
      expect(mocks.spawn.mock.calls[0]![2].env).not.toBe(mocks.spawn.mock.calls[1]![2].env);
      expect(process.env.OPENCLAW_GOG_WATCH_PUSH_TOKEN).toBe("inherited-push");
      expect(process.env.OPENCLAW_GOG_WATCH_HOOK_TOKEN).toBe("inherited-hook");
      expect(confirm).not.toHaveBeenCalled();
      expect(mocks.runUtf8CommandWithTimeout).toHaveBeenCalledExactlyOnceWith(
        ["gog", "--json", "--no-input", "schema", "gmail", "watch", "serve"],
        expect.objectContaining({
          timeoutMs: 5_000,
          maxOutputBytes: { stdout: 262144, stderr: 16384 },
          maxCombinedOutputBytes: 278528,
          terminateOnOutputLimit: true,
        }),
      );
      expect(mocks.runCommandWithTimeout.mock.calls[0]![1]).not.toHaveProperty("env");
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it.each(["prompt", "config"])(
  "retains explicit %s legacy consent only for this lifecycle",
  async (source) => {
    mocks.runUtf8CommandWithTimeout.mockResolvedValue({
      ...commandSuccess,
      stdout: JSON.stringify(gogServeSchema([])),
    });
    const config = createGmailConfig();
    config.hooks!.gmail!.allowInsecureTokenArgs = source === "config";
    const confirm = vi.fn().mockResolvedValue(true);
    const children = await startMockWatcher(true, config, { confirmInsecureTokenArgs: confirm });
    for (const diagnostic of ["temporary failure", "EADDRINUSE"]) {
      childAt(children, children.length - 1).stderr.emit("data", Buffer.from(diagnostic));
      childAt(children, children.length - 1).exit(1);
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(mocks.runUtf8CommandWithTimeout).toHaveBeenCalledOnce();
    expect(confirm).toHaveBeenCalledTimes(source === "prompt" ? 1 : 0);
    expect(mocks.log.warn.mock.calls.filter(([line]) => line.includes("BOTH"))).toHaveLength(3);
    for (const [, args, options] of mocks.spawn.mock.calls) {
      expect(args).toEqual(
        expect.arrayContaining(["--token", "push-token", "--hook-token", "hook-token"]),
      );
      expect(options).not.toHaveProperty("env");
    }
    const stopping = stopGmailWatcher();
    await vi.advanceTimersByTimeAsync(8_000);
    await stopping;
    expect((await startWatcher()).started).toBe(false);
  },
);

it.each(
  ["probe", "prompt", "registration"].flatMap((boundary) =>
    ["replacement", "cancellation"].map((outcome) => ({ boundary, outcome })),
  ),
)("rejects pending $boundary startup after $outcome", async ({ boundary, outcome }) => {
  const held = createDeferred<typeof gogSchemaSuccess>();
  const consent = createDeferred<boolean>();
  const controller = new AbortController();
  mocks.runCommandWithTimeout.mockResolvedValue(commandSuccess);
  if (boundary === "probe") {
    mocks.runUtf8CommandWithTimeout.mockReturnValueOnce(held.promise);
  }
  if (boundary === "prompt") {
    mocks.runUtf8CommandWithTimeout.mockResolvedValueOnce({
      ...commandSuccess,
      stdout: JSON.stringify(gogServeSchema([])),
    });
  }
  if (boundary === "registration") {
    mocks.runCommandWithTimeout.mockReturnValueOnce(held.promise);
  }
  const stale = startWatcher(createGmailConfig("old@example.com"), {
    signal: controller.signal,
    confirmInsecureTokenArgs: () => consent.promise,
  });
  await vi.advanceTimersByTimeAsync(0);
  if (outcome === "replacement") {
    expect((await startWatcher(createGmailConfig("new@example.com"))).started).toBe(true);
  } else {
    controller.abort();
  }
  held.resolve(gogSchemaSuccess);
  consent.resolve(true);
  expect(await stale).toEqual({ started: false, reason: "startup cancelled" });
  expect(mocks.spawn).toHaveBeenCalledTimes(outcome === "replacement" ? 1 : 0);
  if (outcome === "replacement") {
    expect(mocks.spawn.mock.calls[0]![1]).toContain("new@example.com");
  }
});

it.each(["usage", "panic", "fatal error", "split panic"])(
  "treats %s exit 2 according to diagnostics",
  async (kind) => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const sibling = vi.fn();
    scheduler.schedule({ id: "sibling", delayMs: 60_000, run: sibling });
    const fatal = vi.fn();
    const children = await startMockWatcher(true, createGmailConfig(undefined, 1), {
      scheduler,
      onFatalError: fatal,
    });
    const child = childAt(children);
    if (kind === "split panic") {
      child.stderr.emit("data", Buffer.from("pa"));
      child.stderr.emit("data", Buffer.from("nic: failure"));
    } else if (kind !== "usage") {
      child.stderr.emit("data", Buffer.from(`${kind}: failure`));
    }
    child.exit(2);
    await vi.advanceTimersByTimeAsync(5_000);
    await clock.advanceBy(60_000);
    expect(sibling).toHaveBeenCalledOnce();
    expect(children).toHaveLength(kind === "usage" ? 1 : 2);
    expect(fatal).toHaveBeenCalledTimes(kind === "usage" ? 1 : 0);
    expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(kind === "usage" ? 1 : 2);
  },
);

it("joins terminal renewal cleanup without retiring a replacement or sibling jobs", async () => {
  const clock = createGatewaySchedulerClock();
  const scheduler = createTestGatewayScheduler(clock.clock);
  const pending = commandGate(0);
  const fatal = vi.fn();
  const children = await startMockWatcher(true, createGmailConfig(undefined, 1), {
    scheduler,
    onFatalError: fatal,
  });
  mocks.runCommandWithTimeout.mockImplementationOnce((_args, options) => pending.run(options));
  const tick = clock.advanceBy(60_000);
  expect(pending.signal?.aborted).toBe(false);
  childAt(children).exit(2);
  expect(pending.signal?.aborted).toBe(true);
  await startWatcher(createGmailConfig("replacement@example.com"), { scheduler });
  await tick;
  childAt(children).emit("close", 2, null);
  childAt(children, 1).exit(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(fatal).toHaveBeenCalledOnce();
  expect(mocks.spawn.mock.calls[2]![1]).toContain("replacement@example.com");
});
