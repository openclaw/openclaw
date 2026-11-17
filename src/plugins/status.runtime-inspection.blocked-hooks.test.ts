import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { buildPluginInspectReport, withPluginDiagnosticsReport } from "./status.js";

describe("plugin runtime inspection blocked hooks", () => {
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    clearPluginMetadataLifecycleCaches();
    resetPluginLoaderTestStateForTest();
    closeOpenClawStateDatabaseForTest();
  });

  afterAll(async () => {
    // Retire async admission records before deleted fixture inodes can be reused.
    await closeOpenClawStateDatabaseAsync();
    cleanupPluginLoaderFixturesForTest();
  });

  it("scopes refused hook registrations to the inspected plugin", async () => {
    // Two non-bundled plugins each register a conversation hook and neither has
    // allowConversationAccess set, so the registry refuses both. `plugins inspect`
    // must report only the inspected plugin's dead handler.
    const hookBody = (id: string) => `module.exports = { id: ${JSON.stringify(id)}, register(api) {
    api.on("before_prompt_build", () => undefined);
  } };\n`;
    useNoBundledPlugins();
    const first = writePlugin({ id: "blocked-inspect-a", body: hookBody("blocked-inspect-a") });
    const second = writePlugin({ id: "blocked-inspect-b", body: hookBody("blocked-inspect-b") });
    const stateDir = makePluginLoaderTempDir();
    const config = {
      plugins: {
        load: { paths: [first.file, second.file] },
        allow: [first.id, second.id],
      },
    };

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const params = { config, workspaceDir: first.dir, env: process.env };
      await withPluginDiagnosticsReport(params, (report) => {
        const inspect = buildPluginInspectReport({ ...params, id: first.id, report });

        // Both refusals really happened, and inspect shows exactly one of them.
        expect(report.typedHooks).toStrictEqual([]);
        expect(report.blockedHooks.map((entry) => entry.pluginId).toSorted()).toStrictEqual(
          [first.id, second.id].toSorted(),
        );
        expect(inspect?.blockedHooks.map((entry) => entry.pluginId)).toStrictEqual([first.id]);
        expect(inspect?.blockedHooks[0]?.hookName).toBe("before_prompt_build");
        expect(inspect?.blockedHooks[0]?.reason).toBe("conversation-access-missing");
        expect(inspect?.blockedHooks[0]?.severity).toBe("error");
      });
    });
  });
});
