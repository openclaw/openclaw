import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
  isColdPluginRuntimeLoaded,
} from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { resolveReadOnlyChannelPluginsForConfig } from "./read-only.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
    resetPluginRuntimeStateForTest();
    cleanup();
  }),
);

function workspacePlugin(workspaceDir: string, channelId: string) {
  const rootDir = path.join(workspaceDir, ".openclaw", "extensions", `${channelId}-plugin`);
  fs.mkdirSync(rootDir, { recursive: true });
  return createColdPluginFixture({
    rootDir,
    pluginId: `${channelId}-plugin`,
    packageName: `@example/${channelId}-plugin`,
    providerId: `${channelId}-provider`,
    authChoiceId: `${channelId}-api-key`,
    channelId,
  });
}

describe("read-only channel plugin legacy workspace discovery", () => {
  it.each([true, false])(
    "discovers configured workspace channels (retained owner: %s)",
    (legacy) => {
      const root = fs.realpathSync.native(tempDirs.make("read-only-workspaces-"));
      const opsWorkspace = path.join(root, "ops");
      const researchWorkspace = path.join(root, "research");
      const plugins = [workspacePlugin(opsWorkspace, "ops-chat")];
      if (!legacy) {
        plugins.push(workspacePlugin(researchWorkspace, "research-chat"));
      }
      const config = {
        agents: {
          ownership: "explicit" as const,
          entries: {
            research: legacy ? {} : { workspace: researchWorkspace },
            ops: { workspace: opsWorkspace },
          },
        },
        channels: Object.fromEntries(
          plugins.map(({ channelId }) => [channelId, { enabled: true }]),
        ),
        plugins: {
          allow: plugins.map(({ pluginId }) => pluginId),
          entries: Object.fromEntries(plugins.map(({ pluginId }) => [pluginId, { enabled: true }])),
        },
      };
      const cfg = legacy ? retainLegacyDefaultAgentId(config, "ops") : config;
      const stateDir = path.join(root, "state");
      const resolution = resolveReadOnlyChannelPluginsForConfig(cfg, {
        env: { ...createColdPluginHermeticEnv(root), OPENCLAW_STATE_DIR: stateDir },
        stateDir,
        includePersistedAuthState: false,
      });

      expect(resolution.plugins.map((plugin) => plugin.id)).toEqual(
        expect.arrayContaining(plugins.map(({ channelId }) => channelId)),
      );
      for (const plugin of plugins) {
        expect(resolution.manifestRecords.find(({ id }) => id === plugin.pluginId)).toMatchObject({
          source: plugin.runtimeSource,
          origin: "workspace",
        });
        expect(isColdPluginRuntimeLoaded(plugin)).toBe(false);
      }
    },
  );
});
