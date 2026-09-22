import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTranscriptsAutoStartService } from "./auto-start.js";
import { activeSessions } from "./capture.js";
import type { TranscriptOccupancyWatchRequest, TranscriptStartRequest } from "./provider-types.js";
import { readTranscriptLibraryStatus } from "./status.js";
import {
  transcriptStatusRoom as room,
  useTranscriptStatusFixture,
} from "./status.producer.test-harness.js";
import { transcriptSessionSelector, TranscriptsStore } from "./store.js";

const fixture = useTranscriptStatusFixture();

describe("configured transcript shutdown cleanup", () => {
  it.each(
    [false, true].flatMap((whenOccupied) =>
      ["returned-stop", "thrown-stop", "session-write", "summary-write"].map((fault) => ({
        whenOccupied,
        fault,
      })),
    ),
  )(
    "retains and drains late $fault after shutdown (occupied=$whenOccupied)",
    async ({ whenOccupied, fault }) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const f = fixture({ transcripts: { autoStart: [{ ...room, whenOccupied }] } });
      const watches: TranscriptOccupancyWatchRequest[] = [];
      const unwatch = vi.fn();
      f.provider.watchOccupancy = async (request) => {
        watches.push(request);
        request.onOccupied();
        return { ok: true, value: { stop: unwatch } };
      };
      const gate = createDeferred();
      const started = createDeferred<TranscriptStartRequest>();
      const lateDrain = createDeferred();
      const conflict = createDeferred();
      f.ctx.logger.warn.mockImplementation((message: string) => {
        if (message.startsWith("transcripts autoStart session=")) {
          lateDrain.resolve();
        }
        if (message.startsWith("transcripts autoStart source 1: id-conflict.")) {
          conflict.resolve();
        }
      });
      const start = vi.fn(async (request: TranscriptStartRequest) => {
        await request.onUtterance({ text: "Before shutdown" });
        // Shutdown starts only after the pre-shutdown note is durably recorded.
        started.resolve(request);
        await gate.promise;
        await request.onUtterance({ text: "After shutdown" });
        return { ok: true as const, session: { ...request.session, title: "Late title" } };
      });
      f.provider.start = start;
      let cleanupFails = true;
      const stop = vi.spyOn(f.provider, "stop").mockImplementation(async ({ sessionId }) => {
        if (cleanupFails && fault === "returned-stop") {
          return { ok: false, error: "cleanup unavailable" };
        }
        if (cleanupFails && fault === "thrown-stop") {
          throw new Error("cleanup unavailable");
        }
        return { ok: true, sessionId };
      });
      const writeSession = f.store.writeSession.bind(f.store);
      vi.spyOn(TranscriptsStore.prototype, "writeSession").mockImplementation(
        async (session, condition) => {
          if (cleanupFails && fault === "session-write" && session.stoppedAt) {
            throw new Error("final session unavailable");
          }
          await writeSession(session, condition);
        },
      );
      const writeSummary = f.store.writeSummary.bind(f.store);
      vi.spyOn(TranscriptsStore.prototype, "writeSummary").mockImplementation(async (...args) => {
        if (cleanupFails && fault === "summary-write") {
          throw new Error("summary unavailable");
        }
        return writeSummary(...args);
      });
      const service = createTranscriptsAutoStartService(f.ctx);
      try {
        service.start();
        const request = await started.promise;
        expect(start).toHaveBeenCalledOnce();
        const session = request.session;
        const stopping = service.stop();
        await vi.advanceTimersByTimeAsync(5_000);
        await stopping;
        expect(f.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("stop timed out"));
        expect(unwatch).toHaveBeenCalledTimes(whenOccupied ? 1 : 0);
        expect(request.abortSignal?.aborted).toBe(true);
        gate.resolve();
        // A failed late drain must be visible and still owned after startup settles.
        await lateDrain.promise;
        expect(f.ctx.logger.warn).toHaveBeenCalledWith(
          expect.stringContaining("transcripts autoStart session="),
        );
        const terminal = fault === "session-write" || fault === "summary-write";
        await expect(f.tool.execute("status", { action: "status" })).resolves.toMatchObject({
          details: {
            [terminal ? "pendingFinalization" : "active"]: [
              expect.objectContaining({ sessionId: session.sessionId }),
            ],
          },
        });
        const otherConfig = {
          transcripts: { autoStart: [{ ...room, sessionId: session.sessionId }] },
        };
        const other = createTranscriptsAutoStartService({ ...f.ctx, config: otherConfig });
        try {
          other.start();
          await conflict.promise;
          expect(
            (await readTranscriptLibraryStatus(f.store, otherConfig)).configuredSources[0]
              ?.startDiagnostic,
          ).toBe("id-conflict");
        } finally {
          await other.stop();
        }
        expect(stop).toHaveBeenCalledTimes(terminal ? 1 : 2);
        cleanupFails = false;
        await service.stop();
        expect(stop).toHaveBeenCalledTimes(terminal ? 1 : 3);
        expect(activeSessions.has(session.sessionId)).toBe(false);
        expect((await f.store.readSession(session.sessionId))?.stoppedAt).toEqual(
          expect.any(String),
        );
        expect(await f.store.readSummary(session)).toMatchObject({
          summary: { transcript: ["Before shutdown"] },
        });
        watches[0]?.onEmpty();
        watches[0]?.onOccupied();
        await request.onUtterance({ text: "Retired callback" });
        await request.onStatus?.({ active: false });
        await vi.advanceTimersByTimeAsync(65_000);
        expect(start).toHaveBeenCalledOnce();
        expect(await f.store.listSessionEntries()).toHaveLength(1);
        expect(await f.store.readUtterancesForSession(session)).toMatchObject([
          { text: "Before shutdown" },
        ]);
        // Even the same raw ID on a later day belongs to a distinct lifecycle.
        vi.setSystemTime(new Date(Date.parse(session.startedAt) + 86_400_000));
        await f.start({ ...room, sessionId: session.sessionId });
        await service.stop();
        expect(stop).toHaveBeenCalledTimes(terminal ? 1 : 3);
        expect((await f.read()).active).toMatchObject([
          { sessionId: session.sessionId, activeSubscription: true },
        ]);
      } finally {
        cleanupFails = false;
        gate.resolve();
        await service.stop();
        for (const [request] of start.mock.calls) {
          await f.tool.execute("cleanup", {
            action: "stop",
            selector: transcriptSessionSelector(request.session),
          });
        }
      }
    },
  );
});
