import { describe, expect, it } from "vitest";
import { extractNotionUrlsFromText } from "./linear-client.js";

describe("linear-client", () => {
  it("extracts notion urls from markdown-wrapped links and plain urls", () => {
    expect(
      extractNotionUrlsFromText(`
Notion spec: [https://www.notion.so/31f2cb8d0fb481878347e1be99750319](<https://www.notion.so/31f2cb8d0fb481878347e1be99750319>)

Backup: https://workspace.notion.site/example-page-12345.
      `),
    ).toEqual([
      "https://www.notion.so/31f2cb8d0fb481878347e1be99750319",
      "https://workspace.notion.site/example-page-12345",
    ]);
  });
});
