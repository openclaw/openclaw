import { beforeEach, describe, expect, it } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";

const baseParams = {
  isHeartbeat: false,
  didLogHeartbeatStrip: false,
  blockStreamingEnabled: false,
  blockReplyPipeline: null,
  replyToMode: "off" as const,
};

type TestReplyPayloadParams = Partial<Parameters<typeof buildReplyPayloads>[0]> &
  Pick<Parameters<typeof buildReplyPayloads>[0], "payloads">;

function buildTestReplyPayloads(overrides: TestReplyPayloadParams) {
  return buildReplyPayloads({ ...baseParams, ...overrides });
}

describe("buildReplyPayloads blank media deduplication", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: createChannelTestPluginBase({ id: "telegram" }),
          source: "test",
        },
      ]),
    );
  });

  it("dedupes duplicate text when the reply only has blank media entries", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [{ text: "hello world!", mediaUrls: ["   "] }],
      messageProvider: "telegram",
      originatingTo: "268300329",
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentTargets: [
        { tool: "telegram", provider: "telegram", to: "268300329", text: "hello world!" },
      ],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("dedupes duplicate text when the reply only has a blank singular media entry", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [{ text: "hello world!", mediaUrl: "   " }],
      messageProvider: "telegram",
      originatingTo: "268300329",
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentTargets: [
        { tool: "telegram", provider: "telegram", to: "268300329", text: "hello world!" },
      ],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("keeps real media when the caption matches a message-tool send", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [{ text: "hello world!", mediaUrls: ["file:///tmp/photo.jpg"] }],
      messageProvider: "telegram",
      originatingTo: "268300329",
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentTargets: [
        { tool: "telegram", provider: "telegram", to: "268300329", text: "hello world!" },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]).toMatchObject({
      text: "hello world!",
      mediaUrls: ["file:///tmp/photo.jpg"],
    });
  });

  it("keeps singular media when plural media entries are blank", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [
        {
          text: "hello world!",
          mediaUrl: "file:///tmp/photo.jpg",
          mediaUrls: ["   "],
        },
      ],
      messageProvider: "telegram",
      originatingTo: "268300329",
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentTargets: [
        { tool: "telegram", provider: "telegram", to: "268300329", text: "hello world!" },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]).toMatchObject({
      text: "hello world!",
      mediaUrl: "file:///tmp/photo.jpg",
    });
  });
});
