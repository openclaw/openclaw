import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTranscriptsAutoStartService } from "./auto-start.js";
import type { TranscriptStartRequest } from "./provider-types.js";
import {
  transcriptStatusRoom as room,
  useTranscriptStatusFixture,
} from "./status.producer.test-harness.js";
import { transcriptSessionSelector, TranscriptsStore } from "./store.js";

const fixture = useTranscriptStatusFixture();

describe("configured transcript failed-start custody", () => {
  it.each([
    { whenOccupied: false, accepted: false },
    { whenOccupied: true, accepted: false },
    { whenOccupied: false, accepted: true },
  ])(
    "discards only exhausted empty admissions (occupied=$whenOccupied, accepted=$accepted)",
    async ({ whenOccupied, accepted }) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const f = fixture({ transcripts: { autoStart: [{ ...room, whenOccupied }] } });
      f.provider.watchOccupancy = async (request) => {
        request.onOccupied();
        return { ok: true, value: { stop() {} } };
      };
      const attempts = accepted ? 3 : 12;
      const start = vi.fn(async (request: TranscriptStartRequest) =>
        accepted && start.mock.calls.length === attempts
          ? { ok: true as const, session: request.session }
          : { ok: false as const, error: "provider unavailable" },
      );
      f.provider.start = start;
      const service = createTranscriptsAutoStartService(f.ctx);
      try {
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

  it("discards a new empty failed startup when shutdown abandons its retry", async () => {
    const f = fixture();
    const start = vi.fn(async () => ({ ok: false as const, error: "provider unavailable" }));
    f.provider.start = start;
    const service = createTranscriptsAutoStartService(f.ctx);
    try {
      await service.start().settled;
      expect(start).toHaveBeenCalledOnce();
      expect((await f.read()).configuredSources[0]?.startDiagnostic).toBe("retrying");
      expect(await f.store.listSessionEntries()).toHaveLength(1);
      await service.stop();
      expect(await f.store.listSessionEntries()).toEqual([]);
    } finally {
      await service.stop();
    }
  });

  it.each(["stop", "retry"] as const)(
    "preserves a rewrite during pending provider startup before %s",
    async (action) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const f = fixture();
      const entered = createDeferred<TranscriptStartRequest>();
      const release = createDeferred();
      const start = vi.fn(async (request: TranscriptStartRequest) => {
        entered.resolve(request);
        await release.promise;
        return { ok: false as const, error: "provider unavailable" };
      });
      f.provider.start = start;
      const service = createTranscriptsAutoStartService(f.ctx);
      const starting = service.start().settled;
      try {
        const request = await entered.promise;
        const rewritten = { ...request.session, title: "Operator rewrite during startup" };
        await f.store.writeSession(rewritten);
        release.resolve();
        await starting;
        if (action === "retry") {
          await vi.advanceTimersByTimeAsync(5_000);
          await service.start().settled;
        }
        await service.stop();
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
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const f = fixture({ transcripts: { autoStart: [{ ...room, title: "Meeting \ud800" }] } });
      const start = vi.fn(async () => ({ ok: false as const, error: "provider unavailable" }));
      f.provider.start = start;
      const service = createTranscriptsAutoStartService(f.ctx);
      try {
        await service.start().settled;
        expect((await f.store.listSessionEntries())[0]?.session.title).toBe("Meeting \ufffd");
        if (action === "retry") {
          await vi.advanceTimersByTimeAsync(5_000);
          await service.start().settled;
        }
        await service.stop();
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
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const f = fixture();
      const start = vi.fn(async () => ({ ok: false as const, error: "provider unavailable" }));
      f.provider.start = start;
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
      const service = createTranscriptsAutoStartService(f.ctx);
      try {
        await service.start().settled;
        const { session } = (await f.store.listSessionEntries())[0]!;
        expect(rewritten).toBe(true);
        expect(session.title).toBe("Operator-owned meeting");
        if (action === "retry") {
          await vi.advanceTimersByTimeAsync(5_000);
          await service.start().settled;
        }
        await service.stop();
        expect(start).toHaveBeenCalledOnce();
        expect(await f.store.readSession(session.sessionId)).toEqual(session);
      } finally {
        await service.stop();
      }
    },
  );

  it("preserves a failed row adopted by a replacement service and lets its retry start", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const f = fixture({ transcripts: { autoStart: [{ ...room, whenOccupied: true }] } });
    f.provider.watchOccupancy = async (request) => {
      request.onOccupied();
      return { ok: true, value: { stop() {} } };
    };
    const start = vi.fn(async (request: TranscriptStartRequest) =>
      start.mock.calls.length < 3
        ? { ok: false as const, error: "provider unavailable" }
        : { ok: true as const, session: request.session },
    );
    f.provider.start = start;
    const retiring = createTranscriptsAutoStartService(f.ctx);
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
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const f = fixture({ transcripts: { autoStart: [{ ...room, whenOccupied: true }] } });
      f.provider.watchOccupancy = async (request) => {
        request.onOccupied();
        return { ok: true, value: { stop() {} } };
      };
      const start = vi.fn(async (request: TranscriptStartRequest) =>
        start.mock.calls.length === 1
          ? { ok: false as const, error: "provider unavailable" }
          : { ok: true as const, session: request.session },
      );
      f.provider.start = start;
      const retiring = createTranscriptsAutoStartService(f.ctx);
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
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const f = fixture({ transcripts: { autoStart: [{ ...room, whenOccupied }] } });
      const entered = createDeferred<TranscriptStartRequest>();
      const gate = createDeferred();
      f.provider.watchOccupancy = async (request) => {
        request.onOccupied();
        return { ok: true, value: { stop() {} } };
      };
      const start = vi.fn(async (request: TranscriptStartRequest) => {
        entered.resolve(request);
        await gate.promise;
        throw new Error("provider failed after shutdown");
      });
      f.provider.start = start;
      const service = createTranscriptsAutoStartService(f.ctx);
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

  it.each(["operator-stop", "rewritten"] as const)(
    "preserves a failed candidate after %s takes ownership",
    async (change) => {
      const f = fixture();
      f.provider.start = async () => ({ ok: false, error: "provider unavailable" });
      const service = createTranscriptsAutoStartService(f.ctx);
      try {
        await service.start().settled;
        const { session } = (await f.store.listSessionEntries())[0]!;
        if (change === "operator-stop") {
          // Revoke through the operator entry point without notes or exports masking
          // the authority check that must preserve this otherwise empty candidate.
          vi.spyOn(TranscriptsStore.prototype, "writeSummary").mockRejectedValueOnce(
            new Error("notes temporarily unavailable"),
          );
          await expect(
            f.tool.execute("stop", {
              action: "stop",
              selector: transcriptSessionSelector(session),
            }),
          ).rejects.toThrow("notes temporarily unavailable");
          expect(await f.store.readSummary(session)).toEqual({});
        } else {
          await f.store.writeSession({ ...session, title: "Operator-owned meeting" });
        }
        const preserved = await f.store.readSession(session.sessionId);
        await service.stop();
        expect(await f.store.listSessionEntries()).toHaveLength(1);
        expect(await f.store.readSession(session.sessionId)).toEqual(preserved);
      } finally {
        await service.stop();
      }
    },
  );
});
