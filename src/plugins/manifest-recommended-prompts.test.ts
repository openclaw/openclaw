import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { loadPluginManifest } from "./manifest.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];
afterEach(() => cleanupTrackedTempDirs(tempDirs));

function fixture(recommendedPrompts?: unknown) {
  const rootDir = makeTrackedTempDir("openclaw-manifest-prompts", tempDirs);
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({ id: "community-planner", configSchema: {}, recommendedPrompts }),
  );
  // Cold metadata discovery must never execute a plugin entrypoint.
  const source = path.join(rootDir, "index.js");
  fs.writeFileSync(source, 'throw new Error("plugin runtime must not load");');
  return { rootDir, source, idHint: "community-planner", origin: "global" as const };
}

describe("manifest recommended prompts", () => {
  it("loads authored Knowledge starters through native manifest normalization", () => {
    const result = loadPluginManifest(path.resolve("extensions/knowledge"), false);
    expect(result.ok && result.manifest.recommendedPrompts?.length).toBe(3);
  });
  it("normalizes three short prompts through third-party cold discovery", () => {
    const spacedPrompt = `${" ".repeat(128)}Plan  my week\nwith priorities.  `;
    const candidate = fixture([spacedPrompt, "Compare my options.", "😀".repeat(128)]);
    const registry = loadPluginManifestRegistryCore({
      installRecords: {},
      candidates: [candidate],
    });
    expect(registry.plugins[0]?.recommendedPrompts).toEqual([
      "Plan my week with priorities.",
      "Compare my options.",
      "😀".repeat(128),
    ]);
    expect(registry.diagnostics).toEqual([]);
  });
  it.each([{ prompts: undefined }, { prompts: [] }])(
    "accepts absent or empty optional metadata: $prompts",
    ({ prompts }) => {
      const result = loadPluginManifest(fixture(prompts).rootDir, false);
      if (!result.ok) {
        throw new Error(result.error);
      }
      expect(result.manifest.recommendedPrompts).toEqual(prompts);
    },
  );
  it.each([
    { prompts: null },
    { prompts: ["Valid", "x".repeat(129)] },
    { prompts: ["Valid", "😀".repeat(129)] },
    { prompts: "Plan my week." },
    { prompts: [""] },
    { prompts: [" \n "] },
    { prompts: ["Valid", 1] },
    { prompts: ["one", "two", "three", "four"] },
  ])("ignores invalid optional metadata as a whole, with a diagnostic: $prompts", ({ prompts }) => {
    const candidate = fixture(prompts);
    const registry = loadPluginManifestRegistryCore({
      installRecords: {},
      candidates: [candidate],
    });
    expect(registry.plugins.map(({ id, recommendedPrompts }) => [id, recommendedPrompts])).toEqual([
      [candidate.idHint, undefined],
    ]);
    const warning = expect.stringContaining("ignoring invalid plugin manifest recommendedPrompts");
    expect(registry.diagnostics.map(({ level, message }) => [level, message])).toEqual([
      ["warn", warning],
    ]);
  });
});
