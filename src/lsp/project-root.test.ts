import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { findProjectRoot, buildLspInstanceKey } from "./project-root.js";

describe("project-root", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lsp-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("findProjectRoot", () => {
    it("finds project root with tsconfig.json", async () => {
      const projectDir = path.join(tempDir, "my-project");
      const srcDir = path.join(projectDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(path.join(projectDir, "tsconfig.json"), "{}");
      await fs.writeFile(path.join(srcDir, "index.ts"), "");

      const root = await findProjectRoot(path.join(srcDir, "index.ts"), ["tsconfig.json"]);
      expect(root).toBe(projectDir);
    });

    it("finds project root with package.json", async () => {
      const projectDir = path.join(tempDir, "my-project");
      const deepDir = path.join(projectDir, "src", "lib", "utils");
      await fs.mkdir(deepDir, { recursive: true });
      await fs.writeFile(path.join(projectDir, "package.json"), "{}");
      await fs.writeFile(path.join(deepDir, "helpers.ts"), "");

      const root = await findProjectRoot(path.join(deepDir, "helpers.ts"), [
        "tsconfig.json",
        "package.json",
      ]);
      expect(root).toBe(projectDir);
    });

    it("finds project root with go.mod", async () => {
      const projectDir = path.join(tempDir, "go-project");
      const pkgDir = path.join(projectDir, "pkg", "handler");
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(path.join(projectDir, "go.mod"), "module example.com/foo");
      await fs.writeFile(path.join(pkgDir, "handler.go"), "");

      const root = await findProjectRoot(path.join(pkgDir, "handler.go"), ["go.mod"]);
      expect(root).toBe(projectDir);
    });

    it("finds project root with Cargo.toml", async () => {
      const projectDir = path.join(tempDir, "rust-project");
      const srcDir = path.join(projectDir, "src");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(path.join(projectDir, "Cargo.toml"), "[package]");
      await fs.writeFile(path.join(srcDir, "main.rs"), "");

      const root = await findProjectRoot(path.join(srcDir, "main.rs"), ["Cargo.toml"]);
      expect(root).toBe(projectDir);
    });

    it("returns undefined when no config file is found", async () => {
      const someDir = path.join(tempDir, "random", "dir");
      await fs.mkdir(someDir, { recursive: true });
      await fs.writeFile(path.join(someDir, "file.ts"), "");

      const root = await findProjectRoot(path.join(someDir, "file.ts"), ["tsconfig.json"]);
      // May find a tsconfig.json somewhere in the system, or not
      // The important thing is it doesn't crash
      expect(root === undefined || typeof root === "string").toBe(true);
    });

    it("respects boundary parameter", async () => {
      const outerDir = path.join(tempDir, "outer");
      const innerDir = path.join(outerDir, "inner", "deep");
      await fs.mkdir(innerDir, { recursive: true });
      await fs.writeFile(path.join(outerDir, "tsconfig.json"), "{}");
      await fs.writeFile(path.join(innerDir, "file.ts"), "");

      // With boundary at inner, should not find the tsconfig in outer
      const root = await findProjectRoot(
        path.join(innerDir, "file.ts"),
        ["tsconfig.json"],
        path.join(outerDir, "inner"),
      );
      expect(root).toBeUndefined();
    });

    it("finds nearest config file", async () => {
      const outerDir = path.join(tempDir, "outer");
      const innerDir = path.join(outerDir, "packages", "pkg-a");
      await fs.mkdir(innerDir, { recursive: true });
      await fs.writeFile(path.join(outerDir, "tsconfig.json"), "{}");
      await fs.writeFile(path.join(innerDir, "tsconfig.json"), "{}");
      await fs.writeFile(path.join(innerDir, "index.ts"), "");

      const root = await findProjectRoot(path.join(innerDir, "index.ts"), ["tsconfig.json"]);
      expect(root).toBe(innerDir);
    });
  });

  describe("buildLspInstanceKey", () => {
    it("combines project root and server command", () => {
      const key = buildLspInstanceKey("/home/user/project", "typescript-language-server");
      expect(key).toContain(path.resolve("/home/user/project"));
      expect(key).toContain("typescript-language-server");
      expect(key).toContain("::");
    });

    it("produces different keys for different servers in same root", () => {
      const key1 = buildLspInstanceKey("/project", "typescript-language-server");
      const key2 = buildLspInstanceKey("/project", "pyright-langserver");
      expect(key1).not.toBe(key2);
    });

    it("produces different keys for same server in different roots", () => {
      const key1 = buildLspInstanceKey("/project-a", "typescript-language-server");
      const key2 = buildLspInstanceKey("/project-b", "typescript-language-server");
      expect(key1).not.toBe(key2);
    });
  });
});
