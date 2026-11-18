/** Tests warning replacement and recovery through provider-auth runtime refreshes. */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  activateSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
  refreshActiveProviderAuthRuntimeSnapshot,
} from "./runtime.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.ts";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("provider-auth runtime warning projection", () => {
  it.each([
    { providerId: "openai", warningPath: "models.providers.openai.apiKey" },
    { providerId: "123", warningPath: 'models.providers["123"].apiKey' },
    { providerId: "local.service", warningPath: 'models.providers["local.service"].apiKey' },
  ])(
    "replaces and clears provider-auth warnings at $warningPath",
    async ({ providerId, warningPath }) => {
      const stateDir = tempDirs.make("openclaw-provider-auth-warnings-");
      const secretFile = path.join(stateDir, "secrets.json");
      const writeSecrets = (apiKey?: string) =>
        fs.writeFile(secretFile, JSON.stringify({ apiKey }), { mode: 0o600 });
      await writeSecrets("initial-fixture-value");
      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: asConfig({
          agents: { entries: { main: {} } },
          plugins: { enabled: false },
          secrets: { providers: { fixture: { source: "file", path: secretFile, mode: "json" } } },
          models: {
            providers: {
              [providerId]: {
                baseUrl: "https://provider.example.invalid/v1",
                apiKey: { source: "file", provider: "fixture", id: "/apiKey" },
                models: [],
              },
            },
          },
        }),
        env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_HOME: stateDir },
        includeAuthStoreRefs: false,
        loadablePluginOrigins: new Map(),
      });
      activateSecretsRuntimeSnapshot(snapshot);

      await writeSecrets();
      await expect(refreshActiveProviderAuthRuntimeSnapshot()).resolves.toBe(true);
      const expectedWarning = expect.objectContaining({
        code: "SECRETS_OWNER_UNAVAILABLE",
        path: warningPath,
      });
      expect(getActiveSecretsRuntimeSnapshot()?.warnings).toEqual([expectedWarning]);
      await expect(refreshActiveProviderAuthRuntimeSnapshot()).resolves.toBe(true);
      expect(getActiveSecretsRuntimeSnapshot()?.warnings).toEqual([expectedWarning]);

      await writeSecrets("recovered-fixture-value");
      await expect(refreshActiveProviderAuthRuntimeSnapshot()).resolves.toBe(true);
      expect(getActiveSecretsRuntimeSnapshot()?.warnings).toEqual([]);
      expect(
        getActiveSecretsRuntimeSnapshot()?.config.models?.providers?.[providerId]?.apiKey,
      ).toBe("recovered-fixture-value");
    },
  );
});
