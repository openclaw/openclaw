import { afterEach, expect, it } from "vitest";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { buildThreadingToolContext } from "./agent-runner-utils.js";
import { applyReplyThreading } from "./reply-payloads-base.js";
import { formatRunLabel } from "./subagents-utils.js";

afterEach(resetPluginRuntimeStateForTest);

it("uses the recipient id for other channels", () => {
  const result = buildThreadingToolContext({
    sessionCtx: { Provider: "telegram", From: "user:42", To: "chat:99" },
    config: {},
    hasRepliedRef: undefined,
  });

  expect(result.currentChannelId).toBe("chat:99");
});

it("lets plugin threading adapters suppress the generic message-id fallback", () => {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "googlechat",
        plugin: {
          ...createChannelTestPluginBase({ id: "googlechat", label: "Google Chat" }),
          threading: {
            buildToolContext: ({ context }) => ({
              currentChannelId: context.To?.replace(/^googlechat:/, ""),
              currentMessageId: undefined,
              currentThreadTs: context.ReplyToIdFull ?? context.ReplyToId,
            }),
          },
        } as ChannelPlugin,
        source: "test",
      },
    ]),
  );
  const result = buildThreadingToolContext({
    sessionCtx: {
      Provider: "googlechat",
      To: "googlechat:spaces/AAA",
      MessageSidFull: "spaces/AAA/messages/msg-1",
      ReplyToId: "spaces/AAA/threads/short",
      ReplyToIdFull: "spaces/AAA/threads/full",
    },
    config: { channels: { googlechat: { replyToMode: "all" } } } as OpenClawConfig,
    hasRepliedRef: undefined,
  });

  expect(result).toMatchObject({
    currentChannelId: "spaces/AAA",
    currentThreadTs: "spaces/AAA/threads/full",
    currentMessageId: undefined,
  });
});

it.each([
  [
    "A",
    { replyToMode: "batched", replyThreading: { implicitCurrentMessage: "deny" } },
    { replyToId: undefined },
  ],
  ["A", { replyToMode: "off", replyToChannel: "slack" }, { replyToId: undefined }],
  [
    "[[reply_to_current]]A",
    { replyToMode: "off", replyToChannel: "telegram" },
    { replyToId: "42", replyToTag: true },
  ],
  ["[[reply_to:id]]A", { replyToMode: "all" }, { replyToId: "id", text: "A" }],
] as const)("threads %s with %j", (text, options, expected) => {
  const result = applyReplyThreading({
    payloads: [{ text }],
    currentMessageId: "42",
    ...options,
  }).map((payload) => Object.assign({ replyToId: payload.replyToId }, payload));
  expect(result).toEqual([expect.objectContaining(expected)]);
});

const baseRun: SubagentRunRecord = {
  runId: "run-1",
  childSessionKey: "agent:main:subagent:abc",
  requesterSessionKey: "agent:main:main",
  requesterDisplayKey: "main",
  task: "do thing",
  cleanup: "keep",
  createdAt: 1000,
  execution: { status: "running", startedAt: 1000 },
};

it("formats run labels with truncation", () => {
  expect(formatRunLabel({ ...baseRun, label: "xxxx" }, { maxLength: 3 })).toBe("xxx…");
});

it("sanitizes leaked internal runtime context from formatted run labels", () => {
  expect(
    formatRunLabel({
      ...baseRun,
      label:
        "OpenClaw runtime context (internal):\nThis context is runtime-generated, not user-authored. Keep internal details private.\n\n[Internal task completion event]\nsource: subagent",
    }),
  ).toBe("subagent");
});
