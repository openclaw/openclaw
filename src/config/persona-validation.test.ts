/**
 * Persona template validation tests.
 *
 * Validates all persona .md files in agents/personas/ against
 * PersonaFrontmatterSchema and checks _index.json is up-to-date.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test, expect } from "vitest";
import { parse as parseYaml } from "yaml";
import { PersonaFrontmatterSchema, PersonaIndexSchema } from "./zod-schema.persona.js";

const PERSONAS_DIR = join(import.meta.dirname, "..", "..", "agents", "personas");
const INDEX_PATH = join(PERSONAS_DIR, "_index.json");
const FRONTMATTER_SPLIT_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;

async function loadAllPersonaSlugs(): Promise<string[]> {
  const slugs: string[] = [];
  const categoryDirs = await readdir(PERSONAS_DIR, { withFileTypes: true });
  for (const entry of categoryDirs.filter((e) => e.isDirectory())) {
    const files = await readdir(join(PERSONAS_DIR, entry.name));
    for (const file of files.filter((f) => f.endsWith(".md"))) {
      const content = await readFile(join(PERSONAS_DIR, entry.name, file), "utf-8");
      const match = FRONTMATTER_SPLIT_RE.exec(content);
      if (match) {
        const parsed = parseYaml(match[1]);
        if (parsed?.slug) {
          slugs.push(parsed.slug);
        }
      }
    }
  }
  return slugs.toSorted();
}

describe("Persona template validation", () => {
  test("all persona files pass PersonaFrontmatterSchema validation", async () => {
    const categoryDirs = await readdir(PERSONAS_DIR, { withFileTypes: true });
    let total = 0;

    for (const entry of categoryDirs.filter((e) => e.isDirectory())) {
      const categoryDir = join(PERSONAS_DIR, entry.name);
      const files = await readdir(categoryDir);
      for (const file of files.filter((f) => f.endsWith(".md"))) {
        total++;
        const content = await readFile(join(categoryDir, file), "utf-8");
        const match = FRONTMATTER_SPLIT_RE.exec(content);
        expect(match, `${entry.name}/${file}: missing frontmatter delimiters`).toBeTruthy();

        const parsed = parseYaml(match![1]);
        const result = PersonaFrontmatterSchema.safeParse(parsed);
        if (!result.success) {
          const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
          expect.fail(`${entry.name}/${file}: ${issues.join(", ")}`);
        }
      }
    }

    expect(total).toBeGreaterThanOrEqual(143);
  });

  test("all persona slugs are unique", async () => {
    const slugs = await loadAllPersonaSlugs();
    const unique = new Set(slugs);
    const duplicates = slugs.filter((s) => {
      if (unique.has(s)) {
        unique.delete(s);
        return false;
      }
      return true;
    });
    expect(duplicates, `Duplicate slugs: ${duplicates.join(", ")}`).toHaveLength(0);
  });

  test("all personas have required body sections", async () => {
    const categoryDirs = await readdir(PERSONAS_DIR, { withFileTypes: true });
    const requiredSections = ["## Identity", "## Core Mission", "## Critical Rules"];

    for (const entry of categoryDirs.filter((e) => e.isDirectory())) {
      const files = await readdir(join(PERSONAS_DIR, entry.name));
      for (const file of files.filter((f) => f.endsWith(".md"))) {
        const content = await readFile(join(PERSONAS_DIR, entry.name, file), "utf-8");
        const match = FRONTMATTER_SPLIT_RE.exec(content);
        if (!match) {
          continue;
        }
        const body = match[2];
        for (const section of requiredSections) {
          expect(
            body.includes(section),
            `${entry.name}/${file}: missing required section "${section}"`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("Persona _index.json validation", () => {
  test("_index.json exists and is valid", async () => {
    const content = await readFile(INDEX_PATH, "utf-8");
    const parsed = JSON.parse(content);
    const result = PersonaIndexSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      expect.fail(`_index.json validation errors: ${issues.join(", ")}`);
    }
  });

  test("_index.json is up-to-date with persona files on disk", async () => {
    const diskSlugs = await loadAllPersonaSlugs();
    const content = await readFile(INDEX_PATH, "utf-8");
    const index = JSON.parse(content);
    const indexSlugs = (index.personas as Array<{ slug: string }>).map((p) => p.slug).toSorted();

    expect(indexSlugs).toEqual(diskSlugs);
  });

  test("_index.json category counts match disk", async () => {
    const content = await readFile(INDEX_PATH, "utf-8");
    const index = JSON.parse(content);
    const categoryCounts = new Map<string, number>();

    const categoryDirs = await readdir(PERSONAS_DIR, { withFileTypes: true });
    for (const entry of categoryDirs.filter((e) => e.isDirectory())) {
      const files = await readdir(join(PERSONAS_DIR, entry.name));
      const mdCount = files.filter((f) => f.endsWith(".md")).length;
      if (mdCount > 0) {
        categoryCounts.set(entry.name, mdCount);
      }
    }

    for (const cat of index.categories as Array<{ slug: string; count: number }>) {
      expect(cat.count, `${cat.slug} count mismatch`).toBe(categoryCounts.get(cat.slug) ?? 0);
    }
  });
});
