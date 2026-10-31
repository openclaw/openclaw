import "../test-utils/prepare-compiled-subprocesses.js";
import { setImmediate } from "node:timers/promises";
import { isMainThread } from "node:worker_threads";
import { expect, it } from "vitest";
import { projectChatDisplayMessagesWithStateAsync } from "./chat-display-projection.async.js";
import {
  projectChatDisplayMessagesWithState,
  type ChatDisplayProjectionOptions,
} from "./chat-display-projection.core.js";
import { createAsyncChatHistoryRecoveryProjection } from "./chat-history-recovery.async.js";

it("projects oversized history off-thread with exact current display facts", async () => {
  expect(isMainThread).toBe(true);
  const text =
    "```text\n" +
    "literal [[reply_to_current]]\n".repeat(40_000) +
    "```\n> quoted\nMEDIA:./proof.png";
  const messages = [
    {
      role: "user",
      content: "Question",
      __openclaw: { senderIdentity: { type: "profile", id: "person" } },
    },
    {
      role: "assistant",
      content: [{ type: "text", text }],
      openclawDelivery: { mediaUrls: ["./proof.png"] },
    },
    {
      role: "assistant",
      content: "private coordination",
      __openclaw: { runId: "hidden-run", seq: 3 },
    },
    {
      role: "user",
      content: "Report ready",
      provenance: {
        kind: "inter_session",
        sourceTool: "sessions_send",
        sourceSessionKey: "agent:main:cron:daily:run:done",
      },
    },
  ];
  let current = true;
  const options: ChatDisplayProjectionOptions = {
    subagentCoordination: {
      assertCurrent() {
        if (!current) {
          throw new Error("display authority expired");
        }
      },
      isSubagentSession: () => false,
      isSubagentRunMessage: (runId) => runId === "hidden-run",
    },
    resolveCronJobName: () => "Daily report",
    resolveCurrentUserProfileDisplay: () => ({
      kind: "resolved",
      profileId: "canonical-person",
      avatarUrl: "/avatar/current",
      hasUploadedAvatar: true,
    }),
  };
  const expected = projectChatDisplayMessagesWithState(messages, options);
  let settled = false;
  const pending = projectChatDisplayMessagesWithStateAsync(messages, options).finally(() => {
    settled = true;
  });
  await setImmediate();
  expect(settled).toBe(false);
  const actual = await pending;
  expect(actual).toEqual(expected);
  expect(actual.messages).toHaveLength(3);
  expect(actual.messages[0]?.["__openclaw"]).toMatchObject({
    senderIdentity: { type: "profile", id: "canonical-person" },
    senderProfileAvatarUrl: "/avatar/current",
  });
  expect(actual.messages.at(-1)?.senderLabel).toBe("Forwarded from Daily report");

  const expired = projectChatDisplayMessagesWithStateAsync(messages, options);
  current = false;
  await expect(expired).rejects.toThrow("display authority expired");
});

it("retains pending failures until an oversized same-run answer has visible content", async () => {
  const recovery = createAsyncChatHistoryRecoveryProjection();
  const message = (runId: string, content: string, stopReason = "stop") => ({
    role: "assistant",
    content,
    stopReason,
    __openclaw: { runId },
    openclawDelivery: { mediaUrls: ["./proof.png"] },
  });
  await recovery.append([message("retry", "", "error")]);
  expect(recovery.pending).toBe(true);

  const mediaOnly = "MEDIA:./proof.png\n".repeat(40_000);
  await recovery.append([message("retry", mediaOnly)]);
  expect(recovery.pending).toBe(true);

  const literal = `\`\`\`text\n${mediaOnly}\`\`\``;
  await recovery.append([message("another-run", literal)]);
  expect(recovery.pending).toBe(true);
  await recovery.append([message("retry", literal)]);
  expect(recovery.pending).toBe(false);
});
