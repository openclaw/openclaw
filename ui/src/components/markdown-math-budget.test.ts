import { describe, expect, it } from "vitest";
import { htmlFragment, toStreamingMarkdownParts } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

function admittedMath(html: string): string[] {
  return [...htmlFragment(html).querySelectorAll("openclaw-markdown-math")].map(
    (leaf) => leaf.textContent ?? "",
  );
}
const prefix = (count: number) =>
  Array.from({ length: count }, (_, index) => `$x_${index}$\n\n`).join("");
const streamed = (source: string, key: string, options = {}) =>
  toStreamingMarkdownParts(source, options, key).join("");

describe("message-level streamed math budget", () => {
  it("keeps the first 200 expressions across stable appends, options and completion", () => {
    let source = "";
    let html = "";
    for (let index = 0; index <= 200; index += 1) {
      source += `$x_${index}$\n\n`;
      html = streamed(source, "math-budget-append");
    }
    const completed = admittedMath(toSanitizedMarkdownHtml(source));
    expect(completed).toHaveLength(200);
    expect(admittedMath(html)).toEqual(completed);
    expect(admittedMath(streamed(source, "math-budget-append", { fileLinks: true }))).toEqual(
      completed,
    );
    expect(htmlFragment(html).textContent).toContain("$x_200$");
  });

  it("does not charge mutable tails twice, including promotion and exhausted-prefix fallback", () => {
    const key = "math-budget-tail";
    const stable = prefix(199);
    streamed(stable, key);
    for (const tail of ["$tail$", "$tail$ text", "$changed$", "$tail$"]) {
      const html = streamed(stable + tail, key);
      expect(admittedMath(html)).toHaveLength(200);
      expect(admittedMath(html).at(-1)).toBe(tail.split(" ")[0]);
    }
    const promoted = stable + "$tail$\n\n";
    expect(admittedMath(streamed(promoted, key))).toHaveLength(200);
    for (const tail of ["$tail$", "$changed$", "$tail$"]) {
      const html = streamed(promoted + tail, key);
      expect(admittedMath(html)).toHaveLength(200);
      expect(htmlFragment(html).textContent).toContain(tail);
    }
    expect(admittedMath(streamed("$tail$", "math-budget-new"))).toEqual(["$tail$"]);
    expect(admittedMath(streamed("$tail$", key))).toEqual(["$tail$"]);
  });

  it("recounts the full stable prefix when cross-block file labels require rerendering", () => {
    const key = "math-budget-full-prefix";
    const options = { fileLinks: true };
    const stable = prefix(199) + "[a](/one/file.ts)\n\n";
    streamed(stable, key, options);
    const source = stable + "$last$ [b](/two/file.ts)\n\n$overflow$";
    const html = streamed(source, key, options);
    expect(admittedMath(html)).toEqual(admittedMath(toSanitizedMarkdownHtml(source, options)));
    expect(admittedMath(html)).toHaveLength(200);
  });
});
