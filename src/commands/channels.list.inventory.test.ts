import { expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { channelsListCommand } from "./channels/list.js";
import { createTestConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn(),
  callGateway: vi.fn(),
}));

// mock-isolation: Inventory uses the supplied config snapshot, not the operator's config store.
vi.mock("../config/config.js", () => ({ readConfigFileSnapshot: mocks.readConfigFileSnapshot }));
vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: async ({ config }: { config: OpenClawConfig }) => ({
    resolvedConfig: config,
    effectiveConfig: config,
    diagnostics: [],
  }),
}));
vi.mock("../cli/command-secret-targets.js", () => ({
  getChannelsCommandSecretTargetIds: () => new Set<string>(),
}));
vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: ({ config }: { config: OpenClawConfig }) => ({ config }),
}));
vi.mock("../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
  loadPluginMetadataSnapshotForRegistry: mocks.resolvePluginMetadataSnapshot,
}));
vi.mock("../plugins/control-plane-workspace.js", () => ({
  resolvePluginControlPlaneWorkspace: () => ({ workspaceScope: "shared" }),
}));
vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: () => [],
}));
vi.mock("../plugins/official-external-plugin-repair-hints.js", () => ({
  resolveMissingOfficialExternalChannelPluginRepairHints: () => [],
}));
vi.mock("../gateway/call.js", () => ({ callGateway: mocks.callGateway }));
vi.mock("./channel-setup/trusted-catalog.js", () => ({
  listTrustedChannelPluginCatalogEntries: (): ChannelPluginCatalogEntry[] =>
    ["installed-chat", "missing-chat"].map((id) => ({
      id,
      pluginId: `${id}-plugin`,
      meta: { id, label: id, selectionLabel: id, docsPath: `/channels/${id}`, blurb: id },
      install: { npmSpec: `@example/${id}` },
    })),
}));

it("keeps disabled installed channels distinct from missing ones in JSON", async () => {
  const metadata = createPluginMetadataSnapshotFixture({
    plugins: [{ id: "installed-chat-plugin", channels: ["installed-chat"] }],
  });
  for (const plugin of metadata.index.plugins) {
    plugin.enabled = false;
  }
  mocks.resolvePluginMetadataSnapshot.mockReset().mockReturnValue(metadata);
  mocks.readConfigFileSnapshot.mockResolvedValue(
    createTestConfigSnapshot({
      plugins: { entries: { "installed-chat-plugin": { enabled: false } } },
    }),
  );
  mocks.callGateway.mockReset().mockRejectedValue(new Error("gateway unavailable"));
  const runtime = createTestRuntime();

  await channelsListCommand({ all: true, json: true }, runtime);

  const output = runtime.log.mock.calls[0]?.[0];
  expect(typeof output).toBe("string");
  expect(JSON.parse(String(output))).toEqual({
    chat: {
      "installed-chat": inventoryEntry("installed-chat", true, "available"),
      "missing-chat": inventoryEntry("missing-chat", false, "installable"),
    },
  });
  expect(mocks.callGateway).not.toHaveBeenCalled();
  expect(runtime.error).not.toHaveBeenCalled();
  expect(runtime.exit).not.toHaveBeenCalled();
});

function inventoryEntry(label: string, installed: boolean, origin: string) {
  return { accounts: [], label, installed, origin };
}
