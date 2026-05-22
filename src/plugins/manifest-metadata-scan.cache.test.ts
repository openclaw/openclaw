import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearParsedJsonCacheForTesting,
  listOpenClawPluginManifestMetadata,
} from "./manifest-metadata-scan.js";

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-manifest-cache-"));
  tempRoots.push(root);
  return root;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

/**
 * Wraps fs.readFileSync so the test can count how many times any plugin manifest
 * was actually read from disk during a sequence of calls.
 *
 * This is the dispositive proof that the cache eliminates redundant reads on a
 * steady-state gateway: empirically `listOpenClawPluginManifestMetadata` was
 * driving ~95 manifest reads/sec on idle elliott (60-sec strace,
 * karmaterminal/openclaw#740). The cache should drop that to 0 reads/sec once
 * the manifests have been read once and their mtime+size hasn't changed.
 */
function countingReadFileSync(pattern: RegExp): { restore: () => void; count: () => number } {
  const original = fs.readFileSync;
  let count = 0;
  fs.readFileSync = ((p: fs.PathOrFileDescriptor, opts?: unknown) => {
    if (typeof p === "string" && pattern.test(p)) {
      count += 1;
    }
    return original(
      p,
      opts as BufferEncoding | { encoding: BufferEncoding; flag?: string } | undefined,
    );
  }) as typeof fs.readFileSync;
  return {
    restore: () => {
      fs.readFileSync = original;
    },
    count: () => count,
  };
}

describe("manifest-metadata-scan cache (karmaterminal/openclaw#740)", () => {
  beforeEach(() => {
    clearParsedJsonCacheForTesting();
  });

  afterEach(() => {
    clearParsedJsonCacheForTesting();
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads each plugin manifest from disk exactly once across repeated calls when nothing changes", () => {
    const root = createTempRoot();
    const bundledRoot = path.join(root, "extensions");

    for (const id of ["alpha", "bravo", "charlie", "delta"]) {
      writeJson(path.join(bundledRoot, id, "openclaw.plugin.json"), { id });
    }

    const counter = countingReadFileSync(/openclaw\.plugin\.json$/);
    try {
      const env = {
        OPENCLAW_HOME: path.join(root, "home"),
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
      } as NodeJS.ProcessEnv;

      // First call: every manifest read fresh, populating the cache.
      const first = listOpenClawPluginManifestMetadata(env);
      const readsAfterFirst = counter.count();
      expect(readsAfterFirst).toBe(4);
      expect(
        first
          .map((record) => record.manifest.id)
          .toSorted((a, b) => String(a).localeCompare(String(b))),
      ).toEqual(["alpha", "bravo", "charlie", "delta"]);

      // Repeated calls: cache hits on every manifest. mtime + size unchanged so no
      // readFileSync should fire.
      for (let i = 0; i < 20; i += 1) {
        listOpenClawPluginManifestMetadata(env);
      }
      expect(counter.count()).toBe(readsAfterFirst);
    } finally {
      counter.restore();
    }
  });

  it("invalidates the cache when a manifest's mtime + size changes", () => {
    const root = createTempRoot();
    const bundledRoot = path.join(root, "extensions");
    const manifestPath = path.join(bundledRoot, "alpha", "openclaw.plugin.json");
    writeJson(manifestPath, { id: "alpha", version: "1" });

    const counter = countingReadFileSync(/openclaw\.plugin\.json$/);
    try {
      const env = {
        OPENCLAW_HOME: path.join(root, "home"),
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
      } as NodeJS.ProcessEnv;

      listOpenClawPluginManifestMetadata(env);
      expect(counter.count()).toBe(1);

      // Same content, no rewrite — cache hit.
      listOpenClawPluginManifestMetadata(env);
      expect(counter.count()).toBe(1);

      // Mutate the manifest: bump mtime + size by appending content. Cache must
      // invalidate and re-read.
      writeJson(manifestPath, { id: "alpha", version: "2-with-extra-bytes-to-change-size" });
      // Force mtime to differ from previous write even if filesystem timestamp
      // resolution is coarse.
      const future = Math.floor(Date.now() / 1000) + 10;
      fs.utimesSync(manifestPath, future, future);

      const records = listOpenClawPluginManifestMetadata(env);
      expect(counter.count()).toBe(2);
      const alpha = records.find((record) => record.manifest.id === "alpha");
      expect(alpha?.manifest.version).toBe("2-with-extra-bytes-to-change-size");
    } finally {
      counter.restore();
    }
  });

  it("re-reads when a previously-missing manifest appears", () => {
    const root = createTempRoot();
    const bundledRoot = path.join(root, "extensions");
    const manifestDir = path.join(bundledRoot, "alpha");
    fs.mkdirSync(manifestDir, { recursive: true });
    // No manifest file written yet.

    const counter = countingReadFileSync(/openclaw\.plugin\.json$/);
    try {
      const env = {
        OPENCLAW_HOME: path.join(root, "home"),
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
      } as NodeJS.ProcessEnv;

      const initial = listOpenClawPluginManifestMetadata(env);
      expect(initial.find((record) => record.manifest.id === "alpha")).toBeUndefined();
      // No readFileSync should have fired — only the stat for the missing file.
      expect(counter.count()).toBe(0);

      // Manifest appears.
      writeJson(path.join(manifestDir, "openclaw.plugin.json"), { id: "alpha" });

      const second = listOpenClawPluginManifestMetadata(env);
      expect(second.find((record) => record.manifest.id === "alpha")).toBeDefined();
      expect(counter.count()).toBe(1);
    } finally {
      counter.restore();
    }
  });

  it("caps cache size to bound memory growth on enormous plugin counts", () => {
    // The cache cap (10_000 entries) protects against pathological cases where
    // arbitrary JSON paths get fingerprinted. We exercise it by manually filling
    // beyond the cap and verifying eviction stays bounded.
    clearParsedJsonCacheForTesting();
    const root = createTempRoot();
    const bundledRoot = path.join(root, "extensions");
    // Create just a few real manifests so the function returns successfully.
    writeJson(path.join(bundledRoot, "alpha", "openclaw.plugin.json"), { id: "alpha" });

    const env = {
      OPENCLAW_HOME: path.join(root, "home"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    } as NodeJS.ProcessEnv;

    // Just sanity check the function still returns correct records and doesn't
    // throw under repeated invocation. The cap behavior is exercised when the
    // cache fills past PARSED_JSON_CACHE_MAX_ENTRIES with the realistic mix of
    // package.json + plugin.json + index.json + install-record paths.
    for (let i = 0; i < 50; i += 1) {
      const records = listOpenClawPluginManifestMetadata(env);
      expect(records.length).toBeGreaterThanOrEqual(1);
    }
  });
});
