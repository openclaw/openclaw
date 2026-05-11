import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { resolveSessionConversation } from "./session-conversation.js";

describe("session conversation routing", () => {
  beforeEach(() => {
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("keeps generic :thread: parsing on raw conversation ids", () => {
    expect(
      resolveSessionConversation({
        channel: "slack",
        kind: "channel",
        rawId: "general:thread:1699999999.0001",
      }),
    ).toEqual({
      id: "general",
      threadId: "1699999999.0001",
      baseConversationId: "general",
      parentConversationCandidates: ["general"],
    });
  });

  it("lets Telegram own :topic: conversation grammar", () => {
    expect(
      resolveSessionConversation({
        channel: "telegram",
        kind: "group",
        rawId: "-100123:topic:77",
      }),
    ).toEqual({
      id: "-100123",
      threadId: "77",
      baseConversationId: "-100123",
      parentConversationCandidates: ["-100123"],
    });
  });

  it("does not load bundled session-key fallbacks for inactive channel plugins", () => {
    resetPluginRuntimeStateForTest();
    setRuntimeConfigSnapshot({
      plugins: {
        entries: {
          telegram: {
            enabled: false,
          },
        },
      },
    });

    expect(
      resolveSessionConversation({
        channel: "telegram",
        kind: "group",
        rawId: "-100123:topic:77",
      }),
    ).toEqual({
      id: "-100123:topic:77",
      threadId: undefined,
      baseConversationId: "-100123:topic:77",
      parentConversationCandidates: [],
    });
  });

  it("lets Feishu own parent fallback candidates", () => {
    expect(
      resolveSessionConversation({
        channel: "feishu",
        kind: "group",
        rawId: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      }),
    ).toEqual({
      id: "oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      threadId: undefined,
      baseConversationId: "oc_group_chat",
      parentConversationCandidates: ["oc_group_chat:topic:om_topic_root", "oc_group_chat"],
    });
  });

  it("keeps the legacy parent-candidate hook as a fallback only", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "legacy-parent",
          source: "test",
          plugin: {
            id: "legacy-parent",
            meta: {
              id: "legacy-parent",
              label: "Legacy Parent",
              selectionLabel: "Legacy Parent",
              docsPath: "/channels/legacy-parent",
              blurb: "test stub.",
            },
            capabilities: { chatTypes: ["group"] },
            messaging: {
              resolveParentConversationCandidates: ({ rawId }: { rawId: string }) =>
                rawId.endsWith(":sender:user") ? [rawId.replace(/:sender:user$/i, "")] : null,
            },
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({}),
            },
          },
        },
      ]),
    );

    expect(
      resolveSessionConversation({
        channel: "legacy-parent",
        kind: "group",
        rawId: "room:sender:user",
      }),
    ).toEqual({
      id: "room:sender:user",
      threadId: undefined,
      baseConversationId: "room",
      parentConversationCandidates: ["room"],
    });
  });
});
