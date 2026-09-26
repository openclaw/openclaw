import { describe, expect, it, vi } from "vitest";
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

function publisherFixture(now: () => number = () => 1_000) {
  const publish = vi.fn();
  const publisher = createSessionObserverPreamblePublisher({
    now,
    setTimeoutFn: setTimeout,
    clearTimeoutFn: clearTimeout,
    isCurrent: () => true,
    publish,
  });
  return { publish, publisher };
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

describe("session observer preamble publisher", () => {
  it("keeps generation stable for duplicate snapshots while clearing publication state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const session = state("Earlier headline");
    const { publisher } = publisherFixture(Date.now);

    publisher.handle(session, preambleEvent(session, 1, "Current headline"));
    publisher.handle(session, preambleEvent(session, 2, "Current headline"));
    expect(publisher.generation(session)).toBe(1);

    vi.advanceTimersByTime(2_000);
    expect(publisher.generation(session)).toBe(1);
    publisher.dispose();
    vi.useRealTimers();
  });

  it("remembers a preamble that matches a restored digest", () => {
    const session = state("Checking files");
    const { publish, publisher } = publisherFixture();
    const event = preambleEvent(session, 1, "Checking files");

    publisher.handle(session, event);
    const previousDigest = session.previousDigest;
    if (!previousDigest) {
      throw new Error("expected previous digest");
    }
    session.previousDigest = {
      ...previousDigest,
      revision: 2,
      headline: "Reviewing the implementation",
      updatedAt: 2_000,
    };
    publisher.handle(session, { ...event, seq: 2, ts: 2_001 });

    expect(session.lastPreambleHeadline).toBe("Checking files");
    expect(publish).not.toHaveBeenCalled();
    expect(publisher.generation(session)).toBe(0);
    publisher.dispose();
  });

  it("does not restore an unchanged preamble after a richer digest replaces it", () => {
    const session = state("Earlier headline");
    const { publish, publisher } = publisherFixture();
    const event = preambleEvent(session, 1, "Checking files");

    publisher.handle(session, event);
    publisher.clear(session);
    const previousDigest = session.previousDigest;
    if (!previousDigest) {
      throw new Error("expected previous digest");
    }
    session.previousDigest = {
      ...previousDigest,
      revision: 2,
      headline: "Reviewing the implementation",
      updatedAt: 2_000,
    };
    publisher.handle(session, { ...event, seq: 2, ts: 2_001 });

    expect(publish).toHaveBeenCalledOnce();
    expect(publisher.generation(session)).toBe(1);
    publisher.dispose();
  });

  it("replays a queued preamble after dormant-state revival", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const original = state("Earlier headline");
    const { publish, publisher } = publisherFixture(Date.now);
    const preamble = (sequence: number, progressText: string) =>
      preambleEvent(original, sequence, progressText, Date.now());

    publisher.handle(original, preamble(1, "Published headline"));
    vi.setSystemTime(1_100);
    publisher.handle(original, preamble(2, "Queued headline"));
    const dormant = createDormantSessionObserverRun(original);
    publisher.clear(original);

    expect(dormant.lastPreambleHeadline).toBe("Published headline");
    const revived = state("Published headline");
    revived.lastPreambleHeadline = dormant.lastPreambleHeadline;
    publisher.handle(revived, {
      ...preamble(3, "Queued headline"),
      sessionKey: revived.sessionKey,
      agentId: revived.agentId,
    });

    expect(publish).toHaveBeenCalledTimes(2);
    expect(revived.previousDigest?.headline).toBe("Queued headline");
    publisher.dispose();
    vi.useRealTimers();
  });

  it("preserves duplicate suppression across dormant-state revival", () => {
    const original = state("Earlier headline");
    const { publish, publisher } = publisherFixture();
    publisher.handle(original, preambleEvent(original, 1, "Checking files"));

    const revived = state("Reviewing the implementation");
    revived.lastPreambleHeadline = original.lastPreambleHeadline;
    publisher.handle(revived, preambleEvent(revived, 2, "Checking files", 2_000));

    expect(publish).toHaveBeenCalledOnce();
    publisher.dispose();
  });
});
