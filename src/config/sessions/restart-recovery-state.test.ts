import { describe, expect, it } from "vitest";
import {
  buildRestartRecoveryClaimCleanupPatch,
  normalizeRestartRecoveryEntryFields,
} from "./restart-recovery-state.js";
import {
  buildRestartRecoveryExpectedState,
  sessionMatchesExpectedTranscriptTurn,
} from "./session-transcript-turn-state.js";
import type { SessionEntry } from "./types.js";

describe("restart recovery reply expectation", () => {
  it.each([
    ["required", "required"],
    ["optional", "optional"],
    ["result-required", "result-required"],
    ["unknown", undefined],
    [undefined, undefined],
  ])("normalizes %s without inferring an absent expectation", (value, expected) => {
    const entry: SessionEntry = { sessionId: "session-1", updatedAt: 1 };
    Reflect.set(entry, "restartRecoveryReplyExpectation", value);
    normalizeRestartRecoveryEntryFields(entry, (key, normalizedValue) => {
      Reflect.set(entry, key, normalizedValue);
    });

    expect(Reflect.get(entry, "restartRecoveryReplyExpectation")).toBe(expected);
  });

  it("keeps the expectation bound to its claim until that claim is cleared", () => {
    const entry = {
      sessionId: "session-1",
      updatedAt: 1,
      restartRecoveryDeliveryRunId: "recovery-run",
      restartRecoveryDeliverySourceRunId: "source-run",
      restartRecoveryReplyExpectation: "required" as const,
    };
    const expected = {
      expectedSessionId: entry.sessionId,
      expectedSessionState: buildRestartRecoveryExpectedState(entry),
    };

    expect(sessionMatchesExpectedTranscriptTurn({ entry }, expected)).toBe(true);
    expect(
      sessionMatchesExpectedTranscriptTurn(
        { entry: { ...entry, restartRecoveryReplyExpectation: "optional" } },
        expected,
      ),
    ).toBe(false);

    const cleared = {
      ...entry,
      ...buildRestartRecoveryClaimCleanupPatch({ entry, recordTerminalSource: false }),
    };
    expect(cleared).toMatchObject({
      restartRecoveryDeliveryRunId: undefined,
      restartRecoveryReplyExpectation: undefined,
    });
  });
});
