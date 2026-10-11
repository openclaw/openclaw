import { expect, it, vi } from "vitest";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { startTranscriptPageRead } from "./session-transcript-page-read.operation.js";
import {
  acquireHistoryDatabaseResource,
  historyLane,
  type SessionHistoryDatabaseTarget,
} from "./session-transcript-worker-resources.js";
import type { SessionTranscriptWorkerReply } from "./session-transcript-worker.types.js";

const limits = { limit: 2, maxScannedEntries: 1000, maxMaterializedBytes: 16 * 1024 * 1024 };
const bigLimits = { ...limits, limit: 50 };

function controlledPageReply(): SessionTranscriptWorkerReply<"transcript-page-read"> {
  return {
    ok: true,
    value: {
      kind: "transcript-page-read",
      result: {
        ok: true,
        value: { generation: "original", records: [] },
        budget: { scannedEntries: 3, materializedBytes: 91, exhausted: false, final: true },
      },
    },
  };
}

it("responds at the queued deadline while the predecessor still owns execution", async () => {
  await withPageFixture([{ type: "session", id: "page-runtime", version: 3 }], async (fixture) => {
    const reply = Promise.withResolvers<SessionTranscriptWorkerReply<"transcript-page-read">>();
    const entered = Promise.withResolvers<void>();
    const run = vi.spyOn(historyLane.pool, "runTask").mockImplementation((factory) => {
      if (typeof factory !== "function") {
        throw new Error("Expected worker input factory");
      }
      const result = (async () => {
        await factory();
        entered.resolve();
        return reply.promise;
      })();
      return {
        result,
        close: async () => {
          await Promise.allSettled([result]);
        },
      };
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let first: ReturnType<typeof startTranscriptPageRead> | undefined;
    let queued: ReturnType<typeof startTranscriptPageRead> | undefined;
    try {
      first = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      await entered.promise;
      queued = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 20),
      );
      let queuedResponse: Awaited<typeof queued.response> | undefined;
      void queued.response.then((value) => {
        queuedResponse = value;
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(queuedResponse).toMatchObject({ ok: false, error: "timed_out" });
      expect(run).toHaveBeenCalledTimes(1);
      expect(acquireHistoryDatabaseResource(fixture.target).pending).toBeGreaterThan(0);
    } finally {
      reply.resolve(controlledPageReply());
      await first?.response;
      await first?.settled;
      await queued?.response;
      await queued?.settled;
      run.mockRestore();
      vi.useRealTimers();
    }
  });
});

it("rejects settlement when execution loss leaves source accounting unverified", async () => {
  await withPageFixture([{ type: "session", id: "page-runtime", version: 3 }], async (fixture) => {
    const run = vi.spyOn(historyLane.pool, "runTask").mockImplementation((factory) => {
      if (typeof factory !== "function") {
        throw new Error("Expected worker input factory");
      }
      return {
        result: (async () => {
          await factory();
          throw new WorkerTaskError("worker task timed out", "timeout");
        })(),
        close: async () => undefined,
      };
    });
    const rotate = vi.spyOn(historyLane.pool, "rotate").mockResolvedValue(undefined);
    try {
      const operation = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      void operation.settled.catch(() => undefined);
      await expect(operation.response).resolves.toMatchObject({ ok: false, error: "timed_out" });
      await expect(operation.settled).rejects.toThrow(/accounting/i);
      const resource = acquireHistoryDatabaseResource(fixture.target);
      expect(resource.pending).toBeGreaterThan(0);
      expect(resource.cleanups.size).toBeGreaterThan(0);
      const successor = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      await expect(successor.response).rejects.toThrow(/admission is closed/);
      await expect(successor.settled).rejects.toThrow(/admission is closed/);
      await closeOpenClawAgentDatabaseByPathAsync(fixture.scope.path);
      expect(resource.pending).toBe(0);
      expect(resource.cleanups.size).toBe(0);
    } finally {
      run.mockRestore();
      rotate.mockRestore();
    }
  });
});

it("publishes queued expiry even when the timer has not been serviced", async () => {
  await withPageFixture([{ type: "session", id: "page-runtime", version: 3 }], async (fixture) => {
    const reply = Promise.withResolvers<SessionTranscriptWorkerReply<"transcript-page-read">>();
    const entered = Promise.withResolvers<void>();
    const run = vi.spyOn(historyLane.pool, "runTask").mockImplementation((factory) => {
      if (typeof factory !== "function") {
        throw new Error("Expected worker input factory");
      }
      const result = (async () => {
        await factory();
        entered.resolve();
        return reply.promise;
      })();
      return { result, close: async () => undefined };
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let first: ReturnType<typeof startTranscriptPageRead> | undefined;
    let queued: ReturnType<typeof startTranscriptPageRead> | undefined;
    try {
      first = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      await entered.promise;
      const input = operationInput(fixture, performance.now() + 20);
      queued = startTranscriptPageRead(fixture.target, input);
      let response: Awaited<typeof queued.response> | undefined;
      void queued.response.then((value) => {
        response = value;
      });
      // Advance the monotonic clock without executing the overdue timers.
      vi.spyOn(performance, "now").mockReturnValue(input.deadlineAt + 1);
      input.deadlineAt += 5000; // Caller mutation cannot extend captured admission.
      reply.resolve(controlledPageReply());
      await queued.settled;
      await Promise.resolve();
      expect(response).toMatchObject({ ok: false, error: "timed_out" });
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      reply.resolve(controlledPageReply());
      await Promise.allSettled([first?.settled, queued?.settled]);
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });
});

it("handles a response rejection when the caller observes settlement first", async () => {
  await withPageFixture([{ type: "session", id: "page-runtime", version: 3 }], async (fixture) => {
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("close failed"))
      .mockResolvedValue(undefined);
    const run = vi.spyOn(historyLane.pool, "runTask").mockImplementation((factory) => {
      if (typeof factory !== "function") {
        throw new Error("Expected worker input factory");
      }
      return {
        result: (async () => {
          await factory();
          return controlledPageReply();
        })(),
        close,
      };
    });
    try {
      const operation = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      await expect(operation.settled).rejects.toThrow(/close failed/);
      // Let Node report any unhandled response rejection before observing it.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await expect(operation.response).rejects.toThrow(/close failed/);
      await expect(operation.settled).rejects.toMatchObject({
        errors: [expect.objectContaining({ message: "close failed" })],
      });
    } finally {
      run.mockRestore();
    }
  });
});

it("lets the database owner retry a failed owned-task close before reopening admission", async () => {
  await withPageFixture([{ type: "session", id: "page-runtime", version: 3 }], async (fixture) => {
    const close = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("owned close failed"))
      .mockResolvedValue(undefined);
    const run = vi.spyOn(historyLane.pool, "runTask").mockImplementation((factory) => {
      if (typeof factory !== "function") {
        throw new Error("Expected worker input factory");
      }
      const result = (async () => {
        await factory();
        throw new WorkerTaskError("worker timed out", "timeout");
      })();
      return { result, close };
    });
    const rotate = vi.spyOn(historyLane.pool, "rotate").mockResolvedValue(undefined);
    try {
      const operation = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      void operation.settled.catch(() => undefined);
      await expect(operation.response).rejects.toThrow(/owned close failed/);
      await expect(operation.settled).rejects.toThrow(/owned close failed/);
      expect(close).toHaveBeenCalledTimes(1);
      await closeOpenClawAgentDatabaseByPathAsync(fixture.scope.path);
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      run.mockRestore();
      rotate.mockRestore();
    }
    const successor = startTranscriptPageRead(
      fixture.target,
      operationInput(fixture, performance.now() + 5000),
    );
    await expect(successor.response).resolves.toMatchObject({ ok: true });
    await expect(successor.settled).resolves.toMatchObject({ final: true });
  });
});

type PageFixture = {
  scope: {
    agentId: string;
    sessionKey: string;
    sessionId: string;
    path: string;
    env: NodeJS.ProcessEnv;
  };
  target: SessionHistoryDatabaseTarget;
};

async function withPageFixture(
  events: Parameters<typeof replaceTranscriptEvents>[1],
  run: (fixture: PageFixture) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const writer = openOpenClawAgentDatabase({ agentId: "main", env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:page-runtime",
      sessionId: "page-runtime",
      path: writer.path,
      env,
    };
    writeSessionEntry(writer, scope.sessionKey, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      lifecycleRevision: "original",
    });
    await replaceTranscriptEvents({ ...scope, storePath: scope.path }, events);
    await closeOpenClawAgentDatabaseByPathAsync(writer.path);
    await run({ scope, target: { agentId: scope.agentId, path: scope.path } });
  });
}

function operationInput(fixture: PageFixture, deadlineAt: number, requestLimits = limits) {
  return {
    request: {
      scope: fixture.scope,
      expectedLifecycleRevision: "original",
      limits: requestLimits,
    },
    expectedIdentity: readDatabasePathIdentitySync(fixture.scope.path),
    deadlineAt,
  };
}

it("resolves a page and completes settlement with final accounting", async () => {
  await withPageFixture(
    [
      { type: "session", id: "page-runtime", version: 3 },
      { type: "message", id: "one", message: { role: "user", content: "one" } },
    ],
    async (fixture) => {
      const operation = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      const response = await operation.response;
      expect(response.ok).toBe(true);
      if (response.ok) {
        expect(response.value.records.map((entry) => entry.storedEntryId)).toEqual([
          fixture.scope.sessionId,
          "one",
        ]);
        expect(response.budget.final).toBe(true);
      }
      await expect(operation.settled).resolves.toMatchObject({
        final: true,
        scannedEntries: expect.any(Number),
      });
      const second = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      await expect(second.response.then((value) => value.ok)).resolves.toBe(true);
      await second.settled;
    },
  );
});

it("returns timed_out without dispatch when the deadline already elapsed", async () => {
  await withPageFixture([{ type: "session", id: "page-runtime", version: 3 }], async (fixture) => {
    const operation = startTranscriptPageRead(
      fixture.target,
      operationInput(fixture, performance.now() - 1),
    );
    await expect(operation.response).resolves.toMatchObject({
      ok: false,
      error: "timed_out",
      budget: { final: false },
    });
    await expect(operation.settled).resolves.toMatchObject({ final: true, scannedEntries: 0 });
  });
});

it("rejects deadline windows beyond the five-second operation budget", async () => {
  await withPageFixture([{ type: "session", id: "page-runtime", version: 3 }], async (fixture) => {
    expect(() =>
      startTranscriptPageRead(fixture.target, operationInput(fixture, performance.now() + 5001)),
    ).toThrow(/deadline/);
    expect(() =>
      startTranscriptPageRead(fixture.target, operationInput(fixture, Number.NaN)),
    ).toThrow(/finite/);
  });
});

it("bounds the response while owned cleanup stays held and discards a late page", async () => {
  await withPageFixture([{ type: "session", id: "page-runtime", version: 3 }], async (fixture) => {
    const reply = Promise.withResolvers<SessionTranscriptWorkerReply<"transcript-page-read">>();
    const cleanup = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    let calls = 0;
    const run = vi.spyOn(historyLane.pool, "runTask").mockImplementation((factory) => {
      if (typeof factory !== "function") {
        throw new Error("Expected worker input factory");
      }
      const result = (async () => {
        await factory();
        if (++calls > 1) {
          return controlledPageReply();
        }
        entered.resolve();
        return reply.promise;
      })();
      return {
        result,
        close: () => {
          closing.resolve();
          return cleanup.promise;
        },
      };
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    let first: ReturnType<typeof startTranscriptPageRead> | undefined;
    let successor: ReturnType<typeof startTranscriptPageRead> | undefined;
    try {
      first = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 50),
      );
      await entered.promise;
      await vi.advanceTimersByTimeAsync(50);
      await expect(first.response).resolves.toMatchObject({ ok: false, error: "timed_out" });
      let finished = false;
      void first.settled.then(() => {
        finished = true;
      });
      successor = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      reply.resolve(controlledPageReply());
      await closing.promise;
      expect(finished).toBe(false);
      expect(run).toHaveBeenCalledTimes(1);
      expect(acquireHistoryDatabaseResource(fixture.target).pending).toBeGreaterThan(0);
      cleanup.resolve();
      await expect(first.settled).resolves.toMatchObject({ final: true, materializedBytes: 91 });
      await expect(first.response).resolves.toMatchObject({ ok: false, error: "timed_out" });
      await expect(successor.response).resolves.toMatchObject({ ok: true });
      await successor.settled;
    } finally {
      reply.resolve(controlledPageReply());
      cleanup.resolve();
      await Promise.allSettled([first?.settled, successor?.settled]);
      run.mockRestore();
      vi.useRealTimers();
    }
  });
});

it("revokes publication for an idempotent cancel and keeps the lane usable", async () => {
  await withPageFixture(
    [
      { type: "session", id: "page-runtime", version: 3 },
      { type: "message", id: "one", message: { role: "user", content: "one" } },
    ],
    async (fixture) => {
      const operation = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      operation.cancel();
      operation.cancel();
      await expect(operation.response).resolves.toMatchObject({
        ok: false,
        error: "timed_out",
        budget: { final: false },
      });
      await operation.settled;
      const successor = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      await expect(successor.response.then((value) => value.ok)).resolves.toBe(true);
      await successor.settled;
    },
  );
});

it("keeps admission closed when worker retirement fails during a timeout", async () => {
  await withPageFixture([{ type: "session", id: "page-runtime", version: 3 }], async (fixture) => {
    const close = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("retirement failed"));
    const run = vi.spyOn(historyLane.pool, "runTask").mockImplementation((factory, options) => {
      // Assign native custody exactly as the pool would, then time out.
      if (typeof factory !== "function") {
        throw new Error("Expected worker input factory");
      }
      return {
        result: (async () => {
          await factory();
          options?.onExecutionSettled?.({ retired: true });
          throw new WorkerTaskError("worker task timed out", "timeout");
        })(),
        close,
      };
    });
    const rotate = vi
      .spyOn(historyLane.pool, "rotate")
      .mockImplementation(() => Promise.reject(new Error("rotation failed")));
    try {
      const operation = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      await expect(operation.response).rejects.toThrow(/worker retirement failed/);
      await expect(operation.settled).rejects.toThrow(/worker retirement failed/);
      await expect(operation.settled).rejects.toMatchObject({
        errors: [
          expect.objectContaining({
            errors: [
              expect.objectContaining({ message: "worker task timed out" }),
              expect.objectContaining({ message: "rotation failed" }),
            ],
          }),
          expect.objectContaining({ message: "retirement failed" }),
        ],
      });
      const successor = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      await expect(successor.response).rejects.toThrow(/admission is closed/);
      await expect(successor.settled).rejects.toThrow(/admission is closed/);
    } finally {
      close.mockResolvedValue(undefined);
      run.mockRestore();
      rotate.mockRestore();
    }
  });
});

it("settles a canceled operation across a mid-flight source replacement", async () => {
  await withPageFixture(
    [
      { type: "session", id: "page-runtime", version: 3 },
      { type: "message", id: "one", message: { role: "user", content: "one" } },
    ],
    async (fixture) => {
      const operation = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000),
      );
      operation.cancel();
      const originalPath = fixture.scope.path;
      const fs = await import("node:fs");
      fs.renameSync(originalPath, originalPath + ".original");
      fs.writeFileSync(originalPath, "synthetic replacement; must never be read");
      try {
        await expect(operation.response).resolves.toMatchObject({
          ok: false,
          error: "timed_out",
        });
        await operation.settled;
        const replaced = startTranscriptPageRead(fixture.target, {
          ...operationInput(fixture, performance.now() + 5000),
          expectedIdentity: readDatabasePathIdentitySync(originalPath),
        });
        await expect(replaced.response).resolves.toMatchObject({ ok: false, error: "read_failed" });
        await expect(replaced.settled).rejects.toThrow(/accounting/i);
      } finally {
        fs.rmSync(originalPath + ".original", { force: true });
      }
    },
  );
});

it("holds the resource for the whole native read", async () => {
  const bulky = Array.from({ length: 40 }, (_, index) => ({
    type: "message",
    id: `bulky-${index}`,
    message: { role: "user", content: "x".repeat(400_000) },
  }));
  await withPageFixture(
    [{ type: "session", id: "page-runtime", version: 3 }, ...bulky],
    async (fixture) => {
      const resource = acquireHistoryDatabaseResource(fixture.target);
      const operation = startTranscriptPageRead(
        fixture.target,
        operationInput(fixture, performance.now() + 5000, bigLimits),
      );
      const pendingDuringFlight = await new Promise<number>((resolve) => {
        setImmediate(() => resolve(resource.pending));
      });
      expect(pendingDuringFlight).toBeGreaterThan(0);
      const response = await operation.response;
      expect(response.ok).toBe(true);
      await operation.settled;
    },
  );
});
