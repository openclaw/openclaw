// Cron turns must hydrate runtime-only model thinking through the provider-scoped helper,
// never through a full live catalog build.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import type { resolveCronThinkingSelection } from "./model-selection.js";

const scopedThinkingCatalogMock = vi.fn(
  async (..._args: unknown[]): Promise<Array<Record<string, unknown>>> => [],
);

vi.mock("./run-model-selection.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./run-model-selection.runtime.js")>();
  return {
    ...actual,
    loadProviderScopedThinkingCatalog: (...args: unknown[]) => scopedThinkingCatalogMock(...args),
  };
});

const owner = {
  agentId: "main",
  agentDir: "/tmp/cron-agent",
  workspaceDir: "/tmp/cron-workspace",
  config: {},
  modelCatalog: { entries: [], routeVariants: [] },
  metadataSnapshot: createPluginMetadataSnapshotFixture(),
} satisfies Parameters<typeof resolveCronThinkingSelection>[0]["owner"];

describe("resolveCronThinkingSelection scoped hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopedThinkingCatalogMock.mockResolvedValue([]);
  });

  it.each([
    {
      provider: "ollama",
      model: "minimax-m3:cloud",
      agentRuntime: "openclaw",
      thinking: "medium",
      hasHostRow: false,
    },
    {
      provider: "openai",
      model: "gpt-5.6-luna",
      agentRuntime: "codex",
      thinking: "medium",
      hasHostRow: true,
    },
    {
      provider: "openai",
      model: "gpt-5.6-luna",
      agentRuntime: "codex",
      thinking: "off",
      hasHostRow: true,
    },
  ])(
    "hydrates $provider/$model thinking=$thinking for $agentRuntime through the scoped owner",
    async ({ provider, model, agentRuntime, thinking, hasHostRow }) => {
      scopedThinkingCatalogMock.mockResolvedValue([{ provider, id: model, reasoning: true }]);
      const { resolveCronThinkingSelection } = await import("./model-selection.js");
      const selection = await resolveCronThinkingSelection({
        cfg: {},
        owner: {
          ...owner,
          modelCatalog: {
            entries: hasHostRow ? [{ provider, id: model, name: model, reasoning: false }] : [],
            routeVariants: [],
          },
        },
        provider,
        model,
        agentRuntime,
        jobThinking: thinking,
      });
      expect(selection.requestedThinkLevel).toBe(thinking);
      expect(selection.catalog).toEqual([
        expect.objectContaining({ provider, id: model, reasoning: true }),
      ]);
      expect(scopedThinkingCatalogMock).toHaveBeenCalledWith(
        expect.objectContaining({
          provider,
          model,
          agentRuntime,
          agentId: "main",
          agentDir: "/tmp/cron-agent",
          workspaceDir: "/tmp/cron-workspace",
        }),
      );
    },
  );

  it("keeps the owner catalog and skips hydration when thinking is off", async () => {
    const { resolveCronThinkingSelection } = await import("./model-selection.js");
    const selection = await resolveCronThinkingSelection({
      cfg: {},
      owner,
      provider: "ollama",
      model: "minimax-m3:cloud",
      agentRuntime: "openclaw",
      jobThinking: "off",
    });
    expect(selection.requestedThinkLevel).toBe("off");
    expect(scopedThinkingCatalogMock).not.toHaveBeenCalled();
  });
});
