import { describe, it, expect } from "vitest";
import { getToolTerminalPresentation } from "../tool-terminal-presentation.js";
import { createWebFetchTool } from "./web-fetch.js";

describe("web_fetch terminal presentation", () => {
  it("uses response metadata without page content or URL secrets", () => {
    const tool = createWebFetchTool();
    const terminalPresentation = tool ? getToolTerminalPresentation(tool) : undefined;
    if (!terminalPresentation) {
      throw new Error("expected web_fetch terminal presentation");
    }

    const result = {
      content: [],
      details: {
        url: "https://user:pass@example.com/report?token=secret#section",
        finalUrl: "https://example.com/final?token=secret#section",
        status: 200,
        contentType: "text/html",
        rawLength: 1200,
        truncated: true,
        title: "untrusted title",
        text: "untrusted page content",
      },
    };
    const presentation = terminalPresentation({}, result);

    expect(presentation?.text).toBe(
      [
        "Web fetch completed.",
        "Origin: https://example.com",
        "Status: 200",
        "Content type: text/html",
        "Content length: 1200 characters",
        "Truncated: yes",
      ].join("\n"),
    );
    expect(presentation?.text).not.toContain("secret");
    expect(presentation?.text).not.toContain("untrusted");
  });
});
