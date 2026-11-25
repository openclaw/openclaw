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

function element(root: ParentNode, selector: string): Element {
  return html.requireElement(root.querySelector(selector), `missing ${selector}`);
}

function textOf(root: ParentNode, selector: string) {
  return Array.from(root.querySelectorAll(selector), (node) => node.textContent).join("\n");
}

it.each([
  ["bash", "", false],
  ["bash", "", true],
  ["custom", "", true],
  ["bashExecution", "", true],
  ["write", "sample.ts", true],
  ["read", "Dockerfile", true],
  ["write", "sample.ts", false],
  ["read", "sample.html", true],
] as const)("preserves %s %s output (expanded=%s)", async (name, path, expanded) => {
  const offset = "<b data-offset-probe>untrusted</b>";
  const limit = name === "bash" ? 5 : 10;
  const lines = Array.from(
    { length: limit + Number(expanded) },
    (_, index) => `const v${index} = "<p>&</p>";\t// line`,
  );
  if (expanded && name !== "bash") {
    lines[lines.length - 1] = "";
  }
  const text = lines.join("\n");
  const range = path === "Dockerfile" ? { offset: 2, limit: 3 } : { offset };
  const args = { command: "echo", path, content: text, ...(name === "read" ? range : {}) };
  const { document } = await render(
    name === "bashExecution"
      ? [{ role: name, command: args.command, output: text, exitCode: 0 }]
      : [
          { role: "assistant", content: [{ type: "toolCall", id: name, name, arguments: args }] },
          { role: "toolResult", toolCallId: name, content: name === "write" ? "" : text },
        ],
  );
  if (name !== "bashExecution") {
    expect(document.querySelector('.tree-node[data-id="0"]')).toBeNull();
  }
  if (name === "read") {
    expect(textOf(document, ".line-numbers")).toBe(path === "Dockerfile" ? ":2-4" : `:${offset}`);
    expect(document.querySelector("#messages [data-offset-probe]")).toBeNull();
  }
  const output = element(document, ".tool-execution > .tool-output:last-child");
  expect(output.classList.contains("expandable")).toBe(expanded);
  const full = expanded ? element(output, ".output-full") : output;
  const selector = path ? "code.hljs" : ":scope > div:not(.expand-hint)";
  const expected = lines.map((line) => line.replace(/\t/g, "   "));
  expect(textOf(full, selector)).toBe(expected.join("\n"));
  if (expanded) {
    expect(textOf(element(output, ".output-preview"), selector)).toBe(
      expected.slice(0, limit).join("\n"),
    );
    expect(output.querySelector(".expand-hint")?.textContent).toBe("... (1 more lines)");
  }
  if (path) {
    const syntax = path === "Dockerfile" ? "span" : ".hljs-keyword, .hljs-tag";
    expect(full.querySelector(syntax) === null).toBe(path === "Dockerfile");
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
  const search = html.requireElement(
    document.querySelector<HTMLInputElement>("#tree-search"),
    "search input missing",
  );
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
