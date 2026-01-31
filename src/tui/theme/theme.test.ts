import { describe, expect, it } from "vitest";
import { markdownTheme } from "./theme.js";

describe("markdownTheme", () => {
  describe("highlightCode", () => {
    it("should return an array of lines for JavaScript code", () => {
      const code = `const x = 42;`;
      const result = markdownTheme.highlightCode!(code, "javascript");

      expect(result).toBeInstanceOf(Array);
      expect(result).toHaveLength(1);
      // Result should contain the original code (possibly with ANSI codes)
      expect(result[0]).toContain("const");
      expect(result[0]).toContain("42");
    });

    it("should return correct line count for multi-line code", () => {
      const code = `function greet(name: string) {
  return "Hello, " + name;
}`;
      const result = markdownTheme.highlightCode!(code, "typescript");

      expect(result).toHaveLength(3);
      expect(result[0]).toContain("function");
      expect(result[1]).toContain("return");
      expect(result[2]).toContain("}");
    });

    it("should handle Python code", () => {
      const code = `def hello():
    print("world")`;
      const result = markdownTheme.highlightCode!(code, "python");

      expect(result).toHaveLength(2);
      expect(result[0]).toContain("def");
      expect(result[1]).toContain("print");
    });

    it("should handle unknown languages gracefully", () => {
      const code = `const x = 42;`;
      const result = markdownTheme.highlightCode!(code, "not-a-real-language");

      expect(result).toBeInstanceOf(Array);
      expect(result).toHaveLength(1);
      // Should still return the code content
      expect(result[0]).toContain("const");
    });

    it("should handle code without language specifier", () => {
      const code = `echo "hello"`;
      const result = markdownTheme.highlightCode!(code, undefined);

      expect(result).toBeInstanceOf(Array);
      expect(result).toHaveLength(1);
      expect(result[0]).toContain("echo");
    });

    it("should handle empty code", () => {
      const result = markdownTheme.highlightCode!("", "javascript");

      expect(result).toBeInstanceOf(Array);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe("");
    });

    it("should handle bash/shell code", () => {
      const code = `#!/bin/bash
echo "Hello"
for i in {1..5}; do
  echo $i
done`;
      const result = markdownTheme.highlightCode!(code, "bash");

      expect(result).toHaveLength(5);
      expect(result[0]).toContain("#!/bin/bash");
      expect(result[1]).toContain("echo");
    });

    it("should handle JSON", () => {
      const code = `{"name": "test", "count": 42, "active": true}`;
      const result = markdownTheme.highlightCode!(code, "json");

      expect(result).toHaveLength(1);
      expect(result[0]).toContain("name");
      expect(result[0]).toContain("42");
    });

    it("should handle code with special characters", () => {
      const code = `const regex = /\\d+/g;
const str = "Hello\\nWorld";`;
      const result = markdownTheme.highlightCode!(code, "javascript");

      expect(result).toHaveLength(2);
      // Should not throw and should return valid output
      expect(result[0].length).toBeGreaterThan(0);
      expect(result[1].length).toBeGreaterThan(0);
    });

    it("should preserve code content through highlighting", () => {
      const code = `const message = "Hello, World!";
console.log(message);`;
      const result = markdownTheme.highlightCode!(code, "javascript");

      // Strip ANSI codes to verify content is preserved
      const stripAnsi = (str: string) =>
        str.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
      expect(stripAnsi(result[0])).toBe(`const message = "Hello, World!";`);
      expect(stripAnsi(result[1])).toBe("console.log(message);");
    });
  });
});
