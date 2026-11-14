import { beforeAll, describe, expect, it } from "vitest";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { htmlFragment, toStreamingMarkdownParts } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

beforeAll(async () => {
  await waitForSolid(() =>
    expect(toSanitizedMarkdownHtml("```ts\nconst ready = true;\n```")).toContain("hljs-keyword"),
  );
});
const mermaid = "```mermaid\nflowchart LR\nA --> B";
const stream = (markdown: string) => toStreamingMarkdownParts(markdown).join("");
function expectCode(code: Element | null | undefined, text: string, highlighted: boolean) {
  expect(code?.textContent).toContain(text);
  expect(code?.classList.contains("hljs")).toBe(highlighted);
  expect(code?.querySelector("span") === null).toBe(!highlighted);
}

describe("toStreamingMarkdownParts code fences", () => {
  it.each([
    { name: "an unfinished fence", markdown: mermaid, diagrams: 0 },
    { name: "a finished response", markdown: mermaid, final: true, diagrams: 1 },
    { name: "a tilde fence", markdown: "~~~Mermaid\nflowchart LR\nA --> B\n~~~", diagrams: 1 },
    { name: "a shell fence", markdown: "```bash\nflowchart LR\nA --> B\n```", diagrams: 0 },
    {
      name: "an authored HTML marker",
      markdown: '<div class="markdown-mermaid"><pre><code>flowchart LR</code></pre></div>',
      diagrams: 0,
    },
    {
      name: "closed then open fences",
      markdown: mermaid + "\n```\n\n" + mermaid.replace("A --> B", "C --> D"),
      diagrams: 1,
    },
  ])("only mounts complete Mermaid source: $name", ({ markdown, diagrams, final }) => {
    const fragment = htmlFragment(final ? toSanitizedMarkdownHtml(markdown) : stream(markdown));
    expect(fragment.querySelectorAll(".markdown-mermaid")).toHaveLength(diagrams);
    for (const diagram of fragment.querySelectorAll(".markdown-mermaid")) {
      expect(diagram.querySelector("pre code")?.textContent).toContain("flowchart LR");
    }
  });

  it.each([
    ["preamble", "Intro\n\n```ts\nconst x = 1 < 2", "code.language-ts", "const x = 1 < 2"],
    ["list", "- ```ts\n  const x = 1;\n\n  const y = 2;", "li code", "const x = 1;"],
    ["blockquote", "> ```ts\n> const x = 1;\n>\n> const y = 2;", "blockquote code", "const x = 1;"],
  ])("streams an open %s code fence without highlighting", (kind, markdown, selector, text) => {
    const html = stream(markdown);
    const fragment = htmlFragment(html);
    if (kind === "preamble") {
      expect(fragment.querySelector("p")?.textContent).toBe("Intro");
    }
    expectCode(fragment.querySelector(selector), text, false);
    if (kind !== "preamble") {
      expect(fragment.querySelector(selector)?.textContent).toContain("const y = 2;");
    }
    expect(html).not.toContain("markdown-plain-text-fallback");
  });

  it("highlights only completed fences inside an open details block", () => {
    const html = stream(
      "<details>\n<summary>Logs</summary>\n\n```ts\nconst closed = 1;\n```\n\n```ts\nconst open = 2;",
    );
    const code = htmlFragment(html).querySelectorAll("details code.language-ts");

    expect(code).toHaveLength(2);
    expectCode(code[0], "const closed = 1;", true);
    expectCode(code[1], "const open = 2;", false);
  });

  it("keeps a completed fence highlighted when a later backtick fence has invalid info", () => {
    const html = stream("- ```ts\n  const closed = 1;\n  ```\n\n  ```bad`info\n  trailing text");
    const code = htmlFragment(html).querySelector("code.language-ts");

    expect(code?.textContent).toContain("const closed = 1;");
    expect(code?.classList.contains("hljs")).toBe(true);
  });

  it("keeps completed tilde-fence code out of the remend tail", () => {
    // remend only understands ``` fences; a closed ~~~ block must land in the
    // stable prefix so its raw markers are never "completed" as inline markdown.
    const html = stream('~~~ts\nconst s = "**open";\n~~~\ncontinuing **bold');
    const fragment = htmlFragment(html);

    expect(fragment.querySelector("code")?.textContent).toContain('const s = "**open";');
    expect(fragment.querySelector("code strong")).toBeNull();
    expect(fragment.querySelector("p strong")?.textContent).toBe("bold");
  });
});
