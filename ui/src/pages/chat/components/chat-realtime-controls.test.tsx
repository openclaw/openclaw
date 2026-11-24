/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import type { RealtimeTalkConversationEntry } from "../talk/conversation-state.ts";
import { RealtimeTalkConversation } from "./chat-realtime-controls.tsx";

it("keeps voice rows keyed through streaming updates and reordered speaker turns", () => {
  const user: RealtimeTalkConversationEntry = {
    id: "user-a",
    role: "user",
    text: "Please check",
    isStreaming: true,
  };
  const assistant: RealtimeTalkConversationEntry = {
    id: "assistant-a",
    role: "assistant",
    text: "Checking",
    isStreaming: true,
  };
  const props = { assistantName: "Scout", userName: "  Mira  ", entries: [user, assistant] };
  const view = mountSolid(RealtimeTalkConversation, props);
  const rows = Array.from(view.container.querySelectorAll(".agent-chat__voice-turn"));
  expect(
    rows.map((row) => row.querySelector(".agent-chat__voice-turn-speaker")?.textContent),
  ).toEqual(["Mira", "Scout"]);

  view.update({
    ...props,
    entries: [
      assistant,
      { ...user, text: "Please check <strong>the report</strong>", isStreaming: false },
    ],
  });

  const updated = Array.from(view.container.querySelectorAll(".agent-chat__voice-turn"));
  expect(updated[0]).toBe(rows[1]);
  expect(updated[1]).toBe(rows[0]);
  expect(updated[1]?.querySelector(".agent-chat__voice-turn-text")?.textContent).toBe(
    "Please check <strong>the report</strong>",
  );
  expect(updated[1]?.querySelector(".agent-chat__voice-turn-stream")).toBeNull();
  expect(updated[0]?.querySelector(".agent-chat__voice-turn-stream")).not.toBeNull();
  expect(view.container.querySelector("strong")).toBeNull();
});
