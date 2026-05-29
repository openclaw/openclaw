import { afterEach, describe, expect, it } from "vitest";
import type { EmbeddedAgentQueueFailureReason } from "../../../agents/embedded-agent-runner/runs.js";
import {
  BUSY_MESSAGE_OUTCOME_LABELS,
  clearBusyMessageOutcomeStoreForTest,
  formatBusyMessageOutcomeLabel,
  getLastBusyMessageOutcome,
  recordBusyMessageOutcome,
  type BusyMessageOutcomeKind,
} from "./busy-message-outcome.js";

const SESSION_KEY = "agent:main:main";
const SESSION_ID = "session-1";

afterEach(() => {
  clearBusyMessageOutcomeStoreForTest();
});

describe("busy-message-outcome", () => {
  it("records and reads the last outcome by session key or id", () => {
    recordBusyMessageOutcome({
      kind: "followup_enqueued",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      channel: "telegram",
      queueMode: "followup",
      source: "inbound",
      recordedAtMs: 1_700_000_000_000,
    });

    expect(getLastBusyMessageOutcome(SESSION_KEY)).toEqual({
      kind: "followup_enqueued",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      channel: "telegram",
      queueMode: "followup",
      source: "inbound",
      recordedAtMs: 1_700_000_000_000,
    });
    expect(getLastBusyMessageOutcome(SESSION_ID)).toEqual(getLastBusyMessageOutcome(SESSION_KEY));
    expect(getLastBusyMessageOutcome("missing")).toBeUndefined();
  });

  it("overwrites the previous outcome for the same session", () => {
    recordBusyMessageOutcome({
      kind: "followup_enqueued",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      queueMode: "followup",
    });
    recordBusyMessageOutcome({
      kind: "active_run_steer_accepted",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      queueMode: "steer",
      source: "slash_steer",
    });

    expect(getLastBusyMessageOutcome(SESSION_KEY)?.kind).toBe("active_run_steer_accepted");
    expect(getLastBusyMessageOutcome(SESSION_KEY)?.source).toBe("slash_steer");
  });

  it("maps each failure reason without lossy string parsing", () => {
    const reasons: EmbeddedAgentQueueFailureReason[] = [
      "no_active_run",
      "not_streaming",
      "compacting",
      "source_reply_delivery_mode_mismatch",
      "transcript_commit_wait_unsupported",
      "runtime_rejected",
    ];

    for (const reason of reasons) {
      clearBusyMessageOutcomeStoreForTest();
      recordBusyMessageOutcome({
        kind: "active_run_steer_rejected",
        sessionKey: SESSION_KEY,
        sessionId: SESSION_ID,
        queueMode: "steer",
        reason,
      });

      expect(getLastBusyMessageOutcome(SESSION_KEY)?.reason).toBe(reason);
      expect(formatBusyMessageOutcomeLabel(getLastBusyMessageOutcome(SESSION_KEY)!)).toBe(
        `${BUSY_MESSAGE_OUTCOME_LABELS.active_run_steer_rejected} (${reason})`,
      );
    }
  });

  it("covers all outcome enum labels", () => {
    const kinds: BusyMessageOutcomeKind[] = [
      "active_run_steer_accepted",
      "active_run_steer_rejected",
      "followup_enqueued",
      "collect_enqueued",
      "interrupt_started",
      "dropped",
    ];

    for (const kind of kinds) {
      recordBusyMessageOutcome({
        kind,
        sessionKey: `${SESSION_KEY}:${kind}`,
        sessionId: `${SESSION_ID}:${kind}`,
        queueMode: kind === "collect_enqueued" ? "collect" : "followup",
      });
      expect(
        formatBusyMessageOutcomeLabel(getLastBusyMessageOutcome(`${SESSION_KEY}:${kind}`)!),
      ).toBe(BUSY_MESSAGE_OUTCOME_LABELS[kind]);
    }
  });
});
