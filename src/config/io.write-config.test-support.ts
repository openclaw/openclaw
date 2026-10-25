import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { createPathResolutionEnv, withEnvAsync } from "../test-utils/env.js";

export function createConfigWriteHomeFixture(makeHome: (prefix: string) => Promise<string>) {
  return async <T>(fn: (home: string) => Promise<T>): Promise<T> => {
    const home = await makeHome("case");
    return withEnvAsync(
      createPathResolutionEnv(home, {
        // Env-only state readers and global write metadata must share the injected IO home.
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_DEFER_SHELL_ENV_FALLBACK: undefined,
        OPENCLAW_LOAD_SHELL_ENV: undefined,
        OPENCLAW_SHELL_ENV_TIMEOUT_MS: undefined,
      }),
      () => fn(home),
    );
  };
}

export function createConfigWritePluginRegistry(
  id: string,
  configSchema: NonNullable<PluginManifestRegistry["plugins"][number]["configSchema"]>,
  enabledByDefault?: boolean,
): PluginManifestRegistry {
  const rootDir = `/tmp/openclaw-test-${id}`;
  return {
    diagnostics: [],
    plugins: [
      {
        id,
        rootDir,
        source: `${rootDir}/index.ts`,
        manifestPath: `${rootDir}/openclaw.plugin.json`,
        origin: "bundled",
        channels: [],
        providers: [],
        cliBackends: [],
        skills: [],
        hooks: [],
        configSchema,
        ...(enabledByDefault === undefined ? {} : { enabledByDefault }),
      },
    ],
  };
}

export const defaultedDemoPluginRegistry = createConfigWritePluginRegistry(
  "demo",
  {
    type: "object",
    properties: { mode: { type: "string", default: "auto" } },
    additionalProperties: true,
  },
  true,
);
