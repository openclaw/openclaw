import { expect, it, vi } from "vitest";
import { createTranscriptsAutoStartService } from "./auto-start.js";
import {
  transcriptStatusRoom as room,
  useTranscriptStatusFixture,
} from "./status.producer.test-harness.js";
import { transcriptSessionSelector, TranscriptsStore } from "./store.js";

const fixture = useTranscriptStatusFixture();

it.each(["same date", "next date"] as const)(
  "reconciles a fixed ID on the %s after provider-selective stop",
  async (date) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const startedAt = Date.parse("2026-09-05T10:00:00.000Z");
    vi.setSystemTime(startedAt);
    const f = fixture({ transcripts: { autoStart: [{ ...room, sessionId: "daily" }] } });
    const start = vi.fn(f.provider.start!);
    f.provider.start = start;
    const service = createTranscriptsAutoStartService(f.ctx);
    try {
      service.start();
      await vi.waitFor(async () => expect((await f.read()).active).toHaveLength(1));
      const original = start.mock.calls[0]![0].session;
      await service.stop(new Set([room.providerId]));
      const selector = transcriptSessionSelector(original);
      const saved = await f.store.readSession(selector);
      f.ctx.logger.warn.mockClear();
      const write = vi.spyOn(TranscriptsStore.prototype, "writeSession");
      // A new admission has a new tuple even on the same date.
      vi.setSystemTime(startedAt + 60_000 + (date === "next date" ? 86_400_000 : 0));
      service.start();
      if (date === "same date") {
        await vi.waitFor(async () =>
          expect((await f.read()).configuredSources[0]?.startDiagnostic).not.toBe("starting"),
        );
        expect.soft((await f.read()).configuredSources[0]?.startDiagnostic).toBe("id-conflict");
        await vi.advanceTimersByTimeAsync(65_000);
        expect(write).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledOnce();
        expect(f.ctx.logger.warn).toHaveBeenCalledOnce();
        expect(f.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("id-conflict"));
      } else {
        await vi.waitFor(async () => expect((await f.read()).active).toHaveLength(1));
        expect(start).toHaveBeenCalledTimes(2);
        expect(write).toHaveBeenCalledOnce();
        expect(start.mock.calls[1]![0].session.startedAt).not.toBe(original.startedAt);
        expect(f.ctx.logger.warn).not.toHaveBeenCalled();
      }
      await expect(f.store.readSession(selector)).resolves.toEqual(saved);
    } finally {
      await service.stop();
    }
  },
);
