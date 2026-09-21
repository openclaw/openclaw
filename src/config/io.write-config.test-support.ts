import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";

export const defaultedDemoPluginRegistry = {
  diagnostics: [],
  plugins: [
    {
      id: "demo",
      origin: "bundled",
      enabledByDefault: true,
      channels: [],
      providers: [],
      cliBackends: [],
      skills: [],
      hooks: [],
      rootDir: "/tmp/openclaw-test-demo",
      source: "/tmp/openclaw-test-demo/index.ts",
      manifestPath: "/tmp/openclaw-test-demo/openclaw.plugin.json",
      configSchema: {
        type: "object",
        properties: { mode: { type: "string", default: "auto" } },
        additionalProperties: true,
      },
    },
  ],
} satisfies PluginManifestRegistry;
