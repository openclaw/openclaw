import { describe, expect, it } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../types.ts";
import type { ChatQueueItem } from "../ui-types.ts";
import {
  applySessionBusyOutcomesToChatQueue,
  resolveChatQueueItemOutcomeBadge,
  resolveChatQueueOutcomeBadge,
} from "./busy-message-outcome.ts";

function createSessionsResult(
  sessionKey: string,
  outcome: GatewaySessionRow["lastBusyMessageOutcome"],
): SessionsListResult {
  return {
    ts: 0,
    path: "",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [
      {
        key: sessionKey,
        kind: "direct",
        updatedAt: 1,
        lastBusyMessageOutcome: outcome,
      },
    ],
  };
}

describe("busy-message outcome mapping", () => {
  it("maps backend steer accepted to Steered badge", () => {
    expect(
      resolveChatQueueOutcomeBadge({
        kind: "active_run_steer_accepted",
        label: "Steered into active run",
        recordedAtMs: 100,
      }),
    ).toMatchObject({
      text: "Steered",
      variant: "steered",
    });
  });

  it("maps steer fallback with reason tooltip", () => {
    const badge = resolveChatQueueOutcomeBadge({
      kind: "active_run_steer_rejected",
      label: "Active run rejected steering",
      reason: "not_streaming",
      recordedAtMs: 100,
    });
    expect(badge.text).toBe("Steer fallback");
    expect(badge.title).toContain("not_streaming");
    expect(badge.variant).toBe("fallback");
  });

  it("maps follow-up enqueue to Queued follow-up badge", () => {
    expect(
      resolveChatQueueOutcomeBadge({
        kind: "followup_enqueued",
        label: "Queued as follow-up",
        recordedAtMs: 100,
      }),
    ).toMatchObject({
      text: "Queued follow-up",
      variant: "followup",
    });
  });

  it("prefers backend outcome over optimistic steered kind", () => {
    const item: ChatQueueItem = {
      id: "queued-1",
      text: "tighten the plan",
      createdAt: 50,
      kind: "steered",
      busyOutcome: {
        kind: "active_run_steer_rejected",
        label: "Active run rejected steering",
        reason: "compacting",
        recordedAtMs: 100,
      },
    };
    expect(resolveChatQueueItemOutcomeBadge(item)).toMatchObject({
      text: "Steer fallback",
      variant: "fallback",
    });
  });
});

describe("applySessionBusyOutcomesToChatQueue", () => {
  it("applies session outcome to the newest eligible queue item", () => {
    const host = {
      sessionKey: "agent:main:main",
      chatQueue: [
        { id: "older", text: "older", createdAt: 10 },
        { id: "target", text: "tighten the plan", createdAt: 90 },
      ],
      sessionsResult: createSessionsResult("agent:main:main", {
        kind: "followup_enqueued",
        label: "Queued as follow-up",
        recordedAtMs: 100,
      }),
    };

    expect(applySessionBusyOutcomesToChatQueue(host)).toBe(true);
    expect(host.chatQueue[1]?.busyOutcome?.kind).toBe("followup_enqueued");
    expect(host.chatQueue[0]?.busyOutcome).toBeUndefined();
  });

  it("clears optimistic steered kind when backend reports steer fallback", () => {
    const host = {
      sessionKey: "agent:main:main",
      chatQueue: [
        {
          id: "steered",
          text: "tighten the plan",
          createdAt: 90,
          kind: "steered" as const,
        },
      ],
      sessionsResult: createSessionsResult("agent:main:main", {
        kind: "active_run_steer_rejected",
        label: "Active run rejected steering",
        reason: "runtime_rejected",
        recordedAtMs: 100,
      }),
    };

    expect(applySessionBusyOutcomesToChatQueue(host)).toBe(true);
    expect(host.chatQueue[0]?.kind).toBeUndefined();
    expect(host.chatQueue[0]?.busyOutcome?.kind).toBe("active_run_steer_rejected");
  });
});
