import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTranscriptsAutoStartService } from "./auto-start.js";
import type { TranscriptStartRequest, TranscriptsStartResult } from "./provider-types.js";
import {
  transcriptStatusRoom as room,
  useTranscriptStatusFixture,
} from "./status.producer.test-harness.js";
import { transcriptSessionSelector, TranscriptsStore } from "./store.js";

const fixture = useTranscriptStatusFixture();
type Service = ReturnType<typeof createTranscriptsAutoStartService>;

type RetryOptions = {
  whenOccupied?: boolean;
  title?: string;
  realTimers?: boolean;
  acceptFrom?: number;
};

function retryFixture(options: RetryOptions = {}) {
  if (!options.realTimers) {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  }
  const { realTimers: _realTimers, acceptFrom, ...source } = options;
  const f = fixture({ transcripts: { autoStart: [{ ...room, ...source }] } });
  if (options.whenOccupied !== undefined) {
    f.provider.watchOccupancy = async (request) => {
      request.onOccupied();
      return { ok: true, value: { stop() {} } };
    };
  }
  let attempts = 0;
  const start = vi.fn(async (request: TranscriptStartRequest): Promise<TranscriptsStartResult> =>
    acceptFrom !== undefined && ++attempts >= acceptFrom
      ? { ok: true, session: request.session }
      : { ok: false, error: "provider unavailable" },
  );
  f.provider.start = start;
  return { f, start, service: createTranscriptsAutoStartService(f.ctx) };
}

async function stopAfterAction(service: Service, action: "stop" | "retry") {
  if (action === "retry") {
    await vi.advanceTimersByTimeAsync(5_000);
    await service.start().settled;
  }
  await service.stop();
}

describe("configured transcript failed-start custody", () => {
  it.each([
    { whenOccupied: false, accepted: false },
    { whenOccupied: true, accepted: false },
    { whenOccupied: false, accepted: true },
  ])(
    "discards only exhausted empty admissions (occupied=$whenOccupied, accepted=$accepted)",
    async ({ whenOccupied, accepted }) => {
      const { f, service, start } = retryFixture({ whenOccupied });
      try {
        const attempts = accepted ? 3 : 12;
        start.mockImplementation(async (request) =>
          accepted && start.mock.calls.length === attempts
            ? { ok: true, session: request.session }
            : { ok: false, error: "provider unavailable" },
        );
        await service.start().settled;
        const original = start.mock.calls[0]![0].session;
        for (let attempt = 2; attempt <= attempts; attempt++) {
          expect(await f.store.listSessionEntries()).toHaveLength(1);
          await vi.advanceTimersByTimeAsync(5_000);
          await service.start().settled;
          expect(start).toHaveBeenCalledTimes(attempt);
        }
        expect(start.mock.calls.map(([request]) => request.session.sessionId)).toEqual(
          Array.from({ length: attempts }, () => original.sessionId),
        );
        expect((await f.read()).configuredSources[0]).toMatchObject(
          accepted ? { state: "armed" } : { state: "not-active", startDiagnostic: "start-failed" },
        );
        expect(await f.store.listSessionEntries()).toHaveLength(accepted ? 1 : 0);
        await service.stop();
        expect(await f.store.listSessionEntries()).toHaveLength(accepted ? 1 : 0);
        await vi.advanceTimersByTimeAsync(65_000);
        expect(start).toHaveBeenCalledTimes(attempts);
      } finally {
        await service.stop();
      }
    },
  );

  it.each(["stop", "retry"] as const)(
    "preserves a rewrite during pending provider startup before %s",
    async (action) => {
      const { f, service, start } = retryFixture();
      const entered = createDeferred<TranscriptStartRequest>();
      const release = createDeferred();
      start.mockImplementation(async (request) => {
        entered.resolve(request);
        await release.promise;
        return { ok: false, error: "provider unavailable" };
      });
      const starting = service.start().settled;
      try {
        const request = await entered.promise;
        const rewritten = { ...request.session, title: "Operator rewrite during startup" };
        await f.store.writeSession(rewritten);
        release.resolve();
        await starting;
        await stopAfterAction(service, action);
        expect(start).toHaveBeenCalledOnce();
        expect(await f.store.readSession(request.session.sessionId)).toEqual(rewritten);
      } finally {
        release.resolve();
        await starting;
        await service.stop();
      }
    },
  );

  it.each(["stop", "retry"] as const)(
    "retains SQLite-normalized title custody through %s after failed startup",
    async (action) => {
      const { f, service, start } = retryFixture({ title: "Meeting \ud800" });
      try {
        await service.start().settled;
        expect(await f.store.listSessionEntries()).toMatchObject([
          { session: { title: "Meeting \ufffd" } },
        ]);
        expect((await f.read()).configuredSources[0]?.startDiagnostic).toBe("retrying");
        await stopAfterAction(service, action);
        expect(start).toHaveBeenCalledTimes(action === "retry" ? 2 : 1);
        expect(await f.store.listSessionEntries()).toEqual([]);
      } finally {
        await service.stop();
      }
    },
  );

  it.each(["stop", "retry"] as const)(
    "preserves an external write between failed restoration and %s custody",
    async (action) => {
      const { f, service, start } = retryFixture();
      try {
        const writeSession = f.store.writeSession.bind(f.store);
        let rewritten = false;
        vi.spyOn(TranscriptsStore.prototype, "writeSession").mockImplementation(async (...args) => {
          const result = await writeSession(...args);
          if (args[0].stoppedAt && !rewritten) {
            rewritten = true;
            // A distinct writer commits after restoration, before its caller resumes.
            await writeSession({ ...args[0], title: "Operator-owned meeting" });
          }
          return result;
        });
        await service.start().settled;
        const { session } = (await f.store.listSessionEntries())[0]!;
        expect(rewritten).toBe(true);
        expect(session.title).toBe("Operator-owned meeting");
        await stopAfterAction(service, action);
        expect(start).toHaveBeenCalledOnce();
        expect(await f.store.readSession(session.sessionId)).toEqual(session);
      } finally {
        await service.stop();
      }
    },
  );

  it("preserves a failed row adopted by a replacement service and lets its retry start", async () => {
    const { f, service: retiring, start } = retryFixture({ whenOccupied: true, acceptFrom: 3 });
    const replacement = createTranscriptsAutoStartService(f.ctx);
    try {
      await retiring.start().settled;
      const { session } = (await f.store.listSessionEntries())[0]!;
      const revision = await f.store.readSummaryInputRevision(session);
      await replacement.start().settled;
      expect(start).toHaveBeenCalledTimes(2);
      expect(start.mock.calls[1]![0].session.sessionId).toBe(session.sessionId);
      expect(await f.store.readSession(session.sessionId)).toEqual(session);
      expect(await f.store.readSummaryInputRevision(session)).toBe(revision);

      // The replacement restored the same tuple. Only custody, not content checks,
      // can keep the retiring lifecycle from deleting its pending row in SQLite.
      await retiring.stop();
      expect(await f.store.readSession(session.sessionId)).toEqual(session);
      await vi.advanceTimersByTimeAsync(5_000);
      await replacement.start().settled;
      expect(start).toHaveBeenCalledTimes(3);
      expect(start.mock.calls[2]![0].session.sessionId).toBe(session.sessionId);
      expect((await f.read()).active).toMatchObject([{ sessionId: session.sessionId }]);
    } finally {
      await retiring.stop();
      await replacement.stop();
    }
  });

  it.each(["discarded", "rewritten"] as const)(
    "reselects only a %s candidate before replacement admission",
    async (change) => {
      const { f, service: retiring, start } = retryFixture({ whenOccupied: true, acceptFrom: 2 });
      const replacement = createTranscriptsAutoStartService(f.ctx);
      const selected = createDeferred();
      const release = createDeferred();
      try {
        await retiring.start().settled;
        const { session } = (await f.store.listSessionEntries())[0]!;
        const readRecent = f.store.readRecentStoppedSession.bind(f.store);
        vi.spyOn(TranscriptsStore.prototype, "readRecentStoppedSession").mockImplementationOnce(
          async (...args) => {
            const candidate = await readRecent(...args);
            selected.resolve();
            await release.promise;
            return candidate;
          },
        );
        const starting = replacement.start().settled;
        await selected.promise;
        if (change === "rewritten") {
          await f.store.writeSession({ ...session, title: "Operator-owned meeting" });
        }
        await retiring.stop();
        if (change === "discarded") {
          expect(await f.store.readSession(session.sessionId)).toBeUndefined();
        }
        release.resolve();
        await starting;
        await vi.advanceTimersByTimeAsync(5_000);
        await replacement.start().settled;
        if (change === "discarded") {
          expect(start).toHaveBeenCalledTimes(2);
          expect(start.mock.calls[1]![0].session.sessionId).not.toBe(session.sessionId);
          expect((await f.read()).active).toHaveLength(1);
        } else {
          expect(start).toHaveBeenCalledOnce();
          expect(await f.store.readSession(session.sessionId)).toEqual({
            ...session,
            title: "Operator-owned meeting",
          });
          expect((await f.read()).active).toEqual([]);
        }
      } finally {
        release.resolve();
        await retiring.stop();
        await replacement.stop();
      }
    },
  );

  it.each([false, true])(
    "discards failed late startup after the stop deadline (occupied=%s)",
    async (whenOccupied) => {
      const { f, service, start } = retryFixture({ whenOccupied });
      const entered = createDeferred<TranscriptStartRequest>();
      const gate = createDeferred();
      start.mockImplementation(async (request) => {
        entered.resolve(request);
        await gate.promise;
        throw new Error("provider failed after shutdown");
      });
      const starting = service.start().settled;
      try {
        const request = await entered.promise;
        const stopping = service.stop();
        await vi.advanceTimersByTimeAsync(5_000);
        await stopping;
        expect(request.abortSignal?.aborted).toBe(true);
        expect(f.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("stop timed out"));
        gate.resolve();
        await starting;
        // The original cleanup owner keeps joining after its caller's deadline.
        await service.stop();
        expect(await f.store.listSessionEntries()).toEqual([]);
        await request.onUtterance({ text: "Retired callback" });
        await vi.advanceTimersByTimeAsync(65_000);
        expect(start).toHaveBeenCalledOnce();
        expect(await f.store.listSessionEntries()).toEqual([]);
      } finally {
        gate.resolve();
        await starting;
        await service.stop();
      }
    },
  );

  it("preserves a failed candidate after operator-stop takes ownership", async () => {
    const { f, service } = retryFixture({ realTimers: true });
    try {
      await service.start().settled;
      const { session } = (await f.store.listSessionEntries())[0]!;
      // A failed notes write must not undo the operator's revocation of retry custody.
      vi.spyOn(TranscriptsStore.prototype, "writeSummary").mockRejectedValueOnce(
        new Error("notes temporarily unavailable"),
      );
      await expect(
        f.tool.execute("stop", { action: "stop", selector: transcriptSessionSelector(session) }),
      ).rejects.toThrow("notes temporarily unavailable");
      expect(await f.store.readSummary(session)).toEqual({});
      const preserved = await f.store.readSession(session.sessionId);
      await service.stop();
      expect(await f.store.listSessionEntries()).toHaveLength(1);
      expect(await f.store.readSession(session.sessionId)).toEqual(preserved);
    } finally {
      await service.stop();
    }
  });
});
