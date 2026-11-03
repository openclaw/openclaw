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
  it("carries up to three author-written prompts through third-party cold discovery unchanged", () => {
    const prompts = [
      "  Plan  my week\nwith priorities.  ",
      "Compare my options.",
      "x".repeat(4096),
    ];
    const candidate = fixture(prompts);
    const registry = loadPluginManifestRegistryCore({
      installRecords: {},
      candidates: [candidate],
    });
    expect(registry.plugins[0]?.recommendedPrompts).toEqual([
      "Plan  my week\nwith priorities.",
      "Compare my options.",
      "x".repeat(4096),
    ]);
    expect(registry.diagnostics).toEqual([]);
  });

  it.each([{ prompts: undefined }, { prompts: [] }])(
    "accepts absent or empty optional metadata: $prompts",
    ({ prompts }) => {
      const result = loadPluginManifest(fixture(prompts).rootDir, false);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.manifest.recommendedPrompts).toEqual(prompts);
      }
    },
  );

  it.each([
    { prompts: null },
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
    expect(registry.plugins).toEqual([
      expect.objectContaining({ id: candidate.idHint, recommendedPrompts: undefined }),
    ]);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("ignoring invalid plugin manifest recommendedPrompts"),
      }),
    );
    expect(registry.diagnostics.some((diagnostic) => diagnostic.level === "error")).toBe(false);
  });
});
