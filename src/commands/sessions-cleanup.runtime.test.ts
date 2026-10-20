import { expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { cleanupSummary } from "./sessions-cleanup-summary.test-support.js";
import { runLocalSessionsCleanup } from "./sessions-cleanup.runtime.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const runSessionsCleanup = vi.hoisted(() => vi.fn());

vi.mock("../config/sessions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions.js")>()),
  runSessionsCleanup,
}));
vi.mock("../plugins/loader.js", () => ({
  loadPluginRegistryHandle: vi.fn(() => ({})),
}));
vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: vi.fn(() => ({
    plugins: [],
    manifestRegistry: {},
    discovery: {},
    index: {},
  })),
}));
vi.mock("../plugins/installed-plugin-index-install-records.js", () => ({
  extractPluginInstallRecordsFromInstalledPluginIndex: vi.fn(() => []),
}));
vi.mock("../plugins/activation-planner.js", () => ({
  resolveManifestActivationPluginIds: vi.fn(() => []),
}));
vi.mock("../plugins/activation-context.js", () => ({
  withActivatedPluginIds: vi.fn((args: { config: unknown }) => args.config),
}));
vi.mock("../plugins/runtime/gateway-request-scope.js", () => ({
  withPluginRuntimeRegistryScope: vi.fn((_registry: unknown, run: () => unknown) => run()),
}));
vi.mock("../agents/agent-scope-config.js", () => ({
  resolveAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-test-workspace"),
}));

it("keeps prior store summaries when a later target returns a failure", async () => {
  vi.clearAllMocks();
  await withOpenClawTestState({ label: "cleanup-partial" }, async (state) => {
    const target = (agentId: string) => ({
      agentId,
      storePath: state.statePath(`agents/${agentId}/sessions/sessions.json`),
    });
    const mainSummary = cleanupSummary({
      mode: "enforce",
      dryRun: false,
      beforeCount: 1,
      missing: 1,
      wouldMutate: true,
      applied: true,
      appliedCount: 0,
    });
    runSessionsCleanup
      .mockResolvedValueOnce({
        mode: "enforce",
        previewResults: [],
        appliedSummaries: [mainSummary],
      })
      .mockRejectedValueOnce(new Error("injected later-store failure"));

    const result = await runLocalSessionsCleanup(
      {
        cfg: {},
        opts: { enforce: true },
        targets: [target("main"), target("work")],
      },
      createTestRuntime(),
    );

    expect(result.appliedSummaries).toEqual([mainSummary]);
    const modes = runSessionsCleanup.mock.calls.map(([params]) => params.reclamationMode);
    expect(modes).toEqual(["in-process", "in-process"]);
    expect(result.failure).toMatchObject({
      target: target("work"),
      lifecycleCommitted: false,
    });
  });
});
