import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTranscriptsAutoStartService } from "./auto-start.js";
import type {
  TranscriptOccupancyWatchRequest,
  TranscriptSessionDescriptor,
  TranscriptStartRequest,
} from "./provider-types.js";
import {
  transcriptStatusRoom as room,
  useTranscriptStatusFixture,
} from "./status.producer.test-harness.js";

const fixture = useTranscriptStatusFixture();

describe("configured transcript occupancy diagnostics", () => {
  it("joins an initially occupied capture while releasing its watcher before startup settles", async () => {
    const f = fixture({ transcripts: { autoStart: [{ ...room, whenOccupied: true }] } });
    const entered = createDeferred<TranscriptStartRequest>();
    const gate = createDeferred();
    const unwatched = createDeferred();
    f.provider.watchOccupancy = async (request) => {
      request.onOccupied();
      return { ok: true, value: { stop: () => unwatched.resolve() } };
    };
    f.provider.start = async (request) => {
      entered.resolve(request);
      await gate.promise;
      return { ok: true, session: request.session };
    };
    const service = createTranscriptsAutoStartService(f.ctx);
    try {
      let settled = false;
      const starting = service.start().settled.then(() => {
        settled = true;
      });
      const request = await entered.promise;
      expect(settled).toBe(false);
      const stopping = service.stop();
      await unwatched.promise;
      expect(request.abortSignal?.aborted).toBe(true);
      expect(settled).toBe(false);
      gate.resolve();
      await starting;
      await stopping;
      expect((await f.read()).active).toEqual([]);
    } finally {
      gate.resolve();
      await service.stop();
    }
  });

  it.each(["retrying", "reopened", "starting", "reoccupied"] as const)(
    "settles a %s capture when its room becomes empty",
    async (mode) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const f = fixture({ transcripts: { autoStart: [{ ...room, whenOccupied: true }] } });
      const failed = mode === "retrying" || mode === "reopened";
      const original: TranscriptSessionDescriptor = {
        sessionId: "empty-history",
        startedAt: new Date(Date.now() - 120_000).toISOString(),
        stoppedAt: new Date(Date.now() - 60_000).toISOString(),
        source: { ...room, agentId: "main" },
        metadata: { sessionIdOrigin: "generated", agentId: "main" },
      };
      if (mode === "reopened") {
        await f.store.writeSession(original);
      }
      const gate = createDeferred();
      const startCalled = createDeferred();
      const watch = vi.fn(async (request: TranscriptOccupancyWatchRequest) => {
        request.onOccupied();
        return { ok: true as const, value: { stop: vi.fn() } };
      });
      f.provider.watchOccupancy = watch;
      const start = vi.fn(async (request: TranscriptStartRequest) => {
        startCalled.resolve();
        if (start.mock.calls.length === 1) {
          if (failed) {
            return { ok: false as const, error: "temporary capture failure" };
          }
          await gate.promise;
        }
        return { ok: true as const, session: request.session };
      });
      f.provider.start = start;
      const service = createTranscriptsAutoStartService(f.ctx);
      try {
        service.start();
        await startCalled.promise;
        expect(start).toHaveBeenCalledOnce();
        await vi.waitFor(async () =>
          expect((await f.read()).configuredSources[0]?.startDiagnostic).toBe(
            failed ? "retrying" : "starting",
          ),
        );
        const occupancy = watch.mock.calls[0]![0];
        occupancy.onEmpty();
        await vi.advanceTimersByTimeAsync(29_999);
        expect(start).toHaveBeenCalledOnce();
        if (!failed) {
          expect(start.mock.calls[0]![0].abortSignal?.aborted).toBe(false);
        }
        await vi.advanceTimersByTimeAsync(1);
        if (!failed) {
          expect(start.mock.calls[0]![0].abortSignal?.aborted).toBe(true);
        }
        if (mode === "reoccupied") {
          occupancy.onOccupied();
          expect(start).toHaveBeenCalledOnce();
        }
        gate.resolve();
        await vi.waitFor(async () =>
          expect((await f.read()).configuredSources[0]?.state).toBe(
            mode === "reoccupied" ? "armed" : "not-active",
          ),
        );
        expect((await f.read()).configuredSources[0]).not.toHaveProperty("startDiagnostic");
        await vi.advanceTimersByTimeAsync(65_000);
        expect(start).toHaveBeenCalledTimes(mode === "reoccupied" ? 2 : 1);
        expect((await f.read()).active).toHaveLength(mode === "reoccupied" ? 1 : 0);
        expect(await f.store.listSessionEntries()).toHaveLength(mode === "retrying" ? 0 : 1);
        if (mode === "reopened") {
          expect(start.mock.calls[0]![0].session.sessionId).toBe(original.sessionId);
          expect(await f.store.readSession(original.sessionId)).toEqual(original);
        }
      } finally {
        gate.resolve();
        await service.stop();
      }
    },
  );

  it.each(["unsupported", "guild-conflict", "empty"] as const)(
    "settles occupancy watcher retries after %s registration",
    async (mode) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const entry = { ...room, whenOccupied: true };
      const entries =
        mode === "guild-conflict" ? [entry, { ...entry, channelId: "other-room" }] : [entry];
      const f = fixture({ transcripts: { autoStart: entries } });
      const watch = vi.fn(async (request: TranscriptOccupancyWatchRequest) => {
        if (mode === "guild-conflict") {
          request.onOccupied();
        }
        return { ok: true as const, value: { stop: vi.fn() } };
      });
      if (mode !== "unsupported") {
        f.provider.watchOccupancy = watch;
      }
      const start = vi.fn(f.provider.start!);
      f.provider.start = start;
      f.setProviders([]);
      const service = createTranscriptsAutoStartService(f.ctx);
      try {
        service.start();
        expect((await f.read()).configuredSources.map((source) => source.startDiagnostic)).toEqual(
          entries.map(() => "retrying"),
        );
        f.setProviders([f.provider]);
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.waitFor(async () =>
          expect((await f.read()).configuredSources.map((source) => source.state)).toEqual(
            mode === "guild-conflict" ? ["armed", "not-active"] : ["not-active"],
          ),
        );
        expect(watch).toHaveBeenCalledTimes(mode === "unsupported" ? 0 : 1);
        expect(start).toHaveBeenCalledTimes(mode === "guild-conflict" ? 1 : 0);
        if (mode === "empty") {
          expect((await f.read()).configuredSources[0]).not.toHaveProperty("startDiagnostic");
          expect(await f.store.listSessionEntries()).toHaveLength(0);
          watch.mock.calls[0]![0].onOccupied();
          await vi.waitFor(async () =>
            expect((await f.read()).configuredSources[0]?.state).toBe("armed"),
          );
        } else {
          expect((await f.read()).configuredSources.at(-1)?.startDiagnostic).toBe("start-failed");
        }
        await vi.advanceTimersByTimeAsync(65_000);
        expect(watch).toHaveBeenCalledTimes(mode === "unsupported" ? 0 : 1);
        expect(start).toHaveBeenCalledTimes(mode === "unsupported" ? 0 : 1);
      } finally {
        await service.stop();
      }
    },
  );
});
