import { expect, it } from "vitest";
import { htmlFragment } from "./markdown.test-support.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

const text = (source: string) => htmlFragment(toSanitizedMarkdownHtml(source)).textContent?.trim();

it.each([
  ["C:\\Users\\me\\.config\\openclaw.json and D:\\work\\_notes.txt", null],
  ["see (C:\\repo\\[draft].md) and C:/mixed\\_x", null],
  ["\\\\server\\share\\.hidden", null],
  ["C:\\_cache_\\file.txt and C:\\*tmp*\\x", null],
  ["escaped \\*stars\\* and \\_under\\_ stay escapes", "escaped *stars* and _under_ stay escapes"],
])("keeps plain-text Windows path backslashes (#195494): %s", (source, expected) => {
  expect(text(source)).toBe(expected ?? source);
});
