import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, test, beforeEach, afterEach } from "vitest";
import { buildTypeDefinitionsPrompt, loadTypeDefinitions } from "./type-definitions.js";

describe("type-definitions", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "type-defs-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("loadTypeDefinitions - finds src/types directory", async () => {
    const typesDir = path.join(tempDir, "src", "types");
    await fs.mkdir(typesDir, { recursive: true });
    await fs.writeFile(
      path.join(typesDir, "index.ts"),
      "export type User = { id: string; name: string; };\n",
    );
    await fs.writeFile(
      path.join(typesDir, "models.ts"),
      "export interface Post { title: string; content: string; }\n",
    );

    const result = await loadTypeDefinitions({ workspaceDir: tempDir });

    assert.equal(result.exists, true);
    assert.equal(result.typesDir, "src/types");
    assert.equal(result.files.length, 2);
    // index.ts should be first
    assert.equal(path.basename(result.files[0].relativePath), "index.ts");
    assert.ok(result.files[0].content.includes("User"));
  });

  test("loadTypeDefinitions - falls back to types directory", async () => {
    const typesDir = path.join(tempDir, "types");
    await fs.mkdir(typesDir, { recursive: true });
    await fs.writeFile(
      path.join(typesDir, "config.ts"),
      "export type Config = { apiKey: string; };\n",
    );

    const result = await loadTypeDefinitions({ workspaceDir: tempDir });

    assert.equal(result.exists, true);
    assert.equal(result.typesDir, "types");
    assert.equal(result.files.length, 1);
    assert.ok(result.files[0].content.includes("Config"));
  });

  test("loadTypeDefinitions - skips test files", async () => {
    const typesDir = path.join(tempDir, "src", "types");
    await fs.mkdir(typesDir, { recursive: true });
    await fs.writeFile(path.join(typesDir, "user.ts"), "export type User = {};\n");
    await fs.writeFile(path.join(typesDir, "user.test.ts"), 'test("user", () => {});\n');
    await fs.writeFile(path.join(typesDir, "user.spec.ts"), 'describe("user", () => {});\n');

    const result = await loadTypeDefinitions({ workspaceDir: tempDir });

    assert.equal(result.files.length, 1);
    assert.equal(path.basename(result.files[0].relativePath), "user.ts");
  });

  test("loadTypeDefinitions - returns empty when no types directory exists", async () => {
    const result = await loadTypeDefinitions({ workspaceDir: tempDir });

    assert.equal(result.exists, false);
    assert.equal(result.files.length, 0);
  });

  test("loadTypeDefinitions - respects size limits", async () => {
    const typesDir = path.join(tempDir, "src", "types");
    await fs.mkdir(typesDir, { recursive: true });
    const largeContent = "export type Large = {\n" + "  field: string;\n".repeat(10000) + "};\n";
    await fs.writeFile(path.join(typesDir, "large.ts"), largeContent);
    await fs.writeFile(path.join(typesDir, "small.ts"), "export type Small = {};\n");

    const result = await loadTypeDefinitions({
      workspaceDir: tempDir,
      maxFileBytes: 100, // Very small limit
      maxTotalBytes: 200,
    });

    // Should skip the large file but include the small one
    assert.equal(result.files.length, 1);
    assert.equal(path.basename(result.files[0].relativePath), "small.ts");
  });

  test("buildTypeDefinitionsPrompt - creates formatted prompt", async () => {
    const typesDir = path.join(tempDir, "src", "types");
    await fs.mkdir(typesDir, { recursive: true });
    await fs.writeFile(path.join(typesDir, "index.ts"), "export type User = { id: string; };\n");

    const result = await loadTypeDefinitions({ workspaceDir: tempDir });
    const prompt = buildTypeDefinitionsPrompt(result);

    assert.ok(prompt.includes("# Type Definitions"));
    assert.ok(prompt.includes("**CRITICAL:** Use ONLY the types defined below"));
    assert.ok(prompt.includes("## src/types/index.ts"));
    assert.ok(prompt.includes("```typescript"));
    assert.ok(prompt.includes("export type User"));
  });

  test("buildTypeDefinitionsPrompt - returns empty string when no types", () => {
    const result = {
      files: [],
      totalSize: 0,
      exists: false,
    };

    const prompt = buildTypeDefinitionsPrompt(result);

    assert.equal(prompt, "");
  });

  test("loadTypeDefinitions - handles nested directories", async () => {
    const typesDir = path.join(tempDir, "src", "types");
    const nestedDir = path.join(typesDir, "models");
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(path.join(typesDir, "index.ts"), 'export * from "./models";\n');
    await fs.writeFile(path.join(nestedDir, "user.ts"), "export type User = {};\n");

    const result = await loadTypeDefinitions({ workspaceDir: tempDir });

    assert.equal(result.files.length, 2);
    const paths = result.files.map((f) => f.relativePath);
    assert.ok(paths.some((p) => p.includes("models/user.ts")));
  });
});
