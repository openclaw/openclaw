import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import * as cold from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { buildAuthChoiceGroups, formatAuthChoiceChoicesForCli } from "./auth-choice-options.js";
import { listManifestInstalledChannelIds } from "./channel-setup/trusted-catalog.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Status also checks sandbox containers; keep that unrelated host probe hermetic.
vi.mock("../agents/sandbox/docker.js", () => ({
  execDockerRaw: vi.fn(async () => ({ code: 0, stdout: "", stderr: "" })),
}));

const makeTempDir = () => tempDirs.make("openclaw-command-cold-imports");

function metadataFixture() {
  const plugin = cold.createColdPluginFixture({ rootDir: makeTempDir() });
  const workspaceDir = makeTempDir();
  const config = cold.createColdPluginConfig(plugin.rootDir, plugin.pluginId);
  const env = cold.createColdPluginHermeticEnv(workspaceDir);
  return { plugin, params: { config, workspaceDir, env } };
}

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
});

it.each([true, false])("audits setup warnings with enabled=%s", async (enabled) => {
  await withOpenClawTestState(
    {
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", OPENCLAW_BUNDLED_PLUGINS_DIR: undefined },
    },
    async (state) => {
      const checkId = "channels.cold-channel.setup_warning";
      const finding = { checkId, severity: "warn", title: "Setup", detail: "Fixture" };
      const plugin = cold.createColdPluginFixture({
        rootDir: makeTempDir(),
        manifest: { setup: { requiresRuntime: false } },
        setupEntrySource: `module.exports = {
  plugin: {
    id: "cold-channel",
    meta: { id: "cold-channel", label: "Cold Channel" },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: (cfg) => cfg.channels["cold-channel"],
      inspectAccount: (cfg) => ({ ...cfg.channels["cold-channel"], configured: true }),
    },
    security: {
      collectWarnings: ({ account }) => account.auditWarning ? [${JSON.stringify(finding)}] : [],
    },
  },
};`,
      });
      const config = {
        ...cold.createColdPluginConfig(plugin.rootDir, plugin.pluginId),
        agents: { defaults: { workspace: state.workspaceDir } },
        channels: { [plugin.channelId]: { enabled, auditWarning: true } },
      };
      const { resolveStatusSecurityAudit } = await import("./status-runtime-shared.js");
      const report = await resolveStatusSecurityAudit({ config, sourceConfig: config });

      expect(report.findings.filter((entry) => entry.checkId === checkId)).toEqual(
        enabled ? [finding] : [],
      );
      expect(cold.isColdPluginRuntimeLoaded(plugin)).toBe(false);
    },
  );
});

it("resolves channel setup metadata without importing plugin runtime", () => {
  const { plugin, params } = metadataFixture();
  const channels = listManifestInstalledChannelIds({ ...params, cfg: params.config });
  expect(channels).toContain(plugin.channelId);
  expect(cold.isColdPluginRuntimeLoaded(plugin)).toBe(false);
});

it("builds onboarding auth choices from manifest metadata without importing plugin runtime", () => {
  const { plugin, params } = metadataFixture();
  const choice = buildAuthChoiceGroups({ ...params, includeSkip: false })
    .groups.flatMap((group) => group.options)
    .find((option) => option.value === plugin.authChoiceId);
  expect(choice).toMatchObject({
    label: "Cold Provider API key",
    groupId: plugin.providerId,
  });
  expect(formatAuthChoiceChoicesForCli(params).split("|")).toContain(plugin.authChoiceId);
  expect(cold.isColdPluginRuntimeLoaded(plugin)).toBe(false);
});
