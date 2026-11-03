import { describe, expect, it } from "vitest";
import {
  prepareMarkdownTextReferenceSnapshot,
  prepareMarkdownTextReferences,
} from "./markdown-text-references.ts";
import { htmlFragment } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

describe("native and contributed text references", () => {
  const reference = (host: string) =>
    prepareMarkdownTextReferenceSnapshot({
      key: "same-declared-key",
      resolve: ({ text }: { text: string }) => {
        const start = text.indexOf("TASK-42");
        return start < 0 ? [] : [{ start, end: start + 7, url: `https://${host}/tasks/42` }];
      },
    });
  it("keeps native GitHub refs, authored links and code while adding plugin refs", () => {
    const html = htmlFragment(
      toSanitizedMarkdownHtml(
        "[PR #12](https://github.com/acme/native/pull/12) and TASK-42; `TASK-42`; [TASK-42](https://example.test/authored)",
        {
          textReferences: prepareMarkdownTextReferences([reference("forge.example")]),
        },
      ),
    );
    expect([...html.querySelectorAll("a")].map((link) => link.getAttribute("href"))).toEqual([
      "https://github.com/acme/native/pull/12",
      "https://forge.example/tasks/42",
      "https://example.test/authored",
    ]);
    expect(html.querySelector("code")?.textContent).toBe("TASK-42");
  });
  it("does not reuse settled Markdown output across replacement resolver snapshots", () => {
    const first = htmlFragment(
      toSanitizedMarkdownHtml("TASK-42", {
        textReferences: prepareMarkdownTextReferences([reference("first.example")]),
      }),
    );
    const second = htmlFragment(
      toSanitizedMarkdownHtml("TASK-42", {
        textReferences: prepareMarkdownTextReferences([reference("second.example")]),
      }),
    );
    expect(first.querySelector("a")?.getAttribute("href")).toBe("https://first.example/tasks/42");
    expect(second.querySelector("a")?.getAttribute("href")).toBe("https://second.example/tasks/42");
  });
});
