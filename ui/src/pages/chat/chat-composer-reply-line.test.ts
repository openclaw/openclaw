import { expect, it } from "vitest";
import { resolveChatComposerReplyLine } from "./chat-composer-reply-line.ts";

function userMessage(id: string, senderId: string, senderName: string) {
  return {
    role: "user",
    content: `${senderName} wrote this.`,
    __openclaw: {
      id,
      senderId,
      senderName,
      senderIdentity: { type: "profile", id: senderId },
    },
  };
}

const messages = [
  userMessage("own", "alice", "Alice Chen"),
  { role: "assistant", content: "Answer.", __openclaw: { id: "answer" } },
  userMessage("peer", "jordan", "Jordan Lee"),
];
const base = {
  messages,
  assistantName: "Molty",
  assistantAvatar: "M",
  currentAgentId: "main",
  userId: "alice",
  userName: "Alice Chen",
};
const target = (sourceMessageId: string | null, senderLabel = "Stale label") => ({
  messageId: `render-${sourceMessageId}`,
  text: "Quoted text",
  senderLabel,
  sourceMessageId,
});

it("names your own original as You while keeping its avatar identity", () => {
  const line = resolveChatComposerReplyLine({ ...base, replyTarget: target("own", "Alice Chen") });
  expect(line).toMatchObject({
    state: "named",
    name: "You",
    text: "Quoted text",
    sender: { name: "Alice Chen", identity: { type: "profile", id: "alice" } },
  });
});

it("names another participant and the agent from the loaded original", () => {
  expect(resolveChatComposerReplyLine({ ...base, replyTarget: target("peer") })).toMatchObject({
    name: "Jordan Lee",
    sender: { identity: { type: "profile", id: "jordan" } },
  });
  const agent = resolveChatComposerReplyLine({ ...base, replyTarget: target("answer") });
  expect(agent).toMatchObject({
    name: "Molty",
    sender: { identity: { type: "agent", id: "main" } },
  });
  expect(agent?.agentAvatar).toBeDefined();
});

it("keeps the target's own label without an avatar when the original is not loaded", () => {
  expect(
    resolveChatComposerReplyLine({ ...base, replyTarget: target("paged-out", "Jordan Lee") }),
  ).toEqual({ state: "named", name: "Jordan Lee", text: "Quoted text" });
  expect(resolveChatComposerReplyLine({ ...base, replyTarget: target(null, "") })).toEqual({
    state: "hidden",
  });
  expect(resolveChatComposerReplyLine({ ...base, replyTarget: null })).toBeNull();
});
