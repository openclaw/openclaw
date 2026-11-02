import fs from "node:fs";
import path from "node:path";
import { afterEach } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

export function makeBundledEsmFixtureRoot(prefix: string): string {
  const root = tempDirs.make(prefix);
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
  return root;
}

export function writeAlphaSdkAliasDistFixture(pluginDir: string, label: string) {
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "index.js"),
    [
      'import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";',
      "export default defineBundledChannelEntry({",
      "  id: 'alpha',",
      "  name: 'Alpha',",
      "  description: 'Alpha',",
      "  importMetaUrl: import.meta.url,",
      "  plugin: { specifier: './plugin.js', exportName: 'plugin' },",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "plugin.js"),
    [
      "export const plugin = {",
      "  id: 'alpha',",
      `  meta: { id: 'alpha', label: '${label}' },`,
      "  capabilities: {},",
      "  config: {},",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
}
