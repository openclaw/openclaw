import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearBundledDiscoveryModeMemo } from "../plugins/bundled-discovery-state.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { mkdirSafeDir } from "../plugins/test-helpers/fs-fixtures.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnv } from "../test-utils/env.js";
import { resolveProviderAuthLookupMaps } from "./provider-env-vars.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

describe("provider auth prepared manifest snapshot", () => {
  it.each(["compat", "allowlist"] as const)(
    "uses the explicit profile's %s policy for auth evidence and setup fallback",
    (mode) => {
      const root = tempDirs.make("provider-auth-profile-");
      const bundled = path.join(root, "bundled");
      const rootDir = path.join(bundled, "profile-provider");
      mkdirSafeDir(rootDir);
      const evidence = {
        type: "local-file-with-env",
        fileEnvVar: "FIXTURE_PROVIDER_CREDENTIALS",
        credentialMarker: "fixture-local-auth",
      };
      const fixture = createColdPluginFixture({
        rootDir,
        pluginId: "profile-provider",
        providerId: "profile-provider",
        manifest: {
          enabledByDefault: true,
          channels: [],
          channelConfigs: {},
          providerAuthChoices: [],
          setup: {
            providers: [
              {
                id: "profile-provider",
                envVars: ["FIXTURE_PROVIDER_API_KEY"],
                authEvidence: [evidence],
              },
            ],
          },
        },
      });
      const env: NodeJS.ProcessEnv = {
        OPENCLAW_HOME: path.join(root, "home"),
        OPENCLAW_STATE_DIR: path.join(root, "profile"),
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundled,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
        OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
        VITEST: "true",
      };
      const processEnv = { OPENCLAW_STATE_DIR: path.join(root, "other-profile") };
      writeConfigMachineState("plugins.bundledDiscovery", mode, { env });
      writeConfigMachineState(
        "plugins.bundledDiscovery",
        mode === "compat" ? "allowlist" : "compat",
        { env: processEnv },
      );
      clearBundledDiscoveryModeMemo();
      const config: OpenClawConfig = { plugins: { allow: ["unrelated-owner"] } };
      const metadataSnapshot = loadPluginMetadataSnapshot({
        config,
        env,
        allowCurrent: false,
        preferPersisted: false,
      });
      expect(metadataSnapshot.byPluginId.get("profile-provider")?.origin).toBe("bundled");

      const maps = withEnv(processEnv, () =>
        resolveProviderAuthLookupMaps({ config, env, metadataSnapshot }),
      );
      expect
        .soft(maps.authEvidenceMap["profile-provider"])
        .toEqual(mode === "compat" ? [evidence] : undefined);
      expect
        .soft(maps.setupProviderFallbackRefs)
        .toEqual(mode === "compat" ? ["profile-provider"] : []);
      expect(maps.envCandidateMap["profile-provider"]).toEqual(["FIXTURE_PROVIDER_API_KEY"]);
      expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
    },
  );
});
