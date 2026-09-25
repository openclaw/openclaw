// Tests exported tool output lines across plain and highlighted preview limits.
import { describe, expect, it } from "vitest";
import {
  now,
  renderTemplate,
  requireElement,
  type SessionEntry,
} from "../../../../test/helpers/export-html-template.js";

describe("export html tool output lines", () => {
  it.each([
    { name: "bash", filePath: "", maxLines: 5, code: false },
    { name: "custom", filePath: "", maxLines: 10, code: false },
    { name: "bashExecution", filePath: "", maxLines: 10, code: false },
    { name: "read", filePath: "sample.ts", maxLines: 10, code: true },
    { name: "write", filePath: "sample.ts", maxLines: 10, code: true },
    { name: "read", filePath: "Dockerfile", maxLines: 10, code: true },
    { name: "read", filePath: "sample.html", maxLines: 10, code: true },
  ])(
    "preserves $name $filePath output around its preview limit",
    async ({ name, filePath, maxLines, code }) => {
      for (const lineCount of [maxLines - 1, maxLines, maxLines + 1]) {
        const lines = Array.from({ length: lineCount }, (_, index) =>
          filePath.endsWith(".html")
            ? `<p>line ${index} & text</p>\tend`
            : `const value${index} = "<&>";\t// line`,
        );
        if (lineCount > maxLines && name !== "bash") {
          lines[lineCount - 1] = "";
        }
        const text = lines.join("\n");
        const entries: SessionEntry[] =
          name === "bashExecution"
            ? [
                {
                  id: "1",
                  parentId: null,
                  timestamp: now(),
                  type: "message",
                  message: { role: name, command: "echo output", output: text, exitCode: 0 },
                },
              ]
            : [
                {
                  id: "1",
                  parentId: null,
                  timestamp: now(),
                  type: "message",
                  message: {
                    role: "assistant",
                    content: [
                      {
                        type: "toolCall",
                        id: "call-output",
                        name,
                        arguments: { command: "echo output", path: filePath, content: text },
                      },
                    ],
                  },
                },
                {
                  id: "2",
                  parentId: "1",
                  timestamp: now(),
                  type: "message",
                  message: {
                    role: "toolResult",
                    toolCallId: "call-output",
                    content: name === "write" ? "" : text,
                  },
                },
              ];
        const { document } = await renderTemplate({
          header: { id: "session-output-lines", timestamp: now() },
          entries,
          leafId: name === "bashExecution" ? "1" : "2",
          systemPrompt: "",
          tools: [],
        });
        const outputs = document.querySelectorAll(".tool-execution > .tool-output");
        const output = requireElement(outputs.item(outputs.length - 1), "tool output missing");
        const expanded = lineCount > maxLines;
        expect(output.classList.contains("expandable")).toBe(expanded);
        const full = expanded
          ? requireElement(output.querySelector(".output-full"), "full output missing")
          : output;
        const assertLines = (element: Element, expected: string[]) => {
          if (code) {
            expect(
              requireElement(element.querySelector("code.hljs"), "code missing").textContent,
            ).toBe(expected.join("\n"));
          } else {
            expect(
              Array.from(element.children)
                .filter((child) => !child.classList.contains("expand-hint"))
                .map((child) => child.textContent),
            ).toEqual(expected);
          }
          expect(element.querySelector("p")).toBeNull();
        };
        const expected = lines.map((line) => line.replace(/\t/g, "   "));
        assertLines(full, expected);
        if (expanded) {
          assertLines(
            requireElement(output.querySelector(".output-preview"), "preview missing"),
            expected.slice(0, maxLines),
          );
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
});
