import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildTelegramTopicStatusLines } from "./telegram-topic-status.js";

function buildTelegramTopicContext(
  overrides: Parameters<typeof buildTelegramTopicStatusLines>[0]["context"] = {},
) {
  return {
    OriginatingChannel: "telegram",
    Provider: "telegram",
    Surface: "telegram",
    OriginatingTo: "telegram:-1001234567890",
    To: "telegram:-1001234567890",
    AccountId: "default",
    MessageThreadId: 42,
    ...overrides,
  };
}

function buildAcpSessionEntry(): SessionEntry {
  return {
    sessionId: "sid-topic-42",
    updatedAt: Date.now(),
    acp: {
      backend: "acpx",
      mode: "persistent",
      state: "idle",
      agent: "codex",
      identity: {
        agentSessionId: "sid-topic-42",
      },
    },
  } as SessionEntry;
}

describe("buildTelegramTopicStatusLines", () => {
  it("describes configured ACP topic bindings", () => {
    const lines = buildTelegramTopicStatusLines(
      {
        cfg: {} as OpenClawConfig,
        context: buildTelegramTopicContext(),
        sessionEntry: buildAcpSessionEntry(),
      },
      {
        resolveConfiguredBinding: () => ({
          spec: {
            channel: "telegram",
            accountId: "default",
            conversationId: "-1001234567890:topic:42",
            parentConversationId: "-1001234567890",
            agentId: "codex",
            mode: "persistent",
            backend: "acpx",
          },
          record: {
            bindingId: "config:acp:telegram:default:-1001234567890:topic:42",
            targetSessionKey: "agent:codex:acp:binding:telegram:default:feedface",
            targetKind: "session",
            conversation: {
              channel: "telegram",
              accountId: "default",
              conversationId: "-1001234567890:topic:42",
              parentConversationId: "-1001234567890",
            },
            status: "active",
            boundAt: 0,
          },
        }),
        sessionBindingService: { resolveByConversation: () => null },
      },
    );

    expect(lines).toEqual([
      "📍 Topic: -1001234567890:topic:42",
      "🚚 Delivery: telegram:-1001234567890 · topic 42",
      "🗂 Configured: ACP (persistent · acpx) -> agent:codex:acp:binding:telegram:default:feedface",
      "🛰 ACP: acpx · persistent · idle · id=sid-topic-42",
    ]);
  });

  it("shows configured and live bindings side by side when they drift", () => {
    const lines = buildTelegramTopicStatusLines(
      {
        cfg: {} as OpenClawConfig,
        context: buildTelegramTopicContext(),
        sessionEntry: buildAcpSessionEntry(),
      },
      {
        resolveConfiguredBinding: () => ({
          spec: {
            channel: "telegram",
            accountId: "default",
            conversationId: "-1001234567890:topic:42",
            parentConversationId: "-1001234567890",
            agentId: "codex",
            mode: "persistent",
            backend: "acpx",
          },
          record: {
            bindingId: "config:acp:telegram:default:-1001234567890:topic:42",
            targetSessionKey: "agent:codex:acp:binding:telegram:default:feedface",
            targetKind: "session",
            conversation: {
              channel: "telegram",
              accountId: "default",
              conversationId: "-1001234567890:topic:42",
              parentConversationId: "-1001234567890",
            },
            status: "active",
            boundAt: 0,
          },
        }),
        sessionBindingService: {
          resolveByConversation: () => ({
            bindingId: "default:-1001234567890:topic:42",
            targetSessionKey: "agent:codex-acp:session-live",
            targetKind: "session",
            conversation: {
              channel: "telegram",
              accountId: "default",
              conversationId: "-1001234567890:topic:42",
            },
            status: "active",
            boundAt: 0,
          }),
        },
      },
    );

    expect(lines).toContain(
      "🗂 Configured: ACP (persistent · acpx) -> agent:codex:acp:binding:telegram:default:feedface",
    );
    expect(lines).toContain("🧷 Live: focused session (active) -> agent:codex-acp:session-live");
    expect(lines).toContain("⚠️ Drift: configured target differs from live binding");
  });

  it("skips non-topic telegram conversations", () => {
    const lines = buildTelegramTopicStatusLines({
      cfg: {} as OpenClawConfig,
      context: buildTelegramTopicContext({ MessageThreadId: undefined }),
    });

    expect(lines).toEqual([]);
  });
});
