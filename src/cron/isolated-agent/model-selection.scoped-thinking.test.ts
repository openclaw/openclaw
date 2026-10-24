import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { resolveCronThinkingSelection } from "./model-selection.js";
type SelectionParams = Parameters<typeof resolveCronThinkingSelection>[0];

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

const owner: SelectionParams["owner"] = {
  agentId: "main",
  agentDir: "/tmp/cron-agent",
  workspaceDir: "/tmp/cron-workspace",
  config: {},
  modelCatalog: { entries: [], routeVariants: [] },
  metadataSnapshot: createPluginMetadataSnapshotFixture(),
};

function selectThinking(
  provider: string,
  model: string,
  agentRuntime: string,
  entries: SelectionParams["owner"]["modelCatalog"]["entries"] = [],
  jobThinking = "medium",
) {
  return resolveCronThinkingSelection({
    cfg: {},
    owner: { ...owner, modelCatalog: { entries, routeVariants: [] } },
    provider,
    model,
    agentRuntime,
    jobThinking,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  scopedThinkingCatalogMock.mockResolvedValue([]);
});

it.each([
  ["ollama", "minimax-m3:cloud", "openclaw", "medium", false],
  ["openai", "gpt-5.6-luna", "codex", "medium", true],
  ["openai", "gpt-5.6-luna", "codex", "off", true],
] as const)(
  "hydrates %s/%s runtime=%s thinking=%s through the scoped owner (host row=%s)",
  async (provider, model, agentRuntime, thinking, hasHostRow) => {
    scopedThinkingCatalogMock.mockResolvedValue([{ provider, id: model, reasoning: true }]);
    const entries = hasHostRow ? [{ provider, id: model, name: model, reasoning: false }] : [];
    const selection = await selectThinking(provider, model, agentRuntime, entries, thinking);
    expect(selection).toMatchObject({
      requestedThinkLevel: thinking,
      catalog: [expect.objectContaining({ provider, id: model, reasoning: true })],
    });
    const { agentId, agentDir, workspaceDir } = owner;
    expect(scopedThinkingCatalogMock).toHaveBeenCalledWith(
      expect.objectContaining({ provider, model, agentRuntime, agentId, agentDir, workspaceDir }),
    );
  },
);

it.each([
  { refreshed: [] },
  { refreshed: [{ provider: "other", id: "unrelated", name: "Unrelated", reasoning: true }] },
])("keeps the admitted catalog when hydration has no selected row: %j", async ({ refreshed }) => {
  scopedThinkingCatalogMock.mockResolvedValue(refreshed);
  const carried = { provider: "openai", id: "gpt-5.6-luna", name: "Selected", reasoning: false };
  const selection = await selectThinking(carried.provider, carried.id, "codex", [carried]);
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
    const pending = selectThinking(carried.provider, carried.id, "claude-cli", [carried]);
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
  const selection = await selectThinking("ollama", "minimax-m3:cloud", "openclaw", [], "off");
  expect(selection.requestedThinkLevel).toBe("off");
  expect(scopedThinkingCatalogMock).not.toHaveBeenCalled();
});
