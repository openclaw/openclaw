// Verifies plugin auto-enable prefer-over precedence rules.
import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";

vi.mock("../plugins/bundled-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/bundled-dir.js")>();
  return {
    ...actual,
    resolveBundledPluginsDir: (env: NodeJS.ProcessEnv = process.env) =>
      env.OPENCLAW_BUNDLED_PLUGINS_DIR,
  };
});

const tempDirs: string[] = [];

function makeTempDir(): string {
  const trustedRoot = path.resolve("dist-runtime", "extensions");
  fs.mkdirSync(trustedRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(trustedRoot, ".openclaw-plugin-prefer-over-"));
  tempDirs.push(dir);
  return dir;
}

function writeBundledChannelPackage(rootDir: string, channelId: string): void {
  const pluginDir = path.join(rootDir, channelId);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      openclaw: {
        channel: {
          id: channelId,
          label: "Cache Drift",
          selectionLabel: "Cache Drift",
          docsPath: `/channels/${channelId}`,
          blurb: "Cache drift fixture",
        },
      },
    }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: channelId,
      configSchema: { type: "object" },
      channels: [channelId],
    }),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.js"),
    "export default { register() {} };\n",
    "utf-8",
  );
}

const EMPTY_MANIFEST_REGISTRY: PluginManifestRegistry = {
  plugins: [],
  diagnostics: [],
};
