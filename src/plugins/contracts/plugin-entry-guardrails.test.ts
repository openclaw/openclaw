import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPluginManifestRegistry } from "../manifest-registry.js";
const CORE_PLUGIN_ENTRY_IMPORT_RE =
  /import\s*\{[^}]*\bdefinePluginEntry\b[^}]*\}\s*from\s*"openclaw\/plugin-sdk\/core"/;
const RUNTIME_ENTRY_HELPER_RE = /(^|\/)plugin-entry\.runtime\.[cm]?[jt]s$/;

function listBundledPluginRoots() {
  return loadPluginManifestRegistry({})
    .plugins.filter((plugin) => plugin.origin === "bundled")
    .map((plugin) => ({
      pluginId: plugin.id,
      rootDir: plugin.workspaceDir ?? plugin.rootDir,
    }))
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));
}

describe("plugin entry guardrails", () => {
  it("keeps bundled extension entry modules off direct definePluginEntry imports from core", () => {
    const failures: string[] = [];

    for (const plugin of listBundledPluginRoots()) {
      const indexPath = resolve(plugin.rootDir, "index.ts");
      try {
        const source = readFileSync(indexPath, "utf8");
        if (CORE_PLUGIN_ENTRY_IMPORT_RE.test(source)) {
          failures.push(`extensions/${plugin.pluginId}/index.ts`);
        }
      } catch {
        // Skip extensions without index.ts entry modules.
      }
    }

    expect(failures).toEqual([]);
  });

  it("does not advertise runtime helper sidecars as bundled plugin entry extensions", () => {
    const failures: string[] = [];

    for (const plugin of listBundledPluginRoots()) {
      const packageJsonPath = resolve(plugin.rootDir, "package.json");
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          openclaw?: { extensions?: unknown };
        };
        const extensions = Array.isArray(pkg.openclaw?.extensions) ? pkg.openclaw.extensions : [];
        if (
          extensions.some(
            (candidate) => typeof candidate === "string" && RUNTIME_ENTRY_HELPER_RE.test(candidate),
          )
        ) {
          failures.push(`extensions/${plugin.pluginId}/package.json`);
        }
      } catch {
        // Skip directories without package metadata.
      }
    }

    expect(failures).toEqual([]);
  });
});
