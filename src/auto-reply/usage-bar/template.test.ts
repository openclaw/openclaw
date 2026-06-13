import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_USAGE_BAR_TEMPLATE } from "./default-template.js";
import { clearUsageBarTemplateCacheForTest, loadUsageBarTemplate } from "./template.js";

const tplA = { segments: [{ text: "A" }] };
const tplB = { output: { default: [{ text: "B" }] } };

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
  it("returns the built-in template when unset", () => {
    expect(loadUsageBarTemplate(undefined)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
  });

  it("returns an inline template object when usable", () => {
    expect(loadUsageBarTemplate(tplA)).toBe(tplA);
  });

  it("falls back to the built-in template for an unusable inline object", () => {
    expect(loadUsageBarTemplate({ nope: true })).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
  });

  it("loads and parses a template file", () => {
    const path = tmpFile("t.json", JSON.stringify(tplA));
    expect(loadUsageBarTemplate(path)).toMatchObject(tplA);
  });

  it("falls back to the built-in template for invalid JSON", () => {
    const path = tmpFile("bad.json", "{ not json");
    expect(loadUsageBarTemplate(path)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
  });

  it("reloads a path after an initial miss", () => {
    dir = mkdtempSync(join(tmpdir(), "usage-template-"));
    const missing = join(dir, "missing.json");
    expect(loadUsageBarTemplate(missing)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
    writeFileSync(missing, JSON.stringify(tplB));
    expect(loadUsageBarTemplate(missing)).toMatchObject(tplB);
  });

  it("reloads a path after invalid JSON is fixed", () => {
    const path = tmpFile("bad.json", "{ not json");
    expect(loadUsageBarTemplate(path)).toBe(DEFAULT_USAGE_BAR_TEMPLATE);
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
