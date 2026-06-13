import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearUsageBarTemplateCacheForTest, loadUsageBarTemplate } from "./template.js";

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

  it('resolves the "default" sentinel to the built-in usable template', () => {
    const tpl = loadUsageBarTemplate("default");
    expect(tpl).toBeDefined();
    expect((tpl as { output?: unknown }).output).toBeDefined();
  });

  it("loads and parses a template file", () => {
    const path = tmpFile("t.json", JSON.stringify(tplA));
    expect(loadUsageBarTemplate(path)).toMatchObject(tplA);
  });

  it("falls back (undefined) for invalid JSON", () => {
    const path = tmpFile("bad.json", "{ not json");
    expect(loadUsageBarTemplate(path)).toBeUndefined();
  });

  it("reloads a path after an initial miss", () => {
    dir = mkdtempSync(join(tmpdir(), "usage-template-"));
    const missing = join(dir, "missing.json");
    expect(loadUsageBarTemplate(missing)).toBeUndefined();
    writeFileSync(missing, JSON.stringify(tplB));
    expect(loadUsageBarTemplate(missing)).toMatchObject(tplB);
  });

  it("reloads a path after invalid JSON is fixed", () => {
    const path = tmpFile("bad.json", "{ not json");
    expect(loadUsageBarTemplate(path)).toBeUndefined();
    writeFileSync(path, JSON.stringify(tplB));
    expect(loadUsageBarTemplate(path)).toMatchObject(tplB);
  });

  it("serves the cached template without re-reading the file", () => {
    const path = tmpFile("t.json", JSON.stringify(tplA));
    expect(loadUsageBarTemplate(path)).toMatchObject(tplA);

    writeFileSync(path, JSON.stringify(tplB));
    expect(loadUsageBarTemplate(path)).toMatchObject(tplA);

    clearUsageBarTemplateCacheForTest();
    expect(loadUsageBarTemplate(path)).toMatchObject(tplB);
  });
});
