import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
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

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));
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

describe("channels list installed inventory", () => {
  beforeEach(() => {
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
  });

  it.each([false, true])(
    "keeps disabled installed channels distinct from missing ones: json=%s",
    async (json) => {
      const runtime = createTestRuntime();

      await channelsListCommand({ all: true, json }, runtime);

      const output = runtime.log.mock.calls[0]?.[0];
      expect(typeof output).toBe("string");
      if (typeof output !== "string") {
        throw new Error("expected channel inventory output");
      }
      if (json) {
        expect(JSON.parse(output)).toEqual({
          chat: {
            "installed-chat": {
              accounts: [],
              label: "installed-chat",
              installed: true,
              origin: "available",
            },
            "missing-chat": {
              accounts: [],
              label: "missing-chat",
              installed: false,
              origin: "installable",
            },
          },
        });
        expect(mocks.callGateway).not.toHaveBeenCalled();
      } else {
        expect(stripAnsi(output)).toContain(
          "- installed-chat: installed, not configured, disabled",
        );
        expect(stripAnsi(output)).toContain(
          "- missing-chat: not installed, not configured, disabled",
        );
      }
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
    },
  );
});
