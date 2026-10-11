import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { TranscriptStartError } from "./capture-startup.js";
import { isTranscriptSessionStarting, startTranscripts } from "./capture.js";
import type { TranscriptSessionDescriptor, TranscriptStartRequest } from "./provider-types.js";
import {
  transcriptStatusRoom as room,
  useTranscriptStatusFixture,
} from "./status.producer.test-harness.js";

const fixture = useTranscriptStatusFixture();

async function startCapture(sessionId: string) {
  const f = fixture();
  const started = createDeferred<TranscriptStartRequest>();
  f.provider.start = async (request) => {
    started.resolve(request);
    return { ok: true, session: request.session };
  };
  await f.start({ ...room, sessionId });
  return { f, request: await started.promise };
}

describe("transcript capture accepted append drainage", () => {
  it("rejects unserializable speech promptly and drains accepted speech before terminal notes", async () => {
    const { f, request } = await startCapture("terminal-drain");
    const appendEntered = createDeferred();
    const releaseAppend = createDeferred();
    const events: string[] = [];
    const append = f.store.appendUtteranceForSession.bind(f.store);
    vi.spyOn(f.store, "appendUtteranceForSession").mockImplementation(async (...args) => {
      if (args[1].text === "First accepted speech") {
        appendEntered.resolve();
        await releaseAppend.promise;
      }
      await append(...args);
      events.push(args[1].text);
    });
    const writeSession = f.store.writeSession.bind(f.store);
    vi.spyOn(f.store, "writeSession").mockImplementation(async (...args) => {
      if (args[0].stoppedAt) {
        events.push("stopped metadata");
      }
      return writeSession(...args);
    });
    const writeSummary = f.store.writeSummary.bind(f.store);
    vi.spyOn(f.store, "writeSummary").mockImplementation(async (...args) => {
      events.push("summary");
      return writeSummary(...args);
    });

    const first = Promise.resolve(request.onUtterance({ text: "First accepted speech" }));
    const failure = new Error("Metadata cannot be serialized");
    const toJSON = vi.fn(() => {
      throw failure;
    });
    const rejected = Promise.resolve(
      request.onUtterance({ text: "Unserializable speech", metadata: { toJSON } }),
    );
    const second = Promise.resolve(request.onUtterance({ text: "Second accepted speech" }));
    let terminal: Promise<void> | undefined;
    try {
      await appendEntered.promise;
      await expect(rejected).rejects.toBe(failure);
      expect.soft(await f.store.readUtterancesForSession(request.session)).toEqual([]);
      terminal = Promise.resolve(request.onStatus?.({ active: false }));
      // Allow the terminal callback to reach storage while the accepted append is held.
      await setImmediate();
      expect.soft(events).toEqual([]);
    } finally {
      releaseAppend.resolve();
      await Promise.allSettled([first, rejected, second, terminal]);
    }
    await Promise.all([first, second, terminal]);
    expect(toJSON).toHaveBeenCalledOnce();
    expect((await f.store.readSession(request.session.sessionId))?.stoppedAt).toEqual(
      expect.any(String),
    );
    expect
      .soft(events)
      .toEqual(["First accepted speech", "Second accepted speech", "stopped metadata", "summary"]);
    expect
      .soft((await f.store.readUtterancesForSession(request.session)).map((row) => row.text))
      .toEqual(["First accepted speech", "Second accepted speech"]);
    expect.soft(await f.store.readSummary(request.session)).toMatchObject({
      summary: {
        utteranceCount: 2,
        transcript: ["First accepted speech", "Second accepted speech"],
      },
    });
    await request.onUtterance({ text: "Retired callback" });
    expect(await f.store.readUtterancesForSession(request.session)).toHaveLength(2);
  });

  it("fences new speech before draining failed post-start setup and retains cleanup retry", async () => {
    const f = fixture();
    const started = createDeferred<TranscriptStartRequest>();
    const firstEntered = createDeferred();
    const releaseFirst = createDeferred();
    const releaseLate = createDeferred();
    const titleFailed = createDeferred();
    const stopAttempted = createDeferred();
    const append = f.store.appendUtteranceForSession.bind(f.store);
    vi.spyOn(f.store, "appendUtteranceForSession").mockImplementation(async (...args) => {
      if (args[1].text === "Accepted before title failure") {
        firstEntered.resolve();
        await releaseFirst.promise;
      } else {
        await releaseLate.promise;
      }
      await append(...args);
    });
    const writeSession = f.store.writeSession.bind(f.store);
    vi.spyOn(f.store, "writeSession").mockImplementation(async (...args) => {
      if (args[0].title === "Provider title" && !args[0].stoppedAt) {
        titleFailed.resolve();
        throw new Error("Title write unavailable");
      }
      await writeSession(...args);
    });
    let first: Promise<void> | undefined;
    let late: Promise<void> | undefined;
    f.provider.start = async (request) => {
      started.resolve(request);
      first = Promise.resolve(request.onUtterance({ text: "Accepted before title failure" }));
      void first.catch(() => undefined);
      return { ok: true, session: { ...request.session, title: "Provider title" } };
    };
    let cleanupSucceeds = false;
    let stopCalls = 0;
    f.provider.stop = async ({ sessionId }) => {
      stopCalls++;
      stopAttempted.resolve();
      return cleanupSucceeds
        ? { ok: true, sessionId }
        : { ok: false, error: "Provider cleanup unavailable" };
    };
    let startupSettled = false;
    let lateSettled = false;
    const startup = f.start({ ...room, sessionId: "failed-title-drain" }).then(
      () => {
        startupSettled = true;
        return undefined;
      },
      (error: unknown) => {
        startupSettled = true;
        return error;
      },
    );
    const request = await started.promise;
    try {
      await Promise.all([firstEntered.promise, titleFailed.promise]);
      // Let the failed-start catch reach its drain while accepted speech remains held.
      await setImmediate();
      late = Promise.resolve(request.onUtterance({ text: "Speech after title failure" }));
      void late.then(
        () => {
          lateSettled = true;
        },
        () => {
          lateSettled = true;
        },
      );
      await setImmediate();
      expect.soft(lateSettled).toBe(true);
      releaseFirst.resolve();
      await first;
      await stopAttempted.promise;
      await setImmediate();
      expect.soft(startupSettled).toBe(true);
      expect.soft(lateSettled).toBe(true);
    } finally {
      releaseFirst.resolve();
      releaseLate.resolve();
      await Promise.allSettled([first, late, startup]);
    }
    await first;
    await late;
    const failure = await startup;
    expect(failure).toBeInstanceOf(TranscriptStartError);
    expect(failure).toMatchObject({
      code: "admitted-start-failed",
      retry: undefined,
      cause: expect.objectContaining({
        message: expect.stringContaining("provider cleanup failed"),
      }),
    });
    expect.soft(stopCalls).toBe(1);
    expect
      .soft((await f.store.readUtterancesForSession(request.session)).map((row) => row.text))
      .toEqual(["Accepted before title failure"]);
    cleanupSucceeds = true;
    await expect(
      f.tool.execute("cleanup-retry", { action: "stop", sessionId: request.session.sessionId }),
    ).resolves.toMatchObject({
      details: {
        sessionId: request.session.sessionId,
        summary: { transcript: ["Accepted before title failure"] },
      },
    });
    expect((await f.store.readSession(request.session.sessionId))?.stoppedAt).toEqual(
      expect.any(String),
    );
    expect(stopCalls).toBe(2);
  });

  it.each([false, true])(
    "drains startup speech before restoring stop state and retry authority (reopened: %s)",
    async (reopened) => {
      const f = fixture();
      const original: TranscriptSessionDescriptor | undefined = reopened
        ? {
            sessionId: "reopened-rejected-append",
            startedAt: "2026-09-18T09:00:00.000Z",
            stoppedAt: "2026-09-18T09:05:00.000Z",
            source: room,
            title: "Existing meeting",
            metadata: { agentId: "main", sessionIdOrigin: "supplied" },
          }
        : undefined;
      if (original) {
        await f.store.writeSession(original);
        await f.store.appendUtteranceForSession(original, { text: "Previously saved speech" });
      }
      const revision = original && (await f.store.readSummaryInputRevision(original));
      const appendEntered = createDeferred();
      const releaseAppend = createDeferred();
      const failStart = createDeferred();
      const providerFailed = createDeferred();
      const started = createDeferred<TranscriptStartRequest>();
      const appendFailure = new Error("Accepted append failed before writing");
      const providerFailure = new Error("Provider startup failed");
      const events: string[] = [];
      const append = f.store.appendUtteranceForSession.bind(f.store);
      vi.spyOn(f.store, "appendUtteranceForSession").mockImplementation(async (...args) => {
        appendEntered.resolve();
        await releaseAppend.promise;
        if (reopened) {
          throw appendFailure;
        }
        await append(...args);
        events.push("accepted speech");
      });
      const writeSession = f.store.writeSession.bind(f.store);
      vi.spyOn(f.store, "writeSession").mockImplementation(async (...args) => {
        if (args[0].stoppedAt) {
          events.push("restored stop state");
        }
        return writeSession(...args);
      });
      const readRevision = f.store.readSummaryInputRevision.bind(f.store);
      vi.spyOn(f.store, "readSummaryInputRevision").mockImplementation(async (...args) => {
        events.push("retry revision");
        return readRevision(...args);
      });
      let accepted: Promise<void> | undefined;
      f.provider.start = async (request) => {
        started.resolve(request);
        accepted = Promise.resolve(request.onUtterance({ text: "Speech before startup failed" }));
        void accepted.catch(() => undefined);
        await failStart.promise;
        providerFailed.resolve();
        throw providerFailure;
      };
      const startup = (
        original
          ? startTranscripts({
              ctx: { ...f.ctx, caller: { kind: "operator", source: "local" } },
              store: f.store,
              rawParams: { ...room, sessionId: original.sessionId },
              existingSession: original,
              existingSessionCondition: { expectedInputRevision: revision },
            })
          : f.start({ ...room, sessionId: "startup-drain" })
      ).then(
        () => undefined,
        (error: unknown) => {
          events.push("start rejected");
          return error;
        },
      );
      const request = await started.promise;
      try {
        await appendEntered.promise;
        failStart.resolve();
        await providerFailed.promise;
        await setImmediate();
        expect.soft(events).toEqual([]);
        const reserved = isTranscriptSessionStarting(request.session.sessionId);
        expect.soft(reserved).toBe(true);
        if (reserved) {
          await expect(
            f.start({ ...room, sessionId: request.session.sessionId }),
          ).rejects.toMatchObject({ code: "id-conflict" });
        }
      } finally {
        failStart.resolve();
        releaseAppend.resolve();
        await Promise.allSettled([accepted, startup]);
      }
      if (reopened) {
        await expect(accepted).rejects.toBe(appendFailure);
      } else {
        await accepted;
      }
      const failure = await startup;
      expect(failure).toBeInstanceOf(TranscriptStartError);
      if (!(failure instanceof TranscriptStartError)) {
        throw new Error("Expected failed startup to retain transcript retry authority");
      }
      expect
        .soft(events)
        .toEqual([
          ...(reopened ? [] : ["accepted speech"]),
          "restored stop state",
          "retry revision",
          "start rejected",
        ]);
      expect(failure.retry?.revision).toBe(await readRevision(request.session));
      expect(failure.retry?.session.stoppedAt).toEqual(expect.any(String));
      expect(isTranscriptSessionStarting(request.session.sessionId)).toBe(false);
      expect(await f.store.readUtterancesForSession(request.session)).toMatchObject([
        { text: reopened ? "Previously saved speech" : "Speech before startup failed" },
      ]);
      if (original) {
        expect(failure.code).toBe("admitted-start-failed");
        expect(failure.retry).toEqual({
          session: original,
          revision: await readRevision(original),
        });
        expect(failure.cause).toBeInstanceOf(AggregateError);
        expect(failure.cause).toMatchObject({ errors: [providerFailure, appendFailure] });
        expect.soft(await f.store.readSession(original.sessionId)).toEqual(original);
      }
    },
  );

  it("drains an accepted append when its metadata serialization ends the capture", async () => {
    const { f, request } = await startCapture("serialization-terminal");
    const terminal = createDeferred();
    const toJSON = vi.fn(() => {
      // Provider metadata can synchronously end capture while this speech is being prepared.
      void Promise.resolve(request.onStatus?.({ active: false })).then(
        terminal.resolve,
        terminal.reject,
      );
      return { caption: "final" };
    });
    const accepted = Promise.resolve(
      request.onUtterance({ text: "Speech that ends capture", metadata: { toJSON } }),
    );
    await Promise.all([accepted, terminal.promise]);

    expect(toJSON).toHaveBeenCalledOnce();
    expect(await f.store.readUtterancesForSession(request.session)).toMatchObject([
      { text: "Speech that ends capture", metadata: { caption: "final" } },
    ]);
    expect(await f.store.readSummary(request.session)).toMatchObject({
      summary: { utteranceCount: 1, transcript: ["Speech that ends capture"] },
    });
    expect((await f.store.readSession(request.session.sessionId))?.stoppedAt).toEqual(
      expect.any(String),
    );
    await request.onUtterance({ text: "Retired callback" });
    expect(await f.store.readUtterancesForSession(request.session)).toHaveLength(1);
  });
});
