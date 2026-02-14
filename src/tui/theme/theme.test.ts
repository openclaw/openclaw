import { describe, expect, it } from "vitest";
import { markdownTheme } from "./theme.js";

describe("markdownTheme", () => {
  describe("highlightCode", () => {
    it("returns highlighted lines for common language inputs", () => {
      const code = `const x = 42;`;
      const js = markdownTheme.highlightCode!(code, "javascript");
      const ts = markdownTheme.highlightCode!(
        `function greet(name: string) {
  return "Hello, " + name;
}`,
        "typescript",
      );

      expect(js).toBeInstanceOf(Array);
      expect(js).toHaveLength(1);
      expect(js[0]).toContain("const");
      expect(js[0]).toContain("42");
      expect(ts).toHaveLength(3);
      expect(ts[0]).toContain("function");
      expect(ts[1]).toContain("return");
      expect(ts[2]).toContain("}");
    });

    it("handles unknown and missing language without throwing", () => {
      const code = `echo "hello"`;
      const unknown = markdownTheme.highlightCode!(code, "not-a-real-language");
      const missing = markdownTheme.highlightCode!(code, undefined);
      expect(unknown).toBeInstanceOf(Array);
      expect(missing).toBeInstanceOf(Array);
      expect(unknown).toHaveLength(1);
      expect(missing).toHaveLength(1);
      expect(unknown[0]).toContain("echo");
      expect(missing[0]).toContain("echo");
    });

    it("preserves code content and handles empty input", () => {
      const code = `const message = "Hello, World!";
console.log(message);`;
      const result = markdownTheme.highlightCode!(code, "javascript");
      const empty = markdownTheme.highlightCode!("", "javascript");

      const stripAnsi = (str: string) =>
        str.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
      expect(stripAnsi(result[0])).toBe(`const message = "Hello, World!";`);
      expect(stripAnsi(result[1])).toBe("console.log(message);");
      expect(empty).toEqual([""]);
    });
  });
});
