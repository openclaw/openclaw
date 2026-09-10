// Verifies package-owned catalog categories at the native plugin manifest boundary.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginManifest } from "./manifest.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

function loadWithCategories(categories?: unknown) {
  const rootDir = makeTrackedTempDir("openclaw-manifest-categories", tempDirs);
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "catalog-test",
      ...(categories === undefined ? {} : { categories }),
      configSchema: { type: "object", additionalProperties: false },
    }),
  );
  return loadPluginManifest(rootDir, false);
}

describe("plugin manifest categories", () => {
  it("preserves one to three unique categories in declaration order", () => {
    expect(loadWithCategories(["web", "tools", "runtime"])).toMatchObject({
      ok: true,
      manifest: { categories: ["web", "tools", "runtime"] },
    });
  });

  it("allows packages to omit categories", () => {
    const result = loadWithCategories();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest).not.toHaveProperty("categories");
    }
  });

  it.each([
    { categories: [], reason: "must contain between 1 and 3 entries" },
    {
      categories: ["web", "tools", "runtime", "other"],
      reason: "must contain between 1 and 3 entries",
    },
    { categories: ["web", "web"], reason: "must not contain duplicates" },
    { categories: ["web", "unknown"], reason: 'contains unknown category "unknown"' },
    { categories: [" web "], reason: 'contains unknown category " web "' },
    { categories: "web", reason: "must be an array" },
  ])("rejects invalid categories: $reason", ({ categories, reason }) => {
    expect(loadWithCategories(categories)).toMatchObject({
      ok: false,
      error: `invalid plugin manifest categories: ${reason}`,
    });
  });
});
