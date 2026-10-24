import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createSessionActivityNoteState } from "../agents/session-activity-notes.js";
import {
  createDormantSessionObserverRun,
  type SessionObserverState,
} from "./session-observer-model.js";
import { createSessionObserverPreamblePublisher } from "./session-observer-preamble.js";

function state(headline: string): SessionObserverState {
  return {
    ...createSessionActivityNoteState(),
    sessionKey: "agent:main:session-1",
    runId: "run-1",
    agentId: "main",
    startedAt: 0,
    lastActivityAt: 0,
    lastRunAt: 0,
    revision: 1,
    digestCount: 0,
    consecutiveFailures: 0,
    lastDigestNoteSequence: 0,
    previousDigest: {
      sessionKey: "agent:main:session-1",
      runId: "run-1",
      revision: 1,
      updatedAt: 1,
      headline,
      health: "on-track",
    },
    inFlight: false,
    finalPending: false,
  };
}

function fixture(
  headline: string,
  preparePublication?: Parameters<
    typeof createSessionObserverPreamblePublisher
  >[0]["preparePublication"],
) {
  const session = state(headline);
  const publish = vi.fn();
  const publisher = createSessionObserverPreamblePublisher({
    isCurrent: () => true,
    preparePublication,
    publish,
  });
  onTestFinished(() => publisher.dispose());
  return {
    session,
    publish,
    publisher,
    send: (progressText: string, target = session, ts = Date.now()) =>
      publisher.handle(target, {
        runId: "run-1",
        seq: 1,
        stream: "item",
        ts,
        data: { kind: "preamble", progressText },
      }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});

afterEach(() => vi.useRealTimers());

it("preserves a replacement preamble when an older authority read finishes", async () => {
  const olderRead = Promise.withResolvers<void>();
  const newerRead = Promise.withResolvers<void>();
  const preparations = [olderRead.promise, newerRead.promise];
  const { session, publish, publisher, send } = fixture(
    "Earlier headline",
    async (_session, consume) => {
      const prepared = preparations.shift();
      if (!prepared) {
        throw new Error("Unexpected preamble preparation");
      }
      await prepared;
      consume();
    },
  );
  const older = send("Older preamble");
  publisher.clear(session);
  const newer = send("Newer preamble");
  try {
    olderRead.resolve();
    await older;
    newerRead.resolve();
    await newer;
    expect(publish).toHaveBeenCalledOnce();
    expect(session.previousDigest).toMatchObject({ headline: "Newer preamble", revision: 2 });
  } finally {
    olderRead.resolve();
    newerRead.resolve();
    await Promise.allSettled([older, newer]);
  }
});

it.each(["restored", "richer", "revived"] as const)(
  "does not replay a remembered preamble after a %s digest",
  async (mode) => {
    const { session, publish, publisher, send } = fixture(
      mode === "restored" ? "Checking files" : "Earlier headline",
    );
    await send("Checking files");
    let target = session;
    if (mode === "revived") {
      target = state("Reviewing the implementation");
      target.lastPreambleHeadline = session.lastPreambleHeadline;
    } else {
      if (mode === "richer") {
        publisher.clear(session);
      }
      if (!session.previousDigest) {
        throw new Error("expected previous digest");
      }
      session.previousDigest = {
        ...session.previousDigest,
        revision: 2,
        headline: "Reviewing the implementation",
        updatedAt: 2_000,
      };
    }
    await send("Checking files", target, mode === "revived" ? 2_000 : 2_001);
    expect(target.lastPreambleHeadline).toBe("Checking files");
    expect(publish).toHaveBeenCalledTimes(mode === "restored" ? 0 : 1);
  },
);

it("replays a queued preamble after dormant-state revival", async () => {
  const { session: original, publish, publisher, send } = fixture("Earlier headline");
  await send("Published headline");
  vi.setSystemTime(1_100);
  await send("Queued headline");
  const dormant = createDormantSessionObserverRun(original);
  publisher.clear(original);

  expect(dormant.lastPreambleHeadline).toBe("Published headline");
  const revived = state("Published headline");
  revived.lastPreambleHeadline = dormant.lastPreambleHeadline;
  await send("Queued headline", revived);

  expect(publish).toHaveBeenCalledTimes(2);
  expect(revived.previousDigest?.headline).toBe("Queued headline");
});
