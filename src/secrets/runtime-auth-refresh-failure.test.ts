import syncFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import {
  beginSecretsRuntimeIsolationForTest,
  createOpenAIFileRuntimeConfig,
  createOpenAIFileRuntimeFixture,
  EMPTY_LOADABLE_PLUGIN_ORIGINS,
  endSecretsRuntimeIsolationForTest,
  expectResolvedOpenAIRuntime,
  loadAuthStoreWithProfiles,
  OPENAI_FILE_KEY_REF,
  type SecretsRuntimeEnvSnapshot,
} from "./runtime-auth.integration.test-helpers.js";
import {
  activateSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  prepareSecretsRuntimeSnapshot,
} from "./runtime.js";

vi.unmock("../version.js");

describe("secrets runtime snapshot auth refresh failure", () => {
  let envSnapshot: SecretsRuntimeEnvSnapshot;

  beforeEach(() => {
    envSnapshot = beginSecretsRuntimeIsolationForTest();
  });

  afterEach(() => {
    endSecretsRuntimeIsolationForTest(envSnapshot);
  });

  it("keeps last-known-good runtime snapshot active when refresh preparation fails", async () => {
    if (os.platform() === "win32") {
      return;
    }
    await withTempHome("openclaw-secrets-runtime-refresh-fail-", async (home) => {
      const { secretFile, agentDir } = await createOpenAIFileRuntimeFixture(home);

      let loadAuthStoreCalls = 0;
      const loadAuthStore = () => {
        loadAuthStoreCalls += 1;
        if (loadAuthStoreCalls > 1) {
          throw new Error("simulated secrets runtime refresh failure");
        }
        return loadAuthStoreWithProfiles({
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: OPENAI_FILE_KEY_REF,
          },
        });
      };

      const prepared = await prepareSecretsRuntimeSnapshot({
        config: createOpenAIFileRuntimeConfig(secretFile),
        agentDirs: [agentDir],
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
        loadAuthStore,
      });

      activateSecretsRuntimeSnapshot(prepared);
      expectResolvedOpenAIRuntime(agentDir);

      await expect(
        prepareSecretsRuntimeSnapshot({
          config: {
            ...createOpenAIFileRuntimeConfig(secretFile),
            gateway: { auth: { mode: "token" } },
          },
          agentDirs: [agentDir],
          loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
          loadAuthStore,
        }),
      ).rejects.toThrow(/simulated secrets runtime refresh failure/i);

      const activeAfterFailure = getActiveSecretsRuntimeSnapshot();
      expect(activeAfterFailure).not.toBeNull();
      expectResolvedOpenAIRuntime(agentDir);
      expect(activeAfterFailure?.sourceConfig.models?.providers?.openai?.apiKey).toEqual(
        OPENAI_FILE_KEY_REF,
      );
    });
  });

  it("captures auth store mtime before loading each auth store", async () => {
    await withTempHome("openclaw-secrets-runtime-auth-mtime-", async (home) => {
      const agentDir = path.join(home, ".openclaw", "agents", "main", "agent");
      const authPath = path.join(agentDir, "auth-profiles.json");
      await fs.mkdir(agentDir, { recursive: true });

      const oldStore = loadAuthStoreWithProfiles({
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-old",
        },
      });
      const newStore = loadAuthStoreWithProfiles({
        "openai:default": {
          type: "api_key",
          provider: "openai",
          key: "sk-new",
        },
      });

      await fs.writeFile(authPath, `${JSON.stringify(oldStore, null, 2)}\n`, "utf8");
      await fs.utimes(authPath, new Date(1000), new Date(1000));

      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: {},
        agentDirs: [agentDir],
        loadablePluginOrigins: EMPTY_LOADABLE_PLUGIN_ORIGINS,
        loadAuthStore: () => {
          syncFs.writeFileSync(authPath, `${JSON.stringify(newStore, null, 2)}\n`, "utf8");
          syncFs.utimesSync(authPath, new Date(2000), new Date(2000));
          return oldStore;
        },
      });

      expect(snapshot.authStores[0]?.store.profiles["openai:default"]).toMatchObject({
        type: "api_key",
        key: "sk-old",
      });
      expect(snapshot.authStoreMtimes?.[agentDir]).toBe(1000);
    });
  });
});
