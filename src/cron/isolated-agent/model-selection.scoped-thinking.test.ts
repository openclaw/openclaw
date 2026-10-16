// Cron turns must hydrate runtime-only model thinking through the provider-scoped helper,
// never through a full live catalog build.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { resolveCronThinkingSelection } from "./model-selection.js";

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

  it.each([
    { refreshed: [] },
    { refreshed: [{ provider: "other", id: "unrelated", name: "Unrelated", reasoning: true }] },
  ])("keeps the admitted catalog when hydration has no selected row: %j", async ({ refreshed }) => {
    scopedThinkingCatalogMock.mockResolvedValue(refreshed);
    const carried = { provider: "openai", id: "gpt-5.6-luna", name: "Selected", reasoning: false };
    const selection = await resolveCronThinkingSelection({
      cfg: {},
      owner: { ...owner, modelCatalog: { entries: [carried], routeVariants: [] } },
      provider: carried.provider,
      model: carried.id,
      agentRuntime: "codex",
      jobThinking: "medium",
    });
    expect(selection.catalog).toEqual([carried]);
    expect(selection.requestedThinkLevel).toBe("medium");
    expect(scopedThinkingCatalogMock).toHaveBeenCalledOnce();
  });

  it("keeps the admitted catalog when native hydration outlasts the foreground wait", async () => {
    const held = createDeferred<Array<Record<string, unknown>>>();
    vi.useFakeTimers();
    try {
      scopedThinkingCatalogMock.mockReturnValue(held.promise);
      const carried = {
        provider: "anthropic",
        id: "claude-opus-5-5",
        name: "Opus",
        reasoning: true,
      };
      const pending = resolveCronThinkingSelection({
        cfg: {},
        owner: { ...owner, modelCatalog: { entries: [carried], routeVariants: [] } },
        provider: carried.provider,
        model: carried.id,
        agentRuntime: "claude-cli",
        jobThinking: "medium",
      });
      const completed = vi.fn();
      void pending.then(completed);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(completed).toHaveBeenCalledWith(
        expect.objectContaining({ catalog: [carried], requestedThinkLevel: "medium" }),
      );
      const selection = await pending;
      const refreshed = { ...carried, name: "Published native model", reasoning: false };
      held.resolve([refreshed]);
      await expect(
        selection.loadThinkingCatalog(carried.provider, carried.id, "claude-cli"),
      ).resolves.toEqual([refreshed]);
    } finally {
      held.resolve([]);
      vi.useRealTimers();
    }
  });

  it("keeps the owner catalog and skips hydration when thinking is off", async () => {
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
