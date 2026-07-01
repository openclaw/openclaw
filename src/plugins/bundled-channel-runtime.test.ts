/** Verifies bundled channel plugin runtime loading and channel ownership. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listBundledChannelPluginMetadata,
  resolveBundledChannelGeneratedPath,
  resolveBundledChannelWorkspacePath,
} from "./bundled-channel-runtime.js";

const tempRoots: string[] = [];

function createTempRoot(): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-empty-bundled-root-"));
  tempRoots.push(tempRoot);
  return tempRoot;
}

afterEach(() => {
  for (const tempRoot of tempRoots.splice(0)) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("bundled channel runtime metadata", () => {
  it("preserves explicit empty bundled roots", () => {
    const tempRoot = createTempRoot();

    expect(listBundledChannelPluginMetadata({ rootDir: tempRoot })).toStrictEqual([]);
    expect(
      resolveBundledChannelWorkspacePath({
        rootDir: tempRoot,
        pluginId: "telegram",
      }),
    ).toBe(null);
  });

  it("preserves explicit missing bundled scan roots", () => {
    const tempRoot = createTempRoot();
    const missingScanDir = path.join(tempRoot, "missing-extensions");

    expect(
      listBundledChannelPluginMetadata({
        rootDir: tempRoot,
        scanDir: missingScanDir,
      }),
    ).toStrictEqual([]);
  });

  it("prefers package-local dist entries over source checkout channel entries", () => {
    const tempRoot = createTempRoot();
    const pluginRoot = path.join(tempRoot, "extensions", "slack");
    fs.mkdirSync(path.join(pluginRoot, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export default {};\n", "utf8");
    fs.writeFileSync(path.join(pluginRoot, "dist", "index.js"), "export default {};\n", "utf8");

    expect(
      resolveBundledChannelGeneratedPath(
        tempRoot,
        {
          source: "./index.ts",
          built: "index.js",
        },
        "slack",
        path.join(tempRoot, "extensions"),
      ),
    ).toBe(path.join(pluginRoot, "dist", "index.js"));
  });

  it("prefers package-local dist entries for absolute installed registry sources", () => {
    const tempRoot = createTempRoot();
    const pluginRoot = path.join(tempRoot, "extensions", "slack");
    const builtScanRoot = path.join(tempRoot, "dist", "extensions");
    fs.mkdirSync(path.join(pluginRoot, "dist"), { recursive: true });
    fs.mkdirSync(path.join(builtScanRoot, "slack"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export default {};\n", "utf8");
    fs.writeFileSync(path.join(pluginRoot, "dist", "index.js"), "export default {};\n", "utf8");

    expect(
      resolveBundledChannelGeneratedPath(
        tempRoot,
        {
          source: path.join(pluginRoot, "index.ts"),
          built: path.join(pluginRoot, "index.ts"),
        },
        "slack",
        builtScanRoot,
      ),
    ).toBe(path.join(pluginRoot, "dist", "index.js"));
  });

  it("resolves nested installed-dist entries from the registry plugin root", () => {
    // Installed runtimes resolve the plugin root (often a realpath) independently of the
    // bundled scan dir. When the two diverge, the entry lives under the registry rootDir but
    // not under any scan-dir-derived root; the resolver must still find the nested built entry.
    const tempRoot = createTempRoot();
    const installedRoot = path.join(tempRoot, "installed", "telegram");
    const builtEntry = path.join(installedRoot, "setup", "index.js");
    fs.mkdirSync(path.dirname(builtEntry), { recursive: true });
    fs.writeFileSync(builtEntry, "export default {};\n", "utf8");

    expect(
      resolveBundledChannelGeneratedPath(
        path.join(tempRoot, "logical"),
        {
          source: builtEntry,
          built: builtEntry,
        },
        "telegram",
        path.join(tempRoot, "logical", "dist", "extensions"),
        installedRoot,
      ),
    ).toBe(builtEntry);
  });

  it("keeps nested installed-dist entries scoped to their subdirectory", () => {
    // A nested entry must not collapse to a root-level basename; a stray sibling built file at the
    // plugin root should never be returned in place of the manifest's nested entry path.
    const tempRoot = createTempRoot();
    const installedRoot = path.join(tempRoot, "installed", "telegram");
    const nestedEntry = path.join(installedRoot, "setup", "index.js");
    fs.mkdirSync(path.dirname(nestedEntry), { recursive: true });
    fs.writeFileSync(nestedEntry, "export default {};\n", "utf8");
    fs.writeFileSync(path.join(installedRoot, "index.js"), "export default {};\n", "utf8");

    expect(
      resolveBundledChannelGeneratedPath(
        path.join(tempRoot, "logical"),
        {
          source: path.join(installedRoot, "setup", "index.ts"),
          built: path.join(installedRoot, "setup", "index.ts"),
        },
        "telegram",
        path.join(tempRoot, "logical", "dist", "extensions"),
        installedRoot,
      ),
    ).toBe(nestedEntry);
  });
});
