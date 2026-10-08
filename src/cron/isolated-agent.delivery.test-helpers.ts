// Isolated agent delivery test helpers build delivery targets and mocks.
import { vi } from "vitest";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import type { CliDeps } from "../cli/deps.js";

/** Creates mocked CLI delivery deps for isolated-agent delivery tests. */
export function createCliDeps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    slack: vi.fn().mockResolvedValue({ messageTs: "slack-1", channel: "C1" }),
    whatsapp: vi.fn().mockResolvedValue({ messageId: "wa-1", toJid: "123@s.whatsapp.net" }),
    telegram: vi.fn().mockResolvedValue({ messageId: "tg-1", chatId: "123" }),
    discord: vi.fn().mockResolvedValue({ messageId: "discord-1", channelId: "123" }),
    signal: vi.fn().mockResolvedValue({ messageId: "signal-1", conversationId: "123" }),
    imessage: vi.fn().mockResolvedValue({ messageId: "imessage-1", chatId: "123" }),
    ...overrides,
  };
}

export function mockAgentPayloads(
  payloads: Array<Record<string, unknown>>,
  extra: Partial<Awaited<ReturnType<typeof runEmbeddedAgent>>> = {},
): void {
  vi.mocked(runEmbeddedAgent).mockResolvedValue({
    payloads,
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
    ...extra,
  });
}
