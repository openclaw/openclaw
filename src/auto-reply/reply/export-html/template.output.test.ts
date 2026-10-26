import { expect, it } from "vitest";
import * as html from "../../../../test/helpers/export-html-template.js";

function render(messages: unknown[]) {
  return html.renderTemplate({
    header: { id: "session", timestamp: html.now() },
    entries: messages.map((message, index) => ({
      id: String(index),
      parentId: index ? String(index - 1) : null,
      timestamp: html.now(),
      type: "message",
      message,
    })),
    leafId: String(messages.length - 1),
    systemPrompt: "",
    tools: [],
  });
}

function element<T extends Element = Element>(root: ParentNode, selector: string): T {
  return html.requireElement(root.querySelector<T>(selector), `missing ${selector}`);
}

function tool(name: string, args: Record<string, unknown>, id = name) {
  return { type: "toolCall", id, name, arguments: args };
}

it("renders read line-range arguments as text", async () => {
  const offset = "<b data-offset-probe>untrusted</b>";
  const { document } = await render([
    {
      role: "assistant",
      content: [{ offset: 2, limit: 3 }, { offset }].map((args, index) =>
        tool("read", { path: "safe.txt", ...args }, `read-${index}`),
      ),
    },
  ]);

  expect(
    Array.from(document.querySelectorAll(".line-numbers"), (node) => node.textContent),
  ).toEqual([":2-4", `:${offset}`]);
  expect(document.querySelector("#messages [data-offset-probe]")).toBeNull();
});

it.each([
  ["bash", ""],
  ["custom", ""],
  ["bashExecution", ""],
  ["write", "sample.ts"],
  ["read", "Dockerfile"],
  ["read", "sample.html"],
])("preserves %s %s output around its preview limit", async (name, filePath) => {
  const maxLines = name === "bash" ? 5 : 10;
  for (const lineCount of [maxLines, maxLines + 1]) {
    const lines = Array.from({ length: lineCount }, (_, index) =>
      filePath.endsWith(".html")
        ? `<p>line ${index} & text</p>\tend`
        : `const value${index} = "<&>";\t// line`,
    );
    const expanded = lineCount > maxLines;
    if (expanded && name !== "bash") {
      lines[lineCount - 1] = "";
    }
    const text = lines.join("\n");
    const args = { command: "echo output", path: filePath, content: text };
    const { document } = await render(
      name === "bashExecution"
        ? [{ role: name, command: args.command, output: text, exitCode: 0 }]
        : [
            { role: "assistant", content: [tool(name, args)] },
            { role: "toolResult", toolCallId: name, content: name === "write" ? "" : text },
          ],
    );
    if (name !== "bashExecution") {
      expect(document.querySelector('.tree-node[data-id="0"]')).toBeNull();
    }
    const output = element(document, ".tool-execution > .tool-output:last-child");
    expect(output.classList.contains("expandable")).toBe(expanded);
    const full = expanded ? element(output, ".output-full") : output;
    const assertLines = (node: Element, expected: string[]) => {
      const actual = filePath
        ? element(node, "code.hljs").textContent?.split("\n")
        : Array.from(node.children)
            .filter((child) => !child.classList.contains("expand-hint"))
            .map((child) => child.textContent);
      expect(actual).toEqual(expected);
    };
    const expected = lines.map((line) => line.replace(/\t/g, "   "));
    assertLines(full, expected);
    if (expanded) {
      assertLines(element(output, ".output-preview"), expected.slice(0, maxLines));
      expect(output.querySelector(".expand-hint")?.textContent).toBe("... (1 more lines)");
    }
    if (filePath === "Dockerfile") {
      expect(full.querySelector("span")).toBeNull();
    } else if (filePath) {
      expect(full.querySelector(".hljs-keyword, .hljs-tag")).not.toBeNull();
    }
  }
});
it("restores all tree rows when Escape clears a search", async () => {
  const { document } = await render([
    { role: "user", content: "search-me" },
    { role: "assistant", content: "middle reply" },
    { role: "assistant", content: "current reply" },
  ]);
  const treeIds = () =>
    Array.from(document.querySelectorAll(".tree-node"), (node) => node.getAttribute("data-id"));
  const search = element<HTMLInputElement>(document, "#tree-search");
  expect(treeIds()).toEqual(["0", "1", "2"]);
  search.value = "search-me";
  const input = document.createEvent("Event");
  input.initEvent("input", true, false);
  search.dispatchEvent(input);
  expect(treeIds()).toEqual(["0", "2"]);

  const escape = document.createEvent("Event");
  escape.initEvent("keydown", true, true);
  Object.defineProperty(escape, "key", { value: "Escape" });
  document.dispatchEvent(escape);

  expect(search.value).toBe("");
  expect(treeIds()).toEqual(["0", "1", "2"]);
});
