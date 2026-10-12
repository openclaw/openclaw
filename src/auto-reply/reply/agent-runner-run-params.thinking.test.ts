import { describe, expect, it, vi } from "vitest";
import { buildEmbeddedRunExecutionParams } from "./agent-runner-utils.js";
import type { FollowupRun } from "./queue.js";

const loadProviderScopedThinkingCatalog = vi.hoisted(() =>
  vi.fn(async ({ agentRuntime }: { agentRuntime?: string }) =>
    agentRuntime === "codex"
      ? [
          {
            provider: "openai",
            id: "gpt-5.6-luna",
            name: "GPT-5.6 Luna",
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            compat: {
              supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
            },
          },
        ]
      : [],
  ),
);

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog,
}));

describe("reply-path model thinking capability", () => {
  it.each([
    { supportedReasoningEfforts: undefined },
    { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
  ])(
    "retains native Codex max with queued efforts $supportedReasoningEfforts",
    async ({ supportedReasoningEfforts }) => {
      const run: FollowupRun["run"] = {
        config: {},
        provider: "openai",
        model: "gpt-5.6-luna",
        agentId: "main",
        agentDir: "/tmp/openclaw-agent",
        workspaceDir: "/tmp/openclaw-workspace",
        sessionId: "thinking-session",
        sessionFile: "/tmp/openclaw-session.jsonl",
        timeoutMs: 60_000,
        blockReplyBreak: "text_end",
        thinkLevel: "max",
        skipProviderRuntimeHints: true,
        thinkingCatalog: [
          {
            provider: "openai",
            id: "gpt-5.6-luna",
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            compat: { supportedReasoningEfforts },
          },
        ],
      };
      const result = await buildEmbeddedRunExecutionParams({
        run,
        provider: run.provider,
        model: run.model,
        agentRuntime: "codex",
        runId: "thinking-run",
        sessionCtx: {},
        hasRepliedRef: undefined,
      });

      expect(result.modelThinkingCapability).toEqual({
        provider: "openai",
        modelId: "gpt-5.6-luna",
        agentRuntime: "codex",
        compat: {
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
        },
      });
    },
  );
});
