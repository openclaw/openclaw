import { expect, it, vi } from "vitest";
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
const carried = { provider: "openai", id: "gpt-5.6-luna", name: "Selected", reasoning: false };

function selectThinking(
  agentRuntime: string,
  entries: SelectionParams["owner"]["modelCatalog"]["entries"] = [carried],
  jobThinking = "medium",
) {
  return resolveCronThinkingSelection({
    cfg: {},
    owner: { ...owner, modelCatalog: { entries, routeVariants: [] } },
    provider: carried.provider,
    model: carried.id,
    agentRuntime,
    jobThinking,
  });
}

const refreshed = { ...carried, reasoning: true };
const unrelated = { ...carried, id: "unrelated" };
it.each([
  ["off", [refreshed], [refreshed]],
  ["medium", [], [carried]],
  ["medium", [unrelated], [carried]],
] as const)(
  "selects native thinking=%s with refreshed=%j",
  async (thinking, hydration, expected) => {
    scopedThinkingCatalogMock.mockResolvedValue([...hydration]);
    const selection = await selectThinking("codex", [carried], thinking);
    expect(selection).toMatchObject({
      requestedThinkLevel: thinking,
      catalog: expected,
    });
  },
);

it("keeps the admitted catalog when native hydration outlasts the foreground wait", async () => {
  const held = createDeferred<Array<Record<string, unknown>>>();
  vi.useFakeTimers();
  try {
    scopedThinkingCatalogMock.mockReturnValue(held.promise);
    const pending = selectThinking("codex");
    await vi.advanceTimersByTimeAsync(5_000);
    const selection = await pending;
    expect(selection).toMatchObject({ catalog: [carried], requestedThinkLevel: "medium" });
    held.resolve([refreshed]);
    await expect(
      selection.loadThinkingCatalog(carried.provider, carried.id, "codex"),
    ).resolves.toEqual([refreshed]);
  } finally {
    held.resolve([]);
    vi.useRealTimers();
  }
});
