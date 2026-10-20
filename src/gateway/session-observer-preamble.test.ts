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

function publisherFixture(
  preparePublication?: Parameters<
    typeof createSessionObserverPreamblePublisher
  >[0]["preparePublication"],
) {
  const publish = vi.fn();
  const publisher = createSessionObserverPreamblePublisher({
    isCurrent: () => true,
    preparePublication,
    publish,
  });
  onTestFinished(() => publisher.dispose());
  return { publish, publisher };
}

function replaceDigest(session: SessionObserverState) {
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

function preambleEvent(
  session: SessionObserverState,
  seq: number,
  progressText: string,
  ts = 1_000,
) {
  return {
    runId: "run-1",
    seq,
    stream: "item" as const,
    ts,
    sessionKey: session.sessionKey,
    agentId: session.agentId,
    data: { kind: "preamble", progressText },
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
  const { publish, publisher } = publisherFixture(async (_session, consume) => {
    const prepared = preparations.shift();
    if (!prepared) {
      throw new Error("Unexpected preamble preparation");
    }
    await prepared;
    consume();
  });
  const session = state("Earlier headline");
  const older = publisher.handle(session, preambleEvent(session, 1, "Older preamble"));
  publisher.clear(session);
  const newer = publisher.handle(session, preambleEvent(session, 2, "Newer preamble"));
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

it("remembers a preamble that matches a restored digest", async () => {
  const session = state("Checking files");
  const { publish, publisher } = publisherFixture();
  const event = preambleEvent(session, 1, "Checking files");

  await publisher.handle(session, event);
  replaceDigest(session);
  await publisher.handle(session, { ...event, seq: 2, ts: 2_001 });

  expect(session.lastPreambleHeadline).toBe("Checking files");
  expect(publish).not.toHaveBeenCalled();
});

it("does not restore an unchanged preamble after a richer digest replaces it", async () => {
  const session = state("Earlier headline");
  const { publish, publisher } = publisherFixture();
  const event = preambleEvent(session, 1, "Checking files");

  await publisher.handle(session, event);
  publisher.clear(session);
  replaceDigest(session);
  await publisher.handle(session, { ...event, seq: 2, ts: 2_001 });

  expect(publish).toHaveBeenCalledOnce();
});

it("replays a queued preamble after dormant-state revival", async () => {
  const original = state("Earlier headline");
  const { publish, publisher } = publisherFixture();
  await publisher.handle(original, preambleEvent(original, 1, "Published headline"));
  vi.setSystemTime(1_100);
  await publisher.handle(original, preambleEvent(original, 2, "Queued headline", Date.now()));
  const dormant = createDormantSessionObserverRun(original);
  publisher.clear(original);

  expect(dormant.lastPreambleHeadline).toBe("Published headline");
  const revived = state("Published headline");
  revived.lastPreambleHeadline = dormant.lastPreambleHeadline;
  await publisher.handle(revived, preambleEvent(revived, 3, "Queued headline", Date.now()));

  expect(publish).toHaveBeenCalledTimes(2);
  expect(revived.previousDigest?.headline).toBe("Queued headline");
});

it("preserves duplicate suppression across dormant-state revival", async () => {
  const original = state("Earlier headline");
  const { publish, publisher } = publisherFixture();
  await publisher.handle(original, preambleEvent(original, 1, "Checking files"));

  const revived = state("Reviewing the implementation");
  revived.lastPreambleHeadline = original.lastPreambleHeadline;
  await publisher.handle(revived, preambleEvent(revived, 2, "Checking files", 2_000));

  expect(publish).toHaveBeenCalledOnce();
});
