import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearUsageBarTemplateCacheForTest, loadUsageBarTemplate } from "./template.js";

// Two structurally-valid templates (isUsableTemplate accepts either an `output`
// object or a `segments` array) so we can tell which one resolved.
const tplA = { segments: [{ text: "A" }] };
const tplB = { output: { lines: [] } };

let dir: string | undefined;

afterEach(() => {
  clearUsageBarTemplateCacheForTest();
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function tmpFile(name: string, contents: string): string {
  dir = mkdtempSync(join(tmpdir(), "usage-template-"));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

describe("loadUsageBarTemplate", () => {
  it("returns an inline template object when usable", () => {
    expect(loadUsageBarTemplate(tplA as Record<string, unknown>)).toBe(tplA);
  });

  it("returns undefined for an unusable inline object or when unset", () => {
    expect(loadUsageBarTemplate({ nope: true })).toBeUndefined();
    expect(loadUsageBarTemplate(undefined)).toBeUndefined();
  });

  it("loads and parses a template file", () => {
    const path = tmpFile("t.json", JSON.stringify(tplA));
    expect(loadUsageBarTemplate(path)).toMatchObject(tplA);
  });

  it("falls back (undefined) for invalid JSON", () => {
    const path = tmpFile("bad.json", "{ not json");
    expect(loadUsageBarTemplate(path)).toBeUndefined();
  });

  it("does not cache a missing file, so a later-created template is picked up", () => {
    dir = mkdtempSync(join(tmpdir(), "usage-template-"));
    const missing = join(dir, "missing.json");
    expect(loadUsageBarTemplate(missing)).toBeUndefined();
    writeFileSync(missing, JSON.stringify(tplB));
    expect(loadUsageBarTemplate(missing)).toMatchObject(tplB);
  });

  it("serves the cached template on the hot path without re-reading the file", () => {
    const path = tmpFile("t.json", JSON.stringify(tplA));
    expect(loadUsageBarTemplate(path)).toMatchObject(tplA); // first load caches

    // Change the file on disk. The reply path must NOT re-read synchronously, so
    // the very next call still returns the cached value (the watcher refresh is
    // async and has not fired within this synchronous sequence).
    writeFileSync(path, JSON.stringify(tplB));
    expect(loadUsageBarTemplate(path)).toMatchObject(tplA);

    // After an explicit cache reset the fresh content loads.
    clearUsageBarTemplateCacheForTest();
    expect(loadUsageBarTemplate(path)).toMatchObject(tplB);
  });
});
