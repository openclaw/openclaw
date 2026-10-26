import fs from "node:fs/promises";
import path from "node:path";
import { assertPluginCapabilitySecretAvailable } from "openclaw/plugin-sdk/secret-input-runtime";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { activateSecretsRuntimeSnapshotState } from "./runtime-state.js";
import { asConfig, setupSecretsRuntimeSnapshotTestHooks } from "./runtime.test-support.js";

const BUNDLED_TAVILY_PLUGIN_ORIGINS = new Map([["tavily", "bundled" as const]]);
const TAVILY_TOOL_KEY_PATH = "plugins.entries.tavily.config.webSearch.apiKey";
const TAVILY_TOOL_KEY_REF = {
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
        tavily: { enabled: true, config: { webSearch: { apiKey: TAVILY_TOOL_KEY_REF } } },
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
              values: { [TAVILY_TOOL_KEY_REF.id]: "resolved-tavily-key" },
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
        loadablePluginOrigins: BUNDLED_TAVILY_PLUGIN_ORIGINS,
      }),
  };
}

it.each([false, true])(
  "isolates a failed Tavily provider (previously active: %s)",
  async (reload) => {
    if (process.platform === "win32") {
      return;
    }
    const fixture = tavilyFixture();
    if (reload) {
      await fixture.writeProvider(true);
      const active = await fixture.prepare();
      activateSecretsRuntimeSnapshotState({
        snapshot: active,
        refreshContext: null,
        refreshHandler: null,
      });
      expect(active.config.plugins?.entries?.tavily?.config).toMatchObject({
        webSearch: { apiKey: "resolved-tavily-key" },
      });
    }
    await fixture.writeProvider(false);
    const snapshot = await fixture.prepare(true);
    expect(snapshot.config.plugins?.entries?.tavily?.config).toMatchObject({
      webSearch: { apiKey: TAVILY_TOOL_KEY_REF },
    });
    expect(snapshot.degradedOwners).toMatchObject([
      { ownerKind: "capability", ownerId: TAVILY_TOOL_KEY_PATH, degradationState: "cold" },
    ]);
    activateSecretsRuntimeSnapshotState({ snapshot, refreshContext: null, refreshHandler: null });
    expect(() => assertPluginCapabilitySecretAvailable(TAVILY_TOOL_KEY_PATH)).toThrow(
      expect.objectContaining({
        name: "SecretSurfaceUnavailableError",
        ownerKind: "capability",
        ownerId: TAVILY_TOOL_KEY_PATH,
      }),
    );
  },
);
