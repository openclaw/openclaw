import { describe, expect, it } from "vitest";
import {
  CODE_EXTENSIONS,
  chunkCode,
  detectCodeLanguage,
  type CodeLanguage,
} from "./internal.js";

const CHUNKING = { tokens: 400, overlap: 80 };

describe("detectCodeLanguage", () => {
  it("returns the correct language for TypeScript extensions", () => {
    for (const ext of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
      expect(detectCodeLanguage(`file${ext}`)).toBe("typescript");
    }
  });

  it("returns python for .py", () => {
    expect(detectCodeLanguage("utils.py")).toBe("python");
  });

  it("returns go for .go", () => {
    expect(detectCodeLanguage("main.go")).toBe("go");
  });

  it("returns rust for .rs", () => {
    expect(detectCodeLanguage("lib.rs")).toBe("rust");
  });

  it("returns generic for other code extensions", () => {
    for (const ext of [".rb", ".java", ".kt", ".cs", ".swift", ".cpp", ".c"]) {
      expect(detectCodeLanguage(`file${ext}`)).toBe("generic");
    }
  });

  it("returns null for non-code files", () => {
    expect(detectCodeLanguage("README.md")).toBeNull();
    expect(detectCodeLanguage("data.json")).toBeNull();
    expect(detectCodeLanguage("style.css")).toBeNull();
    expect(detectCodeLanguage("image.png")).toBeNull();
  });

  it("is case-insensitive for extension matching", () => {
    expect(detectCodeLanguage("file.TS")).toBe("typescript");
    expect(detectCodeLanguage("file.PY")).toBe("python");
  });
});

describe("CODE_EXTENSIONS", () => {
  it("contains entries for all supported languages", () => {
    const langs = new Set(Object.values(CODE_EXTENSIONS));
    expect(langs).toContain("typescript");
    expect(langs).toContain("python");
    expect(langs).toContain("go");
    expect(langs).toContain("rust");
    expect(langs).toContain("generic");
  });
});

describe("chunkCode", () => {
  describe("TypeScript chunking", () => {
    const LANG: CodeLanguage = "typescript";

    it("splits at top-level function declarations", () => {
      const code = [
        "import { foo } from './foo.js';",
        "",
        "function greet(name: string): string {",
        "  return `Hello, ${name}!`;",
        "}",
        "",
        "function farewell(name: string): string {",
        "  return `Goodbye, ${name}!`;",
        "}",
      ].join("\n");

      const chunks = chunkCode(code, LANG, CHUNKING);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      // One chunk should contain the greet function
      expect(chunks.some((c) => c.text.includes("function greet"))).toBe(true);
      // One chunk should contain the farewell function
      expect(chunks.some((c) => c.text.includes("function farewell"))).toBe(true);
    });

    it("splits at class declarations", () => {
      const code = [
        "class Foo {",
        "  bar(): void {}",
        "}",
        "",
        "class Baz {",
        "  qux(): void {}",
        "}",
      ].join("\n");

      const chunks = chunkCode(code, LANG, CHUNKING);
      expect(chunks.some((c) => c.text.includes("class Foo"))).toBe(true);
      expect(chunks.some((c) => c.text.includes("class Baz"))).toBe(true);
    });

    it("splits at export declarations", () => {
      const code = [
        "export function alpha(): void {}",
        "",
        "export const beta = (): void => {};",
        "",
        "export interface Gamma {",
        "  delta: string;",
        "}",
      ].join("\n");

      const chunks = chunkCode(code, LANG, CHUNKING);
      expect(chunks.some((c) => c.text.includes("alpha"))).toBe(true);
      expect(chunks.some((c) => c.text.includes("beta"))).toBe(true);
      expect(chunks.some((c) => c.text.includes("Gamma"))).toBe(true);
    });

    it("includes leading JSDoc comment with the following declaration", () => {
      const code = [
        "/**",
        " * Greets a user.",
        " */",
        "function greet(name: string): string {",
        "  return `Hello, ${name}`;",
        "}",
      ].join("\n");

      const chunks = chunkCode(code, LANG, CHUNKING);
      // The comment and function should be in the same chunk
      const chunk = chunks.find((c) => c.text.includes("function greet"));
      expect(chunk).toBeDefined();
      expect(chunk?.text).toContain("Greets a user");
    });
  });

  describe("Python chunking", () => {
    const LANG: CodeLanguage = "python";

    it("splits at top-level def and class statements", () => {
      const code = [
        "import os",
        "",
        "def greet(name: str) -> str:",
        "    return f'Hello, {name}'",
        "",
        "class Foo:",
        "    def bar(self) -> None:",
        "        pass",
      ].join("\n");

      const chunks = chunkCode(code, LANG, CHUNKING);
      expect(chunks.some((c) => c.text.includes("def greet"))).toBe(true);
      expect(chunks.some((c) => c.text.includes("class Foo"))).toBe(true);
    });

    it("includes decorators with the following function", () => {
      const code = [
        "@staticmethod",
        "def helper() -> None:",
        "    pass",
        "",
        "def other() -> None:",
        "    pass",
      ].join("\n");

      const chunks = chunkCode(code, LANG, CHUNKING);
      const helperChunk = chunks.find((c) => c.text.includes("def helper"));
      expect(helperChunk?.text).toContain("@staticmethod");
    });
  });

  describe("Go chunking", () => {
    const LANG: CodeLanguage = "go";

    it("splits at func declarations", () => {
      const code = [
        "package main",
        "",
        "func Hello() string {",
        '  return "hello"',
        "}",
        "",
        "func Goodbye() string {",
        '  return "goodbye"',
        "}",
      ].join("\n");

      const chunks = chunkCode(code, LANG, CHUNKING);
      expect(chunks.some((c) => c.text.includes("func Hello"))).toBe(true);
      expect(chunks.some((c) => c.text.includes("func Goodbye"))).toBe(true);
    });
  });

  describe("Rust chunking", () => {
    const LANG: CodeLanguage = "rust";

    it("splits at fn and impl declarations", () => {
      const code = [
        "use std::fmt;",
        "",
        "pub fn greet(name: &str) -> String {",
        '  format!("Hello, {}!", name)',
        "}",
        "",
        "pub struct Greeter {",
        "  prefix: String,",
        "}",
        "",
        "impl Greeter {",
        "  pub fn new(prefix: &str) -> Self {",
        "    Self { prefix: prefix.to_string() }",
        "  }",
        "}",
      ].join("\n");

      const chunks = chunkCode(code, LANG, CHUNKING);
      expect(chunks.some((c) => c.text.includes("pub fn greet"))).toBe(true);
      expect(chunks.some((c) => c.text.includes("pub struct Greeter"))).toBe(true);
      expect(chunks.some((c) => c.text.includes("impl Greeter"))).toBe(true);
    });
  });

  describe("line number accuracy", () => {
    it("reports correct 1-indexed startLine and endLine", () => {
      const code = [
        "function alpha() {}", // line 1
        "",
        "function beta() {}", // line 3
        "",
        "function gamma() {}", // line 5
      ].join("\n");

      const chunks = chunkCode(code, "typescript", CHUNKING);
      const alphaChunk = chunks.find((c) => c.text.includes("function alpha"));
      const betaChunk = chunks.find((c) => c.text.includes("function beta"));
      const gammaChunk = chunks.find((c) => c.text.includes("function gamma"));

      expect(alphaChunk?.startLine).toBe(1);
      expect(betaChunk?.startLine).toBe(3);
      expect(gammaChunk?.startLine).toBe(5);
    });
  });

  describe("fallback behaviour", () => {
    it("falls back to sliding-window when no declarations are detected", () => {
      // A file with no top-level declarations (e.g. data/config file with .ts extension)
      const code = ["// just a comment", "const x = 1;", "const y = 2;"].join("\n");

      // Should still return chunks (from chunkMarkdown fallback)
      const chunks = chunkCode(code, "generic", CHUNKING);
      expect(chunks.length).toBeGreaterThan(0);
    });

    it("handles empty content", () => {
      expect(chunkCode("", "typescript", CHUNKING)).toHaveLength(0);
    });

    it("handles content with only whitespace", () => {
      const chunks = chunkCode("   \n\n  \n", "typescript", CHUNKING);
      expect(chunks.filter((c) => c.text.trim().length > 0)).toHaveLength(0);
    });
  });

  describe("oversized unit splitting", () => {
    it("splits an oversized unit using sliding-window and remaps line numbers", () => {
      // Create a single large function that exceeds maxChars (tokens=10 → maxChars=40)
      const tinyChunking = { tokens: 10, overlap: 0 };
      const bigBody = Array.from({ length: 20 }, (_, i) => `  const v${i} = ${i};`);
      const code = ["function big() {", ...bigBody, "}"].join("\n");

      const chunks = chunkCode(code, "typescript", tinyChunking);
      expect(chunks.length).toBeGreaterThan(1);
      // All chunks should reference valid line numbers within the source
      for (const chunk of chunks) {
        expect(chunk.startLine).toBeGreaterThanOrEqual(1);
        expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
      }
    });
  });
});
