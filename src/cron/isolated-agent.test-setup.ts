import { vi } from "vitest";
import { signalOutbound, telegramOutbound } from "../../test/channel-outbounds.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import { callGateway } from "../gateway/call.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";

function parseTelegramTargetForTest(raw: string): {
  chatId: string;
  messageThreadId?: number;
  chatType: "direct" | "group" | "unknown";
} {
  const trimmed = raw
    .trim()
    .replace(/^telegram:/i, "")
    .replace(/^tg:/i, "");
  const match = /^group:([^:]+):topic:(\d+)$/i.exec(trimmed);
  if (match) {
    return {
      chatId: match[1],
      messageThreadId: Number.parseInt(match[2], 10),
      chatType: "group",
    };
  }
  const topicMatch = /^([^:]+):topic:(\d+)$/i.exec(trimmed);
  if (topicMatch) {
    return {
      chatId: topicMatch[1],
      messageThreadId: Number.parseInt(topicMatch[2], 10),
      chatType: topicMatch[1].startsWith("-") ? "group" : "direct",
    };
  }
  const colonPair = /^([^:]+):(\d+)$/i.exec(trimmed);
  if (colonPair && colonPair[1].startsWith("-")) {
    return {
      chatId: colonPair[1],
      messageThreadId: Number.parseInt(colonPair[2], 10),
      chatType: "group",
    };
  }
  return {
    chatId: trimmed,
    chatType: trimmed.startsWith("-") ? "group" : "unknown",
  };
}

export function setupIsolatedAgentTurnMocks(params?: { fast?: boolean }): void {
  if (params?.fast) {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  }
  vi.mocked(runEmbeddedPiAgent).mockReset();
  vi.mocked(loadModelCatalog).mockResolvedValue([]);
  vi.mocked(runSubagentAnnounceFlow).mockReset().mockResolvedValue(true);
  vi.mocked(callGateway).mockReset().mockResolvedValue({ ok: true, deleted: true });
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        plugin: createOutboundTestPlugin({
          id: "telegram",
          outbound: telegramOutbound,
          messaging: {
            parseExplicitTarget: ({ raw }) => {
              const target = parseTelegramTargetForTest(raw);
              return {
                to: target.chatId,
                threadId: target.messageThreadId,
                chatType: target.chatType === "unknown" ? undefined : target.chatType,
              };
            },
          },
        }),
        source: "test",
      },
      {
        pluginId: "signal",
        plugin: createOutboundTestPlugin({ id: "signal", outbound: signalOutbound }),
        source: "test",
      },
    ]),
  );
}
