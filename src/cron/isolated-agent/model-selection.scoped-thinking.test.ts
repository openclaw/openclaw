// Cron turns must hydrate runtime-only model thinking through the provider-scoped helper,
// never through a full live catalog build.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedPublishedModelCatalogOwner } from "../../agents/prepared-model-catalog.types.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";

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

const metadataSnapshot = createPluginMetadataSnapshotFixture();
const owner: ResolvedPublishedModelCatalogOwner = {
  catalogOwner: { agentId: "main", workspaceDir: "/tmp/cron-workspace" },
  agentId: "main",
  agentDir: "/tmp/cron-agent",
  workspaceDir: "/tmp/cron-workspace",
  config: {},
  authModes: {},
  authStore: { version: 1, profiles: {} },
  metadataSnapshot,
  modelCatalog: { entries: [], routeVariants: [] },
};

describe("resolveCronThinkingSelection scoped hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopedThinkingCatalogMock.mockResolvedValue([]);
  });

  it("hydrates a runtime-only model through the provider-scoped helper", async () => {
    scopedThinkingCatalogMock.mockResolvedValue([
      { provider: "ollama", id: "minimax-m3:cloud", reasoning: true },
    ]);
    const { resolveCronThinkingSelection } = await import("./model-selection.js");
    const selection = await resolveCronThinkingSelection({
      cfg: {},
      owner,
      provider: "ollama",
      model: "minimax-m3:cloud",
      jobThinking: "medium",
    });
    expect(selection.requestedThinkLevel).toBe("medium");
    expect(selection.catalog).toEqual([
      expect.objectContaining({ provider: "ollama", id: "minimax-m3:cloud", reasoning: true }),
    ]);
    expect(scopedThinkingCatalogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "ollama",
        model: "minimax-m3:cloud",
        agentId: "main",
        agentDir: "/tmp/cron-agent",
        workspaceDir: "/tmp/cron-workspace",
      }),
    );
  });

  it("keeps the owner catalog and skips hydration when thinking is off", async () => {
    const { resolveCronThinkingSelection } = await import("./model-selection.js");
    const selection = await resolveCronThinkingSelection({
      cfg: {},
      owner,
      provider: "ollama",
      model: "minimax-m3:cloud",
      jobThinking: "off",
    });
    expect(selection.requestedThinkLevel).toBe("off");
    expect(scopedThinkingCatalogMock).not.toHaveBeenCalled();
  });

  it("uses the admitted catalog when hydration outlasts the foreground wait", async () => {
    vi.useFakeTimers();
    let resolveHydration: (value: Array<Record<string, unknown>>) => void = () => {};
    scopedThinkingCatalogMock.mockReturnValue(
      new Promise((resolve) => {
        resolveHydration = resolve;
      }),
    );
    try {
      const carried = {
        provider: "ollama",
        id: "minimax-m3:cloud",
        name: "MiniMax M3",
        reasoning: true,
      };
      const { resolveCronThinkingSelection } = await import("./model-selection.js");
      const pending = resolveCronThinkingSelection({
        cfg: {},
        owner: { ...owner, modelCatalog: { entries: [carried], routeVariants: [] } },
        provider: carried.provider,
        model: carried.id,
        jobThinking: "medium",
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(pending).resolves.toMatchObject({ catalog: [carried] });
    } finally {
      resolveHydration([]);
      vi.useRealTimers();
    }
  });
});
