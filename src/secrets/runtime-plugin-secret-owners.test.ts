import fs from "node:fs/promises";
import path from "node:path";
import { assertPluginCapabilitySecretAvailable } from "openclaw/plugin-sdk/secret-input-runtime";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { activateSecretsRuntimeSnapshot } from "./runtime.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.js";

const origins = new Map([["tavily", "bundled" as const]]);
const keyPath = "plugins.entries.tavily.config.webSearch.apiKey";
const keyRef = {
  source: "exec",
  provider: "tavily-vault",
  id: "tavily/api-key",
} as const;
const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function tavilyFixture() {
  const commandPath = path.join(tempDirs.make("openclaw-tavily-secret-"), "provider.sh");
  const config = asConfig({
    agents: { entries: { main: {} } },
    tools: { web: { search: { enabled: false } } },
    plugins: {
      entries: {
        tavily: { enabled: true, config: { webSearch: { apiKey: keyRef } } },
      },
    },
    secrets: {
      providers: {
        "tavily-vault": {
          source: "exec",
          command: commandPath,
          passEnv: ["PATH"],
          timeoutMs: 20_000,
          noOutputTimeoutMs: 20_000,
        },
      },
    },
  });
  return {
    writeProvider: (available: boolean) =>
      fs.writeFile(
        commandPath,
        available
          ? `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify({
              protocolVersion: 1,
              values: { [keyRef.id]: "resolved-tavily-key" },
            })}'`
          : "#!/bin/sh\nexit 1\n",
        { encoding: "utf8", mode: 0o700 },
      ),
    prepare: (allowUnavailableSecretOwners = false) =>
      prepareSecretsRuntimeSnapshot({
        config,
        env: { PATH: process.env.PATH ?? "", TAVILY_API_KEY: "ambient-must-not-be-used" },
        includeAuthStoreRefs: false,
        allowUnavailableSecretOwners,
        loadablePluginOrigins: origins,
      }),
  };
}

it.each([false, true])("isolates Tavily failure after activation: %s", async (reload) => {
  if (process.platform === "win32") {
    return;
  }
  const fixture = tavilyFixture();
  if (reload) {
    await fixture.writeProvider(true);
    const active = await fixture.prepare();
    activateSecretsRuntimeSnapshot(active);
  }
  await fixture.writeProvider(false);
  const snapshot = await fixture.prepare(true);
  expect(snapshot.config.plugins?.entries?.tavily?.config).toMatchObject({
    webSearch: { apiKey: keyRef },
  });
  expect(snapshot.degradedOwners).toMatchObject([{ degradationState: "cold" }]);
  activateSecretsRuntimeSnapshot(snapshot);
  expect(() => assertPluginCapabilitySecretAvailable(keyPath)).toThrow(
    expect.objectContaining({
      name: "SecretSurfaceUnavailableError",
      ownerKind: "capability",
      ownerId: keyPath,
    }),
  );
});
