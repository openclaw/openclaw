import { expect, it, vi } from "vitest";
import { modelDefinition } from "../../agents/model-auth.fixtures.test-support.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runSessionCompactionIfNeeded } from "./agent-runner-memory.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";

const { compact, context } = vi.hoisted(() => ({
  compact: vi.fn(),
  context: { messages: [] as AgentMessage[], rawBytes: 400_000 },
}));

// mock-isolation: Fixed transcript I/O; the real preflight and route planner make the decision.
vi.mock("../../gateway/session-transcript-readers.js", () => ({
  readSessionTranscriptAccountingAsync: async () => ({ byteSize: context.rawBytes }),
}));
// mock-isolation: Fixed bounded history; the production pressure reader computes the charge.
vi.mock("../../agents/sessions/session-manager.js", () => ({
  SessionManager: {
    openModelContextAsync: async () => ({
      buildSessionContext: () => ({ messages: context.messages }),
    }),
  },
}));
// mock-isolation: Observe compactor admission without executing a model or memory-flush turn.
vi.mock("../../agents/embedded-agent.js", () => ({ compactEmbeddedAgentSession: compact }));
// mock-isolation: This preflight test must not load or execute the model-turn entry point.
vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({}));
// mock-isolation: A declined compaction never publishes session accounting.
vi.mock("./session-updates.js", () => ({
  incrementCompactionCount: vi.fn(),
}));

const model = "claude-sonnet-5-5";
const guard = 128 * 1024;

it.each([
  {
    kind: "runtime-context",
    api: "anthropic-messages",
    auth: "api-key",
    proxy: false,
    compacts: false,
  },
  {
    kind: "runtime-context",
    api: "openai-completions",
    auth: "api-key",
    proxy: false,
    compacts: true,
  },
  {
    kind: "runtime-context",
    api: "anthropic-messages",
    auth: "oauth",
    proxy: false,
    compacts: true,
  },
  {
    kind: "runtime-context",
    api: "anthropic-messages",
    auth: "api-key",
    proxy: true,
    compacts: true,
  },
  {
    kind: "prompt-update",
    api: "anthropic-messages",
    auth: "api-key",
    proxy: false,
    compacts: true,
  },
  {
    kind: "user-history",
    api: "anthropic-messages",
    auth: "api-key",
    proxy: false,
    compacts: true,
  },
] as const)(
  "bases byte preflight on visible $kind content for $api ($auth, proxy=$proxy)",
  async ({ kind, api, auth, proxy, compacts }) => {
    compact
      .mockReset()
      .mockResolvedValue({ ok: false, compacted: false, reason: "fixture decline" });
    context.messages = [{ role: "user", content: "Run ten read-only tool rounds.", timestamp: 1 }];
    for (let index = 0; index < 10; index++) {
      const content = "Synthetic quoted context. ".padEnd(30 * 1024, "x");
      context.messages.push(
        kind === "user-history"
          ? { role: "user", content, timestamp: index * 3 + 2 }
          : {
              role: "custom",
              customType: "openclaw.system-update",
              content,
              display: false,
              details: { kind, turnScoped: kind === "runtime-context" },
              timestamp: index * 3 + 2,
            },
        makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: `read-${index}`, name: "read", arguments: {} }],
          stopReason: "toolUse",
        }),
        {
          role: "toolResult",
          toolCallId: `read-${index}`,
          toolName: "read",
          content: [{ type: "text", text: "Read complete." }],
          isError: false,
          timestamp: index * 3 + 4,
        },
      );
    }
    const original = JSON.stringify(context.messages);
    const cfg: OpenClawConfig = {
      agents: { defaults: { compaction: { maxActiveTranscriptBytes: guard } } },
      models: {
        providers: {
          anthropic: {
            api,
            auth,
            apiKey: "synthetic-not-a-live-key",
            baseUrl: proxy ? "https://anthropic.example.test" : "https://api.anthropic.com",
            models: [modelDefinition(model, { contextWindow: 200_000 })],
          },
        },
      },
    };
    const followupRun = createTestFollowupRun({ provider: "anthropic", model, config: cfg });
    await runSessionCompactionIfNeeded({
      cfg,
      followupRun,
      defaultModel: model,
      sessionEntry: {
        sessionId: followupRun.run.sessionId,
        updatedAt: 1,
        totalTokens: 100,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      },
      sessionKey: "agent:main:pressure",
      storePath: "/synthetic/sessions.json",
      agentHarnessId: "openclaw",
    });
    expect(compact).toHaveBeenCalledTimes(compacts ? 1 : 0);
    if (compacts) {
      expect(compact.mock.calls[0]?.[0]).toMatchObject({
        preflightCompactionTrigger: "transcript_bytes",
      });
    }
    expect(JSON.stringify(context.messages)).toBe(original);
  },
);
