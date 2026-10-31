import { describe, expect, it } from "vitest";
import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import { buildSessionResetBoundaryEvent } from "./session-reset-boundary-event.js";
import {
  createExactAssistantMessage,
  timedMessageEvent,
} from "./transcript-message.test-support.js";

function message(
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  content: string,
  second: number,
) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-07-22T00:00:${String(second).padStart(2, "0")}.000Z`,
    message: { role, content },
  };
}

describe("reset boundary planning", () => {
  it("counts a placed background result at its logical slot across repeated resets", () => {
    const pending = timedMessageEvent("pending", null, "2026-07-22T00:00:00.000Z", {
      ...createExactAssistantMessage({
        text: "background",
        provider: "openclaw",
        model: "automation-result",
      }),
      excludeFromContext: true,
      openclawModelPlacement: "pending",
    });
    const events: unknown[] = [pending];
    for (let turn = 1; turn <= 3; turn++) {
      events.push(
        message(
          `user-${turn}`,
          turn === 1 ? pending.id : `assistant-${turn - 1}`,
          "user",
          "question",
          turn * 2,
        ),
        message(`assistant-${turn}`, `user-${turn}`, "assistant", "answer", turn * 2 + 1),
      );
    }
    events.push({
      type: "custom",
      id: "placement",
      parentId: "assistant-3",
      timestamp: pending.timestamp,
      customType: BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE,
      data: { afterEntryId: "assistant-3", resultEntryIds: [pending.id] },
    });
    for (let reset = 0; reset < 2; reset++) {
      const boundary = buildSessionResetBoundaryEvent({
        events,
        context: "preserve-tail",
        reason: "daily",
      });
      expect(boundary.firstKeptEntryId).toBe("user-2");
      events.push(boundary);
    }
  });

  it("cuts prior conversation context for explicit reset boundaries", () => {
    const reason = "reset";
    const user = message("prior-user", null, "user", "discarded", 1);
    const assistant = message("prior-assistant", user.id, "assistant", "discarded answer", 2);

    const event = buildSessionResetBoundaryEvent({
      context: "clear",
      events: [user, assistant],
      reason,
    });

    expect(event).toMatchObject({ parentId: assistant.id, reason });
    expect(event).not.toHaveProperty("firstKeptEntryId");
  });

  it("retains repeated reset tails for automatic recovery", () => {
    const oldUser = message("old-user", null, "user", "discarded", 1);
    const oldAssistant = message("old-assistant", oldUser.id, "assistant", "discarded answer", 2);
    const keptUser = message("kept-user", oldAssistant.id, "user", "kept", 3);
    const keptAssistant = message("kept-assistant", keptUser.id, "assistant", "kept answer", 4);
    const firstReset = {
      type: "reset",
      id: "first-reset",
      parentId: keptAssistant.id,
      timestamp: "2026-07-22T00:00:05.000Z",
      reason: "new",
      firstKeptEntryId: keptUser.id,
    };

    expect(
      buildSessionResetBoundaryEvent({
        context: "preserve-tail",
        events: [oldUser, oldAssistant, keptUser, keptAssistant, firstReset],
        reason: "reset",
      }),
    ).toMatchObject({
      parentId: firstReset.id,
      firstKeptEntryId: keptUser.id,
      reason: "reset",
    });
  });

  it("keeps a compaction retained tail when planning the next reset", () => {
    const discarded = message("discarded-user", null, "user", "discarded", 1);
    const keptUser = message("compaction-kept-user", discarded.id, "user", "kept", 2);
    const keptAssistant = message(
      "compaction-kept-assistant",
      keptUser.id,
      "assistant",
      "kept answer",
      3,
    );
    const compaction = {
      type: "compaction",
      id: "compaction-boundary",
      parentId: keptAssistant.id,
      timestamp: "2026-07-22T00:00:04.000Z",
      summary: "summary",
      firstKeptEntryId: keptUser.id,
      tokensBefore: 100,
    };

    expect(
      buildSessionResetBoundaryEvent({
        context: "preserve-tail",
        events: [discarded, keptUser, keptAssistant, compaction],
        reason: "daily",
      }),
    ).toMatchObject({
      parentId: compaction.id,
      firstKeptEntryId: keptUser.id,
      reason: "daily",
    });
  });
});
