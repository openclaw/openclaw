// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createState } from "./chat-gateway.test-support.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { activeChatRunStartupStatus, chatStartupStatusLabel } from "./chat-run-startup.ts";
import { getChatSessionProjection } from "./history-merge.ts";

describe("chat gateway state contention", () => {
  it.each(["state_contention", "unknown", undefined] as const)(
    "uses only certified live contention (%s) without changing the draft",
    (errorKind) => {
      const diagnostic =
        "Temporarily busy. Check status before trying again.\nState contention: session store; attempts exhausted.";
      const state = createState({ chatMessage: "Unsent draft" });
      const attachments = state.chatAttachments;
      handleChatGatewayEvent(state, {
        sessionKey: "main",
        runId: "run-1",
        state: "error",
        errorKind,
        errorMessage: diagnostic,
      });
      expect(state.chatRunError).toEqual({
        runId: "run-1",
        summary: errorKind === "state_contention" ? diagnostic : "Error: " + diagnostic,
        ...(errorKind === "state_contention" ? { kind: errorKind } : {}),
      });
      expect(getChatSessionProjection(state).runs["run-1"]?.errorKind).toBe(errorKind);
      expect(state.chatMessage).toBe("Unsent draft");
      expect(state.chatAttachments).toBe(attachments);
      expect(state.chatQueue).toEqual([]);
      expect(state.chatRunId).toBeNull();
    },
  );

  it("keeps the same run during a quiet state contention wait", () => {
    const state = createState({ chatRunId: "run-1", chatMessage: "Unsent draft" });
    handleChatGatewayEvent(state, {
      sessionKey: "main",
      runId: "run-1",
      state: "status",
      phase: "waiting_for_state",
    });
    expect(chatStartupStatusLabel(activeChatRunStartupStatus(state.chatRunStartup), null)).toBe(
      "Temporarily busy—retrying…",
    );
    expect(state.chatRunId).toBe("run-1");
    expect(state.chatMessage).toBe("Unsent draft");
    expect(state.chatRunError).toBeFalsy();
    handleChatGatewayEvent(state, {
      sessionKey: "main",
      runId: "run-1",
      state: "delta",
      message: { role: "assistant", content: "Resumed" },
    });
    expect(state.chatRunStartup).toMatchObject({ state: "status", phase: "answer" });
  });
});
