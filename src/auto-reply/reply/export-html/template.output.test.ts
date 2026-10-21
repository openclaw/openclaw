import { describe, expect, it } from "vitest";
import {
  now,
  renderTemplate,
  requireElement,
  type SessionEntry,
} from "../../../../test/helpers/export-html-template.js";

function messageEntry(id: string, parentId: string | null, message: unknown): SessionEntry {
  return { id, parentId, timestamp: now(), type: "message", message };
}

function render(entries: SessionEntry[]) {
  return renderTemplate({
    header: { id: "session", timestamp: now() },
    entries,
    leafId: entries.at(-1)?.id ?? null,
    systemPrompt: "",
    tools: [],
  });
}

function element<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  return requireElement(root.querySelector<T>(selector), `missing ${selector}`);
}

describe("export html output and navigation", () => {
  it("renders read line-range arguments as text", async () => {
    const offset = "<b data-offset-probe>untrusted</b>";
    const { document } = await render([
      messageEntry("read", null, {
        role: "assistant",
        content: [{ offset: 2, limit: 3 }, { offset }].map((args, index) => ({
          type: "toolCall",
          id: `read-${index}`,
          name: "read",
          arguments: { path: "safe.txt", ...args },
        })),
      }),
    ]);

    expect(
      Array.from(document.querySelectorAll(".line-numbers"), (node) => node.textContent),
    ).toEqual([":2-4", `:${offset}`]);
    expect(document.querySelector("#messages [data-offset-probe]")).toBeNull();
  });

  it.each([
    { name: "bash", filePath: "", maxLines: 5, code: false },
    { name: "custom", filePath: "", maxLines: 10, code: false },
    { name: "bashExecution", filePath: "", maxLines: 10, code: false },
    { name: "write", filePath: "sample.ts", maxLines: 10, code: true },
    { name: "read", filePath: "Dockerfile", maxLines: 10, code: true },
    { name: "read", filePath: "sample.html", maxLines: 10, code: true },
  ])(
    "preserves $name $filePath output around its preview limit",
    async ({ name, filePath, maxLines, code }) => {
      for (const lineCount of [maxLines, maxLines + 1]) {
        const lines = Array.from({ length: lineCount }, (_, index) =>
          filePath.endsWith(".html")
            ? `<p>line ${index} & text</p>\tend`
            : `const value${index} = "<&>";\t// line`,
        );
        if (lineCount > maxLines && name !== "bash") {
          lines[lineCount - 1] = "";
        }
        const text = lines.join("\n");
        const call = {
          type: "toolCall",
          id: "call-output",
          name,
          arguments: { command: "echo output", path: filePath, content: text },
        };
        const entries =
          name === "bashExecution"
            ? [
                messageEntry("1", null, {
                  role: name,
                  command: "echo output",
                  output: text,
                  exitCode: 0,
                }),
              ]
            : [
                messageEntry("1", null, { role: "assistant", content: [call] }),
                messageEntry("2", "1", {
                  role: "toolResult",
                  toolCallId: "call-output",
                  content: name === "write" ? "" : text,
                }),
              ];
        const { document } = await render(entries);
        if (name !== "bashExecution") {
          expect(document.querySelector('.tree-node[data-id="1"]')).toBeNull();
        }
        const outputs = document.querySelectorAll(".tool-execution > .tool-output");
        const output = requireElement(outputs.item(outputs.length - 1), "tool output missing");
        const expanded = lineCount > maxLines;
        expect(output.classList.contains("expandable")).toBe(expanded);
        const full = expanded ? element(output, ".output-full") : output;
        const assertLines = (node: Element, expected: string[]) => {
          if (code) {
            expect(element(node, "code.hljs").textContent).toBe(expected.join("\n"));
          } else {
            expect(
              Array.from(node.children)
                .filter((child) => !child.classList.contains("expand-hint"))
                .map((child) => child.textContent),
            ).toEqual(expected);
          }
          expect(node.querySelector("p")).toBeNull();
        };
        const expected = lines.map((line) => line.replace(/\t/g, "   "));
        assertLines(full, expected);
        if (expanded) {
          assertLines(element(output, ".output-preview"), expected.slice(0, maxLines));
          expect(output.querySelector(".expand-hint")?.textContent).toBe("... (1 more lines)");
        }
        if (filePath === "Dockerfile") {
          expect(full.querySelector("span")).toBeNull();
        } else if (code) {
          expect(full.querySelector(".hljs-keyword, .hljs-tag")).not.toBeNull();
        }
      }
    },
  );
  it("restores all tree rows when Escape clears a search", async () => {
    const { document } = await render([
      messageEntry("root", null, { role: "user", content: "search-me" }),
      messageEntry("middle", "root", { role: "assistant", content: "middle reply" }),
      messageEntry("leaf", "middle", { role: "assistant", content: "current reply" }),
    ]);
    const treeIds = () =>
      Array.from(document.querySelectorAll(".tree-node"), (node) => node.getAttribute("data-id"));
    const search = element<HTMLInputElement>(document, "#tree-search");
    expect(treeIds()).toEqual(["root", "middle", "leaf"]);
    search.value = "search-me";
    const input = document.createEvent("Event");
    input.initEvent("input", true, false);
    search.dispatchEvent(input);
    expect(treeIds()).toEqual(["root", "leaf"]);

    const escape = document.createEvent("Event");
    escape.initEvent("keydown", true, true);
    Object.defineProperty(escape, "key", { value: "Escape" });
    document.dispatchEvent(escape);

    expect(search.value).toBe("");
    expect(treeIds()).toEqual(["root", "middle", "leaf"]);
  });
});
