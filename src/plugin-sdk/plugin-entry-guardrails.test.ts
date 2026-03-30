import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BUNDLED_PLUGIN_ROOT_DIR,
  bundledPluginFile,
} from "../../test/helpers/bundled-plugin-paths.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(ROOT_DIR, "..");
const EXTENSIONS_DIR = resolve(REPO_ROOT, BUNDLED_PLUGIN_ROOT_DIR);
const CORE_PLUGIN_ENTRY_IMPORT_RE =
  /import\s*\{[^}]*\bdefinePluginEntry\b[^}]*\}\s*from\s*"openclaw\/plugin-sdk\/core"/;
const RUNTIME_ENTRY_HELPER_RE = /(^|\/)plugin-entry\.runtime\.[cm]?[jt]s$/;

describe("plugin entry guardrails", () => {
  it("keeps bundled extension entry modules off direct definePluginEntry imports from core", () => {
    const failures: string[] = [];

    for (const entry of readdirSync(EXTENSIONS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const indexPath = resolve(EXTENSIONS_DIR, entry.name, "index.ts");
      try {
        const source = readFileSync(indexPath, "utf8");
        if (CORE_PLUGIN_ENTRY_IMPORT_RE.test(source)) {
          failures.push(bundledPluginFile(entry.name, "index.ts"));
        }
      } catch {
        // Skip extensions without index.ts entry modules.
      }
    }

    expect(failures).toEqual([]);
  });

  it("does not advertise runtime helper sidecars as bundled plugin entry extensions", () => {
    const failures: string[] = [];

    for (const entry of readdirSync(EXTENSIONS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageJsonPath = resolve(EXTENSIONS_DIR, entry.name, "package.json");
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
          failures.push(bundledPluginFile(entry.name, "package.json"));
        }
      } catch {
        // Skip directories without package metadata.
      }
    }

    expect(failures).toEqual([]);
  });
});
