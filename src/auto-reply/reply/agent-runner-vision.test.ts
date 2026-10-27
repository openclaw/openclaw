import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildEmbeddedRunExecutionParams } from "./agent-runner-utils.js";
import type { FollowupRun } from "./queue.js";

const { loadScopedCatalog } = vi.hoisted(() => ({
  loadScopedCatalog: vi.fn<() => Promise<ModelCatalogEntry[]>>(),
}));
vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: loadScopedCatalog,
}));

const vision = ["text", "image"] as const;
const textOnly = ["text"] as const;
afterEach(() => vi.clearAllMocks());

describe("ordinary reply model capability", () => {
  it.each([
    ["prepared vision", vision, "primary", true, false, false],
    ["thinking off", vision, "primary", true, true, false],
    ["prepared text-only", textOnly, "primary", false, false, false],
    ["text-only fallback", vision, "fallback", false, false, false],
    ["vision fallback", textOnly, "fallback", true, false, false],
    ["reasoning-only metadata", undefined, "primary", true, false, false],
    ["missing metadata with thinking off", undefined, "missing", true, true, false],
    ["configured text-only overrides vision", vision, "primary", false, false, true],
  ] as const)(
    "%s preserves selected input in run parameters",
    async (_name, input, selected, expected, thinkOff, configured) => {
      const root = "/tmp/reply-vision";
      const cfg: OpenClawConfig = {
        agents: { entries: { main: { workspace: root } } },
        models: configured
          ? {
              providers: {
                acme: {
                  baseUrl: "https://provider.invalid/v1",
                  api: "openai-responses",
                  models: [
                    {
                      id: "primary",
                      name: "Primary",
                      input: ["text"],
                      reasoning: false,
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      maxTokens: 1024,
                    },
                  ],
                },
              },
            }
          : undefined,
      };
      const run: FollowupRun["run"] = {
        agentId: "main",
        agentDir: root,
        sessionId: "vision-session",
        sessionFile: "vision-session",
        workspaceDir: root,
        config: cfg,
        provider: "acme",
        model: "primary",
        thinkLevel: thinkOff ? "off" : "medium",
        timeoutMs: 5_000,
        blockReplyBreak: "text_end",
        thinkingCatalog: [
          { provider: "acme", id: "primary", reasoning: true, input },
          { provider: "acme", id: "fallback", input: input === vision ? textOnly : vision },
        ],
      };
      loadScopedCatalog.mockResolvedValue([
        { provider: "acme", id: selected, name: "Selected", input: [...vision] },
      ]);
      const produced = await buildEmbeddedRunExecutionParams({
        run,
        provider: "acme",
        model: selected,
        runId: "vision-run",
        sessionCtx: {},
        hasRepliedRef: undefined,
      });
      expect(produced.modelHasVision).toBe(expected);
    },
  );
});
