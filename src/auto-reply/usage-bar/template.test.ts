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
  it("returns undefined when unset", () => {
    expect(loadUsageBarTemplate(undefined)).toBeUndefined();
  });

  it('resolves the "default" sentinel to the built-in usable template', () => {
    const tpl = loadUsageBarTemplate("default");
    expect(tpl).toBeDefined();
    expect((tpl as { output?: unknown }).output).toBeDefined();
  });

  it("merges an inline override over the default (vocab extends, surfaces replace)", () => {
    const merged = loadUsageBarTemplate({
      scales: { mine: "ab" },
      output: { surfaces: { discord: [{ text: "X" }] } },
    }) as {
      scales: Record<string, unknown>;
      output: { surfaces: Record<string, unknown>; default?: unknown };
    };
    // added scale, and the default palette is still present
    expect(merged.scales.mine).toBe("ab");
    expect(merged.scales.braille).toBeDefined();
    // the overridden channel is replaced; the default fallback survives
    expect(merged.output.surfaces.discord).toEqual([{ text: "X" }]);
    expect(merged.output.default).toBeDefined();
  });

  it("does not mutate the shared default when merging an override", () => {
    loadUsageBarTemplate({ scales: { mine: "ab" } });
    const bare = loadUsageBarTemplate("default") as { scales: Record<string, unknown> };
    expect(bare.scales.mine).toBeUndefined();
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
