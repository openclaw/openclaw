import { performance } from "node:perf_hooks";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { createProcessSupervisor } from "./supervisor.js";
import {
  createStubChildAdapter,
  createWriteStdoutArgv,
  type StubChildAdapter,
} from "./supervisor.test-support.js";
import type { SpawnInput } from "./types.js";

const { child, pty } = vi.hoisted(() => ({ child: vi.fn(), pty: vi.fn() }));
vi.mock("./adapters/child.js", () => ({
  createChildAdapter: async (
    ...args: Parameters<typeof import("./adapters/child.js").createChildAdapter>
  ) => ({
    adapter: await child(...args),
    ready: Promise.resolve(),
  }),
}));
vi.mock("./adapters/pty.js", () => ({ createPtyAdapter: pty }));

let supervisor: ReturnType<typeof createProcessSupervisor>;
const spawn = (input: Partial<Extract<SpawnInput, { mode: "child" }>> = {}) =>
  supervisor.spawn({ mode: "child", argv: ["fixture"], ...input });
const terminating = () =>
  createStubChildAdapter({
    onKill: (signal, adapter) => adapter.settle(null, signal ?? "SIGTERM"),
  });
function prepare(adapter = createStubChildAdapter()) {
  child.mockResolvedValueOnce(adapter);
  return adapter;
}
function owned() {
  const extinction = createDeferred();
  const adapter = prepare(
    Object.assign(createStubChildAdapter(), {
      waitForExtinction: () => extinction.promise,
    }),
  );
  return { adapter, extinction };
}

beforeEach(() => {
  child.mockReset();
  pty.mockReset();
  supervisor = createProcessSupervisor();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("process supervisor", () => {
  it("passes private secret input and exact environment to the child adapter", async () => {
    const adapter = prepare();
    const secretInput = { fd: 3, createData: () => Buffer.from("secret") };
    const run = await spawn({ argv: createWriteStdoutArgv("ok"), exactEnv: true, secretInput });
    expect(child).toHaveBeenCalledWith(expect.objectContaining({ exactEnv: true, secretInput }));
    adapter.settle(0);
    await run.wait();
  });

  it("coalesces overlapping Windows deadlines while hard kill is pending", async () => {
    vi.useFakeTimers();
    mockProcessPlatform("win32");
    const adapter = prepare();
    const run = await spawn({ timeoutMs: 20, noOutputTimeoutMs: 5 });
    await vi.advanceTimersByTimeAsync(5);
    await vi.advanceTimersToNextTimerAsync();
    expect(adapter.killMock).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(15);
    expect(adapter.killMock).toHaveBeenCalledTimes(1);
    adapter.settle(null, "SIGKILL");
    await expect(run.wait()).resolves.toMatchObject({ reason: "no-output-timeout" });
  });

  it("escalates cancellation without replacing its first reason", async () => {
    vi.useFakeTimers();
    const adapter = prepare(
      createStubChildAdapter({
        onKill: (signal, current) => {
          if (signal === "SIGKILL") {
            current.settle(null, signal);
          }
        },
      }),
    );
    const run = await spawn({ runId: "cancel", scopeKey: "scope", timeoutMs: 1_000 });
    supervisor.cancel("cancel");
    supervisor.cancelScope("scope", "no-output-timeout");
    expect(adapter.killMock).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(4_999);
    expect(adapter.killMock).not.toHaveBeenCalledWith("SIGKILL");
    await vi.advanceTimersByTimeAsync(1);
    await expect(run.wait()).resolves.toMatchObject({
      reason: "manual-cancel",
      exitSignal: "SIGKILL",
      timedOut: false,
    });
    expect(adapter.killMock).toHaveBeenCalledWith("SIGKILL");
    expect(adapter.disposeMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["no-output-timeout", "manual-cancel"] as const)(
    "keeps late construction cleanup joinable after %s",
    async (reason) => {
      vi.useFakeTimers();
      const startup = createDeferred<StubChildAdapter>();
      const extinction = createDeferred();
      child.mockReturnValueOnce(startup.promise);
      const pending = spawn({
        runId: "starting",
        timeoutMs: 25,
        noOutputTimeoutMs: reason === "no-output-timeout" ? 10 : undefined,
      });
      if (reason === "manual-cancel") {
        supervisor.cancel("starting");
      }
      await vi.advanceTimersByTimeAsync(25);
      const run = await pending;
      await expect(run.wait()).resolves.toMatchObject({
        reason,
        timedOut: reason !== "manual-cancel",
        noOutputTimedOut: reason === "no-output-timeout",
      });
      expect(run.activity.resultSettled).toBe(true);
      const drained = vi.fn();
      const shutdown = supervisor.shutdown().then(drained);
      await vi.advanceTimersByTimeAsync(0);
      expect(drained).not.toHaveBeenCalled();
      const adapter = Object.assign(createStubChildAdapter(), {
        waitForExtinction: () => extinction.promise,
      });
      startup.resolve(adapter);
      await vi.advanceTimersByTimeAsync(0);
      expect(adapter.killMock).toHaveBeenCalledWith("SIGKILL");
      expect(adapter.disposeMock).not.toHaveBeenCalled();
      expect(drained).not.toHaveBeenCalled();
      adapter.settle(null, "SIGKILL");
      extinction.resolve();
      await shutdown;
      expect(adapter.disposeMock).toHaveBeenCalledOnce();
    },
  );

  it("fences new runs and drains an unscoped startup during shutdown", async () => {
    const startup = createDeferred<StubChildAdapter>();
    child.mockReturnValueOnce(startup.promise);
    const pending = spawn();
    const shutdown = supervisor.shutdown();
    await expect(spawn()).rejects.toThrow("process supervisor is shut down");
    expect(child).toHaveBeenCalledOnce();
    const adapter = terminating();
    startup.resolve(adapter);
    const run = await pending;
    await shutdown;
    expect(adapter.killMock).toHaveBeenCalledWith("SIGKILL");
    expect(adapter.disposeMock).toHaveBeenCalledOnce();
    await expect(run.wait()).resolves.toMatchObject({ reason: "manual-cancel" });
  });

  it("fences a replacement between all concurrent predecessors and later arrivals", async () => {
    const starts = [createDeferred<StubChildAdapter>(), createDeferred<StubChildAdapter>()];
    const predecessors = [terminating(), terminating()];
    const replacementStart = createDeferred<StubChildAdapter>();
    child
      .mockReturnValueOnce(starts[0]!.promise)
      .mockReturnValueOnce(starts[1]!.promise)
      .mockReturnValueOnce(replacementStart.promise);
    const replacementAdapter = createStubChildAdapter();
    const later = prepare();
    const firstRuns = [spawn({ scopeKey: "scope" }), spawn({ scopeKey: "scope" })];
    const replacement = spawn({ scopeKey: "scope", replaceExistingScope: true });
    const laterRun = spawn({ scopeKey: "scope" });
    expect(child).toHaveBeenCalledTimes(2);
    starts[1]!.resolve(predecessors[1]!);
    await firstRuns[1];
    expect(child).toHaveBeenCalledTimes(2);
    starts[0]!.resolve(predecessors[0]!);
    await Promise.all(firstRuns);
    // Admission reaches the replacement only after both predecessor starts settle.
    const admitted = createDeferred();
    replacementStart.resolve(
      Object.assign(replacementAdapter, {
        onStdout: () => admitted.resolve(),
      }),
    );
    await admitted.promise;
    expect(child).toHaveBeenCalledTimes(3);
    expect(later.killMock).not.toHaveBeenCalled();
    const runs = await Promise.all([...firstRuns, replacement, laterRun]);
    expect(child).toHaveBeenCalledTimes(4);
    for (const adapter of predecessors) {
      expect(adapter.killMock).toHaveBeenCalledWith("SIGTERM");
    }
    expect(replacementAdapter.killMock).not.toHaveBeenCalled();
    expect(later.killMock).not.toHaveBeenCalled();
    replacementAdapter.settle(0);
    later.settle(0);
    await expect(Promise.all(runs.map((run) => run.wait()))).resolves.toEqual([
      expect.objectContaining({ reason: "manual-cancel" }),
      expect.objectContaining({ reason: "manual-cancel" }),
      expect.objectContaining({ reason: "exit" }),
      expect.objectContaining({ reason: "exit" }),
    ]);
  });

  it("continues replacing scoped runs across a failed startup", async () => {
    const first = prepare(terminating());
    child.mockRejectedValueOnce(new Error("adapter could not start"));
    const last = prepare();
    const results = await Promise.allSettled(
      [0, 1, 2].map(() => spawn({ scopeKey: "scope", replaceExistingScope: true })),
    );
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: new Error("adapter could not start"),
    });
    expect(first.killMock).toHaveBeenCalledWith("SIGTERM");
    expect(last.killMock).not.toHaveBeenCalled();
    last.settle(0);
    const exits = await Promise.all(
      results.flatMap((result) => (result.status === "fulfilled" ? [result.value.wait()] : [])),
    );
    expect(exits.map((exit) => exit.reason)).toEqual(["manual-cancel", "exit"]);
  });

  it("never launches cancelled queued replacements or resolves their arguments", async () => {
    const startup = createDeferred<StubChildAdapter>();
    child.mockReturnValueOnce(startup.promise);
    const first = createStubChildAdapter();
    const later = prepare();
    const firstRun = spawn({ scopeKey: "scope" });
    const resolveArgs = vi.fn(() => ["must-not-resolve"]);
    const onCancel = vi.fn();
    const replacements = ["child", "pty"].map((mode, index) => {
      const input: SpawnInput =
        mode === "child"
          ? { mode, argv: ["fixture"], resolveArgs }
          : { mode: "pty", argv: ["fixture"] };
      const pending = supervisor.spawn({
        ...input,
        runId: `queued-${index}`,
        scopeKey: "scope",
        replaceExistingScope: true,
        onCancel,
      });
      supervisor.cancel(`queued-${index}`);
      return pending;
    });
    expect(onCancel).toHaveBeenCalledTimes(2);
    const laterRun = spawn({ scopeKey: "scope" });
    startup.resolve(first);
    const cancelled = await Promise.all(replacements);
    const runs = await Promise.all([firstRun, laterRun]);
    expect(child).toHaveBeenCalledTimes(2);
    expect(pty).not.toHaveBeenCalled();
    expect(resolveArgs).not.toHaveBeenCalled();
    expect(first.killMock).not.toHaveBeenCalled();
    expect(later.killMock).not.toHaveBeenCalled();
    for (const run of cancelled) {
      expect(run.pid).toBeUndefined();
      expect(run.activity.resultSettled).toBe(true);
      await expect(run.wait()).resolves.toMatchObject({
        reason: "manual-cancel",
        exitCode: null,
        exitSignal: null,
      });
    }
    first.settle(0);
    later.settle(0);
    await expect(Promise.all(runs.map((run) => run.wait()))).resolves.toEqual([
      expect.objectContaining({ reason: "exit" }),
      expect.objectContaining({ reason: "exit" }),
    ]);
  });

  it("resolves invocation arguments only after queued scope admission", async () => {
    const startup = createDeferred<StubChildAdapter>();
    child.mockReturnValueOnce(startup.promise);
    const first = terminating();
    const replacement = prepare();
    const firstRun = spawn({ scopeKey: "scope" });
    let argument = "before-admission";
    const resolveArgs = vi.fn(() => [argument]);
    const pending = spawn({ scopeKey: "scope", replaceExistingScope: true, resolveArgs });
    expect(resolveArgs).not.toHaveBeenCalled();
    argument = "after-admission";
    startup.resolve(first);
    const run = await pending;
    expect(resolveArgs).toHaveBeenCalledOnce();
    expect(child.mock.calls[1]?.[0].argv).toEqual(["fixture", "after-admission"]);
    replacement.settle(0);
    await Promise.all([(await firstRun).wait(), run.wait()]);
  });

  it("leaves the active scope intact when replacement arguments fail", async () => {
    const adapter = prepare();
    const run = await spawn({ scopeKey: "scope" });
    const pending = spawn({
      runId: "failed",
      scopeKey: "scope",
      replaceExistingScope: true,
      resolveArgs: () => {
        throw new Error("arguments failed");
      },
    });
    supervisor.cancel("failed");
    await expect(pending).rejects.toThrow("arguments failed");
    expect(adapter.killMock).not.toHaveBeenCalled();
    expect(child).toHaveBeenCalledOnce();
    adapter.settle(0);
    await run.wait();
    await supervisor.shutdown();
  });

  it.each([
    { mode: "child", argv: ["fixture"], resolveArgs: () => ["bad\0resolved"] },
    { mode: "child", argv: ["fixture"], argv0: "bad\0name" },
    { mode: "anchored-shell", command: "printf bad\0command" },
  ] satisfies SpawnInput[])(
    "rejects NUL-containing $mode input before construction or scope replacement (%#)",
    async (input) => {
      const adapter = prepare();
      const run = await spawn({ scopeKey: "scope" });
      child.mockResolvedValue(terminating());
      pty.mockResolvedValue(terminating());
      try {
        await expect(
          supervisor.spawn({ ...input, scopeKey: "scope", replaceExistingScope: true }),
        ).rejects.toThrow("must not contain NUL bytes");
        expect(adapter.killMock).not.toHaveBeenCalled();
        expect(child).toHaveBeenCalledOnce();
        expect(pty).not.toHaveBeenCalled();
      } finally {
        adapter.settle(0);
        await run.wait();
        await supervisor.shutdown();
      }
    },
  );

  it("rejects retired authority behind a scope fence without cancelling its survivor", async () => {
    const startup = createDeferred<StubChildAdapter>();
    child.mockReturnValueOnce(startup.promise);
    const first = createStubChildAdapter();
    let current = true;
    const firstRun = spawn({ scopeKey: "scope" });
    const replacement = spawn({
      scopeKey: "scope",
      replaceExistingScope: true,
      assertCurrent: () => {
        if (!current) {
          throw new Error("retired request");
        }
      },
    });
    const rejected = expect(replacement).rejects.toThrow("retired request");
    current = false;
    startup.resolve(first);
    await rejected;
    expect(child).toHaveBeenCalledOnce();
    expect(first.killMock).not.toHaveBeenCalled();
    first.settle(0);
    await (await firstRun).wait();
    await supervisor.shutdown();
  });

  it("launches literal PTY argv under transport-only scope cleanup", async () => {
    const cleanup = supervisor.acquireScopeCleanup("scope", { processTree: "transport-only" });
    const adapter = Object.assign(createStubChildAdapter(), { supportsRawOutput: false });
    pty.mockResolvedValueOnce(adapter);
    const command = `printf '%s\\n' "a b" && printf '%s\\n' '$HOME'`;
    const run = await supervisor.spawn({
      mode: "pty",
      argv: ["/trusted/launcher", "--literal", command],
      scopeKey: "scope",
    });
    expect(pty).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ shell: "/trusted/launcher", args: ["--literal", command] }),
    );
    expect(child).not.toHaveBeenCalled();
    adapter.emitStdout("interactive output");
    adapter.settle(0);
    await expect(run.wait()).resolves.toMatchObject({
      reason: "exit",
      exitCode: 0,
      stdout: "interactive output",
    });
    await cleanup();
  });

  it("rejects empty PTY argv before construction", async () => {
    await expect(supervisor.spawn({ mode: "pty", argv: [] })).rejects.toThrow(
      "spawn argv cannot be empty",
    );
    expect(pty).not.toHaveBeenCalled();
  });

  it("bounds an oversized output timeout across a late intermediate timer", async () => {
    vi.useFakeTimers();
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const timer = vi.spyOn(globalThis, "setTimeout");
    const adapter = prepare(terminating());
    const run = await spawn({ noOutputTimeoutMs: MAX_TIMER_TIMEOUT_MS + 600_000 });
    expect(timer.mock.calls.map(([, delay]) => delay)).toEqual([MAX_TIMER_TIMEOUT_MS]);
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.killMock).not.toHaveBeenCalled();
    adapter.emitStdout("progress");
    now.mockReturnValue(1_000 + MAX_TIMER_TIMEOUT_MS + 540_000);
    await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
    await vi.advanceTimersToNextTimerAsync();
    expect(adapter.killMock).not.toHaveBeenCalled();
    expect(timer.mock.calls.at(-1)?.[1]).toBe(60_000);
    now.mockReturnValue(1_000 + MAX_TIMER_TIMEOUT_MS + 600_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersToNextTimerAsync();
    await expect(run.wait()).resolves.toMatchObject({
      reason: "no-output-timeout",
      timedOut: true,
      noOutputTimedOut: true,
    });
    expect(adapter.killMock).toHaveBeenCalledOnce();
    expect(adapter.disposeMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves a queued successful exit when the deadline timer runs first", async () => {
    vi.useFakeTimers();
    const adapter = prepare();
    const run = await spawn({ timeoutMs: 10 });
    vi.advanceTimersByTime(10);
    adapter.settle(0);
    await expect(run.wait()).resolves.toMatchObject({
      reason: "exit",
      exitCode: 0,
      timedOut: false,
    });
    await vi.runOnlyPendingTimersAsync();
    expect(adapter.killMock).not.toHaveBeenCalled();
  });

  it("refreshes an expired no-output timer before its deferred decision", async () => {
    vi.useFakeTimers();
    const adapter = prepare();
    const run = await spawn({ noOutputTimeoutMs: 10 });
    vi.advanceTimersByTime(10);
    adapter.emitStdout("progress");
    await vi.advanceTimersByTimeAsync(1);
    expect(adapter.killMock).not.toHaveBeenCalled();
    adapter.settle(0);
    await expect(run.wait()).resolves.toMatchObject({
      reason: "exit",
      stdout: "progress",
      timedOut: false,
    });
  });

  it("preserves a natural close observed after a missed overall deadline", async () => {
    vi.useFakeTimers();
    const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const adapter = prepare();
    const run = await spawn({ timeoutMs: 10 });
    now.mockReturnValue(1_011);
    adapter.settle(0);
    await expect(run.wait()).resolves.toMatchObject({ reason: "exit", timedOut: false });
    expect(adapter.killMock).not.toHaveBeenCalled();
  });

  it("bounds captured output on UTF-16 boundaries while streaming full chunks", async () => {
    const adapter = prepare();
    const stdout = vi.fn();
    const stderr = vi.fn();
    const marker = (stream: string) =>
      `[openclaw: captured ${stream} truncated to last 256 chars]\n`;
    const retained = 256 - marker("stdout").length - 1;
    const stdoutChunk = `${"a".repeat(marker("stdout").length)}😀${"s".repeat(retained)}`;
    const stderrChunk = `${"b".repeat(marker("stderr").length)}😀${"e".repeat(retained)}`;
    const run = await spawn({ maxCapturedOutputChars: 256, onStdout: stdout, onStderr: stderr });
    adapter.emitStdout(stdoutChunk);
    adapter.emitStderr(stderrChunk);
    adapter.settle(0);
    const result = await run.wait();
    expect(stdout).toHaveBeenCalledExactlyOnceWith(stdoutChunk);
    expect(stderr).toHaveBeenCalledExactlyOnceWith(stderrChunk);
    expect(result.stdout).toBe(`${marker("stdout")}${"s".repeat(retained)}`);
    expect(result.stderr).toBe(`${marker("stderr")}${"e".repeat(retained)}`);
  });

  it("refreshes raw-only activity before notifying its observer", async () => {
    vi.useFakeTimers();
    const adapter = prepare(terminating());
    let observed: number | undefined;
    const run = await spawn({
      noOutputTimeoutMs: 10,
      onStdoutRaw: () => {
        observed = run.activity.lastOutputAtMs;
      },
    });
    await vi.advanceTimersByTimeAsync(9);
    adapter.emitStdoutRaw(Buffer.from([0xe2]));
    expect(run.activity.lastOutputAtMs).toBeGreaterThan(run.startedAtMs);
    expect(observed).toBe(run.activity.lastOutputAtMs);
    await vi.advanceTimersByTimeAsync(9);
    expect(adapter.killMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersToNextTimerAsync();
    await expect(run.wait()).resolves.toMatchObject({
      reason: "no-output-timeout",
      noOutputTimedOut: true,
    });
  });

  it.each(["settle", "detach"] as const)(
    "fences every output consumer and the output clock on %s",
    async (action) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const { adapter, extinction } = owned();
      const stdout = vi.fn(),
        stderr = vi.fn(),
        stdoutRaw = vi.fn(),
        stderrRaw = vi.fn();
      const run = await spawn({
        onStdout: stdout,
        onStderr: stderr,
        onStdoutRaw: stdoutRaw,
        onStderrRaw: stderrRaw,
      });
      now.mockReturnValue(2_000);
      adapter.emitStdout("live stdout");
      adapter.emitStderr("live stderr");
      if (action === "settle") {
        adapter.settle(null, "SIGKILL");
        await run.wait();
        expect(adapter.disposeMock).not.toHaveBeenCalled();
      } else {
        run.detachOutput?.();
      }
      now.mockReturnValue(3_000);
      adapter.emitStdout("late");
      adapter.emitStderr("late");
      adapter.settle(0);
      const result = await run.wait();
      expect(stdout).toHaveBeenCalledExactlyOnceWith("live stdout");
      expect(stderr).toHaveBeenCalledExactlyOnceWith("live stderr");
      expect(stdoutRaw).toHaveBeenCalledExactlyOnceWith(Buffer.from("live stdout"));
      expect(stderrRaw).toHaveBeenCalledExactlyOnceWith(Buffer.from("live stderr"));
      expect(result).toMatchObject({ stdout: "live stdout", stderr: "live stderr" });
      expect(run.activity.lastOutputAtMs).toBe(2_000);
      extinction.resolve();
      await run.waitForExtinction?.();
      expect(adapter.disposeMock).toHaveBeenCalledOnce();
    },
  );

  it("retains a cleanup failure for its owner without poisoning a later scope", async () => {
    const { adapter, extinction } = owned();
    const cleanup = supervisor.acquireScopeCleanup("scope", { processTree: "required-all" });
    const run = await spawn({ scopeKey: "scope" });
    adapter.settle(0);
    await run.wait();
    extinction.reject(new Error("cleanup identity lost"));
    await expect(run.waitForExtinction!()).rejects.toThrow("cleanup identity lost");
    await expect(cleanup()).rejects.toThrow("cleanup identity lost");
    await expect(cleanup()).rejects.toThrow("cleanup identity lost");
    await expect(
      supervisor.acquireScopeCleanup("scope", { processTree: "required-all" })(),
    ).resolves.toBeUndefined();
    await expect(supervisor.shutdown()).rejects.toThrow("cleanup identity lost");
    await expect(spawn()).rejects.toThrow("process supervisor is shut down");
  });

  it.each(["host", "external"] as const)(
    "reports unsupported %s tree ownership without blocking execution",
    async (owner) => {
      const adapter = prepare();
      const ownedCleanup = supervisor.acquireScopeCleanup("scope", { processTree: "owned-only" });
      const strictCleanup = supervisor.acquireScopeCleanup("scope", {
        processTree: "required-all",
      });
      const run = await spawn({
        scopeKey: "scope",
        ...(owner === "external" ? { cleanupOwnership: "external" } : {}),
      });
      adapter.emitStdout("available");
      adapter.settle(0);
      await expect(run.wait()).resolves.toMatchObject({ exitCode: 0, stdout: "available" });
      if (owner === "external") {
        await expect(ownedCleanup()).resolves.toBeUndefined();
      } else {
        await expect(ownedCleanup()).rejects.toThrow(
          "cannot confirm owned execution-tree settlement",
        );
      }
      await expect(strictCleanup()).rejects.toThrow(
        "cannot confirm owned execution-tree settlement",
      );
      await supervisor.shutdown();
    },
  );

  it("preserves root output when authoritative extinction settles first", async () => {
    const { adapter, extinction } = owned();
    adapter.oomScoreWrapperSelected = true;
    const run = await spawn();
    extinction.resolve();
    await Promise.resolve();
    expect(adapter.disposeMock).not.toHaveBeenCalled();
    expect(run.activity.resultSettled).toBe(false);
    adapter.emitStdout("ok");
    adapter.settle(0);
    await expect(run.wait()).resolves.toMatchObject({
      reason: "exit",
      exitCode: 0,
      stdout: "ok",
      oomScoreWrapperSelected: true,
    });
    expect(adapter.disposeMock).toHaveBeenCalledOnce();
  });

  it("retains cancellation ownership after the root result until cleanup fails", async () => {
    const { adapter, extinction } = owned();
    const run = await spawn({ scopeKey: "scope" });
    adapter.emitStdout("root output");
    adapter.settle(23);
    const root = await run.wait();
    expect(root).toMatchObject({ reason: "exit", exitCode: 23, stdout: "root output" });
    expect(adapter.disposeMock).not.toHaveBeenCalled();
    supervisor.cancelScope("scope");
    expect(adapter.killMock).toHaveBeenCalledWith("SIGKILL");
    extinction.reject(new Error("cleanup identity lost"));
    await expect(run.waitForExtinction!()).rejects.toThrow("cleanup identity lost");
    expect(adapter.disposeMock).toHaveBeenCalledOnce();
    await expect(run.wait()).resolves.toBe(root);
    supervisor.cancel(run.runId);
    expect(adapter.killMock).toHaveBeenCalledOnce();
  });

  it("drains cancelled startups and same-ID siblings before reporting ownership failure", async () => {
    const startup = createDeferred<StubChildAdapter>();
    child.mockReturnValueOnce(startup.promise);
    const first = createStubChildAdapter();
    const { adapter: sibling, extinction } = owned();
    const cleanup = supervisor.acquireScopeCleanup("scope", { processTree: "transport-only" });
    const input = { runId: "shared", scopeKey: "scope" };
    const pending = spawn(input);
    const siblingRun = await spawn(input);
    supervisor.cancelScope("scope");
    const drain = cleanup();
    startup.resolve(first);
    const firstRun = await pending;
    expect(first.killMock).toHaveBeenCalledWith("SIGKILL");
    expect(first.disposeMock).not.toHaveBeenCalled();
    first.settle(null, "SIGKILL");
    await firstRun.waitForExtinction?.();
    expect(first.disposeMock).toHaveBeenCalledOnce();
    expect(sibling.killMock).toHaveBeenCalledWith("SIGTERM");
    sibling.settle(0);
    await Promise.all([firstRun.wait(), siblingRun.wait()]);
    const drained = vi.fn();
    void drain.then(drained, drained);
    await Promise.resolve();
    expect(drained).not.toHaveBeenCalled();
    expect(sibling.disposeMock).not.toHaveBeenCalled();
    extinction.reject(new Error("sibling owner lost authority"));
    await expect(drain).rejects.toThrow("sibling owner lost authority");
    expect(sibling.disposeMock).toHaveBeenCalledOnce();
  });

  it("does not finalize a newer admission when an older same-ID startup fails", async () => {
    const startup = createDeferred<StubChildAdapter>();
    child.mockReturnValueOnce(startup.promise);
    const sibling = prepare();
    const pending = spawn({ runId: "shared" });
    const replacement = await spawn({ runId: "shared" });
    const snapshot = { ...replacement.activity };
    const rejected = expect(pending).rejects.toThrow("older startup failed");
    startup.reject(new Error("older startup failed"));
    await rejected;
    expect(replacement.activity).toEqual(snapshot);
    sibling.settle(0);
    await replacement.wait();
    await supervisor.shutdown();
  });
});
