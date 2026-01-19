import { describe, expect, it } from "vitest";
import { markdownTheme } from "./theme.js";

describe("markdownTheme", () => {
  describe("highlightCode", () => {
    it("should highlight JavaScript code", () => {
      const code = `const x = 42;`;
      const result = markdownTheme.highlightCode!(code, "javascript");

      expect(result).toBeInstanceOf(Array);
      expect(result).toHaveLength(1);
      // Should contain ANSI escape codes
      expect(result[0]).toContain("\x1b[");
    });

    it("should highlight TypeScript code with multiple lines", () => {
      const code = `function greet(name: string) {
  return "Hello, " + name;
}`;
      const result = markdownTheme.highlightCode!(code, "typescript");

      expect(result).toHaveLength(3);
      // Each line should have highlighting
      result.forEach((line) => {
        expect(line).toContain("\x1b[");
      });
    });

    it("should highlight Python code", () => {
      const code = `def hello():
    print("world")`;
      const result = markdownTheme.highlightCode!(code, "python");

      expect(result).toHaveLength(2);
      expect(result[0]).toContain("\x1b["); // def keyword colored
    });

    it("should handle unknown languages with auto-detection", () => {
      const code = `const x = 42;`;
      const result = markdownTheme.highlightCode!(code, "not-a-real-language");

      expect(result).toBeInstanceOf(Array);
      expect(result).toHaveLength(1);
      // Should still return something (auto-detected or fallback)
      expect(result[0].length).toBeGreaterThan(0);
    });

    it("should handle code without language specifier", () => {
      const code = `echo "hello"`;
      const result = markdownTheme.highlightCode!(code, undefined);

      expect(result).toBeInstanceOf(Array);
      expect(result).toHaveLength(1);
    });

    it("should handle empty code", () => {
      const result = markdownTheme.highlightCode!("", "javascript");

      expect(result).toBeInstanceOf(Array);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe("");
    });

    it("should highlight bash/shell code", () => {
      const code = `#!/bin/bash
echo "Hello"
for i in {1..5}; do
  echo $i
done`;
      const result = markdownTheme.highlightCode!(code, "bash");

      expect(result).toHaveLength(5);
      // Should have colored output
      expect(result.some((line) => line.includes("\x1b["))).toBe(true);
    });

    it("should highlight JSON", () => {
      const code = `{"name": "test", "count": 42, "active": true}`;
      const result = markdownTheme.highlightCode!(code, "json");

      expect(result).toHaveLength(1);
      expect(result[0]).toContain("\x1b[");
    });

    it("should handle code with special characters", () => {
      const code = `const regex = /\\d+/g;
const str = "Hello\\nWorld";`;
      const result = markdownTheme.highlightCode!(code, "javascript");

      expect(result).toHaveLength(2);
      // Should not throw and should return valid output
      expect(result[0].length).toBeGreaterThan(0);
    });
  });
});
