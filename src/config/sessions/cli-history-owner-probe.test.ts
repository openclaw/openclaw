import { describe, expect, it } from "vitest";
import {
  answerCliHistoryOwnerProbe,
  cliHistoryWriterFacts,
  createCliHistoryOwnerProbe,
  type CliHistoryWriter,
} from "./cli-history-boundary.js";

const writer = (confirmsOwner?: () => boolean): CliHistoryWriter => ({
  target: { agentId: "main", sessionId: "s", sessionKey: "agent:main:s", storePath: "/db" },
  runId: "run",
  authFingerprint: "f".repeat(64),
  lifecycleRevision: "rev",
  assertCurrent: () => {},
  assertReadable: () => {},
  ...(confirmsOwner ? { confirmsOwner } : {}),
});

describe("CLI history owner probe", () => {
  it("does not hold until the host answers", () => {
    expect(createCliHistoryOwnerProbe().holds()).toBe(false);
  });

  it("holds only when the host's live owner check holds", () => {
    const held = createCliHistoryOwnerProbe();
    expect(
      answerCliHistoryOwnerProbe(
        held.fact,
        writer(() => true),
      ),
    ).toBe(true);
    expect(held.holds()).toBe(true);
    const lost = createCliHistoryOwnerProbe();
    expect(
      answerCliHistoryOwnerProbe(
        lost.fact,
        writer(() => false),
      ),
    ).toBe(true);
    expect(lost.holds()).toBe(false);
  });

  it("answers a probe that has no live owner check or no writer as not holding", () => {
    const unchecked = createCliHistoryOwnerProbe();
    expect(answerCliHistoryOwnerProbe(unchecked.fact, writer())).toBe(true);
    expect(unchecked.holds()).toBe(false);
    const orphaned = createCliHistoryOwnerProbe();
    expect(answerCliHistoryOwnerProbe(orphaned.fact, undefined)).toBe(true);
    expect(orphaned.holds()).toBe(false);
  });

  it("treats an owner check that throws as not holding", () => {
    const probe = createCliHistoryOwnerProbe();
    const failing = writer(() => {
      throw new Error("Keychain lookup failed");
    });
    expect(answerCliHistoryOwnerProbe(probe.fact, failing)).toBe(true);
    expect(probe.holds()).toBe(false);
  });

  it("leaves other admission facts and malformed probes unanswered", () => {
    const live = writer(() => true);
    expect(answerCliHistoryOwnerProbe(undefined, live)).toBe(false);
    expect(answerCliHistoryOwnerProbe({ kind: "session-turn-custody" }, live)).toBe(false);
    expect(answerCliHistoryOwnerProbe({ kind: createCliHistoryOwnerProbe().fact.kind }, live)).toBe(
      false,
    );
    expect(
      answerCliHistoryOwnerProbe(
        { kind: createCliHistoryOwnerProbe().fact.kind, verdict: new ArrayBuffer(4) },
        live,
      ),
    ).toBe(false);
  });

  it("asks workers to probe only for writers with a live owner check", () => {
    expect(cliHistoryWriterFacts(writer(() => true)).confirmOwner).toBe(true);
    expect(cliHistoryWriterFacts(writer()).confirmOwner).toBeUndefined();
  });
});
