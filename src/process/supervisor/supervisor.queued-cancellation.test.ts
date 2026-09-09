// Queued supervisor replacements must not launch after their caller cancels.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createProcessSupervisor } from "./supervisor.js";
import type { SpawnInput, SpawnProcessAdapter } from "./types.js";

const { createChildAdapterMock, createPtyAdapterMock } = vi.hoisted(() => ({
  createChildAdapterMock: vi.fn(),
  createPtyAdapterMock: vi.fn(),
}));

vi.mock("./adapters/child.js", () => ({
  createChildAdapter: createChildAdapterMock,
}));

vi.mock("./adapters/pty.js", () => ({
  createPtyAdapter: createPtyAdapterMock,
}));

type StubProcessAdapter = SpawnProcessAdapter<NodeJS.Signals | null> & {
  killMock: ReturnType<typeof vi.fn>;
  settle: (code: number | null, signal?: NodeJS.Signals | null) => void;
};

function createStubProcessAdapter(pid = 1234): StubProcessAdapter {
  const completion = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const killMock = vi.fn();
  return {
    pid,
    supportsRawOutput: false,
    onStdout: () => undefined,
    onStderr: () => undefined,
    wait: async () => completion.promise,
    kill: (signal) => killMock(signal),
    dispose: () => undefined,
    killMock,
    settle: (code, signal = null) => completion.resolve({ code, signal }),
  };
}

function createSpawnInput(params: {
  runId: string;
  scopeKey: string;
  mode?: "child" | "pty";
  replaceExistingScope?: boolean;
}): SpawnInput {
  return {
    runId: params.runId,
    scopeKey: params.scopeKey,
    replaceExistingScope: params.replaceExistingScope,
    mode: params.mode ?? "child",
    argv: [process.execPath, "-e", "process.stdout.write('should-not-run')"],
  };
}

describe("process supervisor queued cancellation", () => {
  beforeEach(() => {
    createChildAdapterMock.mockReset();
    createPtyAdapterMock.mockReset();
  });

  it("resolves invocation arguments after queued scope admission", async () => {
    const first = createStubProcessAdapter(1234);
    const replacement = createStubProcessAdapter(5678);
    const firstStartup = createDeferred<StubProcessAdapter>();
    createChildAdapterMock.mockReturnValueOnce(firstStartup.promise);
    createChildAdapterMock.mockResolvedValueOnce(replacement);
    const supervisor = createProcessSupervisor();
    const scopeKey = "scope:deferred-args";
    const firstRunPromise = supervisor.spawn(
      createSpawnInput({ runId: "deferred-args-first", scopeKey }),
    );
    let invocationArgument = "before-admission";
    const resolveArgs = vi.fn(() => [invocationArgument]);
    const replacementRunPromise = supervisor.spawn(
      Object.assign(
        createSpawnInput({
          runId: "deferred-args-replacement",
          scopeKey,
          replaceExistingScope: true,
        }),
        { resolveArgs },
      ),
    );

    expect(resolveArgs).not.toHaveBeenCalled();
    invocationArgument = "after-admission";
    firstStartup.resolve(first);
    const [firstRun, replacementRun] = await Promise.all([firstRunPromise, replacementRunPromise]);

    try {
      expect(resolveArgs).toHaveBeenCalledOnce();
      expect(createChildAdapterMock.mock.calls[1]?.[0].argv).toEqual([
        process.execPath,
        "-e",
        "process.stdout.write('should-not-run')",
        "after-admission",
      ]);
    } finally {
      first.settle(0);
      replacement.settle(0);
      await Promise.all([firstRun.wait(), replacementRun.wait()]);
    }
  });

  it.each(["child", "pty"] as const)(
    "does not start an already-cancelled queued %s replacement",
    async (mode) => {
      const first = createStubProcessAdapter();
      const replacement = createStubProcessAdapter();
      const firstStartup = createDeferred<StubProcessAdapter>();
      createChildAdapterMock.mockReturnValueOnce(firstStartup.promise);
      if (mode === "pty") {
        createPtyAdapterMock.mockResolvedValueOnce(replacement);
      } else {
        createChildAdapterMock.mockResolvedValueOnce(replacement);
      }

      const supervisor = createProcessSupervisor();
      const scopeKey = "scope:cancel-queued";
      const firstRunPromise = supervisor.spawn(
        createSpawnInput({ runId: `cancel-queued-${mode}-first`, scopeKey }),
      );
      const replacementRunId = `cancel-queued-${mode}-replacement`;
      const resolveArgs = vi.fn(() => ["must-not-resolve"]);
      const replacementPromise = supervisor.spawn(
        Object.assign(
          createSpawnInput({
            runId: replacementRunId,
            scopeKey,
            mode,
            replaceExistingScope: true,
          }),
          mode === "child" ? { resolveArgs } : {},
        ),
      );

      expect(createChildAdapterMock).toHaveBeenCalledTimes(1);
      expect(createPtyAdapterMock).not.toHaveBeenCalled();

      supervisor.cancel(replacementRunId, "manual-cancel");
      firstStartup.resolve(first);
      const [firstRun, replacementRun] = await Promise.all([firstRunPromise, replacementPromise]);

      expect(createChildAdapterMock).toHaveBeenCalledTimes(1);
      expect(createPtyAdapterMock).not.toHaveBeenCalled();
      expect(first.killMock).not.toHaveBeenCalled();
      expect(replacement.killMock).not.toHaveBeenCalled();
      expect(resolveArgs).not.toHaveBeenCalled();
      expect(replacementRun.pid).toBeUndefined();
      await expect(replacementRun.wait()).resolves.toMatchObject({
        reason: "manual-cancel",
        exitCode: null,
        exitSignal: null,
      });
      expect(replacementRun.activity).toEqual({
        resultSettled: true,
        lastOutputAtMs: replacementRun.startedAtMs,
      });

      first.settle(0);
      await expect(firstRun.wait()).resolves.toMatchObject({ reason: "exit" });
    },
  );

  it("releases startup ownership when deferred arguments throw", async () => {
    const supervisor = createProcessSupervisor();
    const input = Object.assign(
      createSpawnInput({ runId: "failed-args", scopeKey: "scope:failed-args" }),
      {
        resolveArgs: () => {
          throw new Error("argument preparation failed");
        },
      },
    );

    await expect(supervisor.spawn(input)).rejects.toThrow("argument preparation failed");
    expect(createChildAdapterMock).not.toHaveBeenCalled();
    await supervisor.shutdown();
  });

  it("keeps the active scope when replacement argument preparation fails", async () => {
    const active = createStubProcessAdapter();
    createChildAdapterMock.mockResolvedValueOnce(active);
    const supervisor = createProcessSupervisor();
    const scopeKey = "scope:failed-replacement-args";
    const activeRun = await supervisor.spawn(
      createSpawnInput({ runId: "active-args-owner", scopeKey }),
    );
    try {
      const replacement = Object.assign(
        createSpawnInput({ runId: "bad-replacement-args", scopeKey, replaceExistingScope: true }),
        {
          resolveArgs: () => {
            throw new Error("replacement arguments failed");
          },
        },
      );
      await expect(supervisor.spawn(replacement)).rejects.toThrow("replacement arguments failed");
      expect(active.killMock).not.toHaveBeenCalled();
      expect(createChildAdapterMock).toHaveBeenCalledOnce();
    } finally {
      active.settle(0);
      await activeRun.wait();
      await supervisor.shutdown();
    }
  });

  it("allows immediate cancellation of a rejected argument preparation", async () => {
    const supervisor = createProcessSupervisor();
    const runId = "cancel-failed-args";
    const input = Object.assign(createSpawnInput({ runId, scopeKey: "scope:cancel-failed-args" }), {
      resolveArgs: () => {
        throw new Error("argument preparation rejected");
      },
    });
    const started = supervisor.spawn(input);
    supervisor.cancel(runId, "manual-cancel");
    await expect(started).rejects.toThrow("argument preparation rejected");
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(createChildAdapterMock).not.toHaveBeenCalled();
    await supervisor.shutdown();
  });

  it("never starts cancelled queued replacements or cancels their surviving scope", async () => {
    const replacementCount = 32;
    const first = createStubProcessAdapter(1234);
    const later = createStubProcessAdapter(1235);
    const firstStartup = createDeferred<StubProcessAdapter>();
    createChildAdapterMock.mockReturnValueOnce(firstStartup.promise).mockResolvedValueOnce(later);

    const supervisor = createProcessSupervisor();
    const scopeKey = "scope:cancel-many-queued";
    const firstRunPromise = supervisor.spawn(
      createSpawnInput({ runId: "cancel-many-queued-first", scopeKey }),
    );
    const replacements = Array.from({ length: replacementCount }, (_unused, index) => {
      const runId = `cancel-many-queued-replacement-${index}`;
      const replacement = supervisor.spawn(
        createSpawnInput({
          runId,
          scopeKey,
          mode: index % 2 === 0 ? "child" : "pty",
          replaceExistingScope: true,
        }),
      );
      supervisor.cancel(runId, "manual-cancel");
      return replacement;
    });
    const laterRunPromise = supervisor.spawn(
      createSpawnInput({ runId: "cancel-many-queued-later", scopeKey }),
    );

    expect(createChildAdapterMock).toHaveBeenCalledTimes(1);
    expect(createPtyAdapterMock).not.toHaveBeenCalled();

    firstStartup.resolve(first);
    const [firstRun, replacementRuns, laterRun] = await Promise.all([
      firstRunPromise,
      Promise.all(replacements),
      laterRunPromise,
    ]);

    expect(createChildAdapterMock).toHaveBeenCalledTimes(2);
    expect(createPtyAdapterMock).not.toHaveBeenCalled();
    expect(first.killMock).not.toHaveBeenCalled();
    expect(later.killMock).not.toHaveBeenCalled();
    for (const replacement of replacementRuns) {
      expect(replacement.pid).toBeUndefined();
    }
    await expect(Promise.all(replacementRuns.map((run) => run.wait()))).resolves.toEqual(
      Array.from({ length: replacementCount }, () =>
        expect.objectContaining({ reason: "manual-cancel" }),
      ),
    );

    first.settle(0);
    later.settle(0);
    await expect(Promise.all([firstRun.wait(), laterRun.wait()])).resolves.toEqual([
      expect.objectContaining({ reason: "exit" }),
      expect.objectContaining({ reason: "exit" }),
    ]);
  });

  it("rejects retired request authority behind a scope fence without cancelling its survivor", async () => {
    const first = createStubProcessAdapter();
    const replacement = createStubProcessAdapter(1235);
    const firstStartup = createDeferred<StubProcessAdapter>();
    createChildAdapterMock
      .mockReturnValueOnce(firstStartup.promise)
      .mockResolvedValueOnce(replacement);
    const supervisor = createProcessSupervisor();
    const scopeKey = "scope:retired-request";
    const retired = new Error("request authority retired behind scope fence");
    let current = true;
    const firstRunPromise = supervisor.spawn(createSpawnInput({ runId: "survivor", scopeKey }));
    const replacementPromise = supervisor.spawn({
      ...createSpawnInput({ runId: "retired-request", scopeKey, replaceExistingScope: true }),
      assertCurrent: () => {
        if (!current) {
          throw retired;
        }
      },
    });
    const replacementOutcome = Promise.allSettled([replacementPromise]);

    expect(createChildAdapterMock).toHaveBeenCalledOnce();
    current = false;
    firstStartup.resolve(first);
    const firstRun = await firstRunPromise;
    const [outcome] = await replacementOutcome;
    try {
      expect(outcome).toEqual({ status: "rejected", reason: retired });
      expect(createChildAdapterMock).toHaveBeenCalledOnce();
      expect(first.killMock).not.toHaveBeenCalled();
    } finally {
      first.settle(0);
      replacement.settle(0);
      await firstRun.wait();
      if (outcome?.status === "fulfilled") {
        await outcome.value.wait();
      }
      await supervisor.shutdown();
    }
  });
});
