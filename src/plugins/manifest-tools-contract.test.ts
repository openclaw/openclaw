import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginManifest } from "./manifest.js";

describe("manifest contracts.tools normalization (issue #80621)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "openclaw-manifest-tools-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeManifest = (contractsTools: unknown): void => {
    const manifest = {
      id: "my-plugin",
      name: "My Plugin",
      entry: "./dist/index.js",
      configSchema: { type: "object", properties: {} },
      contracts: { tools: contractsTools },
    };
    writeFileSync(join(dir, "openclaw.plugin.json"), JSON.stringify(manifest));
  };

  it("accepts contracts.tools: true as a wildcard ['*']", () => {
    writeManifest(true);
    const result = loadPluginManifest(dir, false);
    if (!result.ok) throw new Error(result.error);
    expect(result.manifest.contracts?.tools).toEqual(["*"]);
  });

  it("preserves contracts.tools: string[] as the declared list", () => {
    writeManifest(["alpha", "beta"]);
    const result = loadPluginManifest(dir, false);
    if (!result.ok) throw new Error(result.error);
    expect(result.manifest.contracts?.tools).toEqual(["alpha", "beta"]);
  });

  it.each<{ label: string; value: unknown }>([
    { label: "false", value: false },
    { label: "null", value: null },
    { label: "the number 1 (not boolean true)", value: 1 },
    { label: 'the string "true" (not boolean true)', value: "true" },
    { label: "an empty array", value: [] },
  ])("treats $label as an absent contracts.tools", ({ value }) => {
    writeManifest(value);
    const result = loadPluginManifest(dir, false);
    if (!result.ok) throw new Error(result.error);
    expect(result.manifest.contracts?.tools).toBeUndefined();
  });
});
