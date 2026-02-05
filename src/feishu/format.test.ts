import { describe, expect, it } from "vitest";
import { containsMarkdown, markdownToFeishuPost } from "./format.js";

describe("containsMarkdown", () => {
  it("detects bold text", () => {
    expect(containsMarkdown("Hello **world**")).toBe(true);
  });

  it("detects italic text", () => {
    expect(containsMarkdown("Hello *world*")).toBe(true);
  });

  it("detects inline code", () => {
    expect(containsMarkdown("Run `npm install`")).toBe(true);
  });

  it("detects code blocks", () => {
    expect(containsMarkdown("```js\nconsole.log('hi')\n```")).toBe(true);
  });

  it("detects links", () => {
    expect(containsMarkdown("Visit [Google](https://google.com)")).toBe(true);
  });

  it("detects headings", () => {
    expect(containsMarkdown("# Title")).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(containsMarkdown("Hello world")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(containsMarkdown("")).toBe(false);
  });
});

describe("markdownToFeishuPost", () => {
  it("converts plain text", () => {
    const result = markdownToFeishuPost("Hello world");
    expect(result.zh_cn?.content).toBeDefined();
    expect(result.zh_cn?.content[0]).toContainEqual({
      tag: "text",
      text: "Hello world",
    });
  });

  it("converts bold text", () => {
    const result = markdownToFeishuPost("Hello **bold** text");
    const content = result.zh_cn?.content[0];
    expect(content).toBeDefined();
    // Should have at least one element with bold style
    const boldElement = content?.find((el) => el.tag === "text" && el.style?.includes("bold"));
    expect(boldElement).toBeDefined();
  });

  it("converts italic text", () => {
    const result = markdownToFeishuPost("Hello *italic* text");
    const content = result.zh_cn?.content[0];
    expect(content).toBeDefined();
    const italicElement = content?.find((el) => el.tag === "text" && el.style?.includes("italic"));
    expect(italicElement).toBeDefined();
  });

  it("converts links", () => {
    const result = markdownToFeishuPost("Visit [Google](https://google.com)");
    const content = result.zh_cn?.content[0];
    expect(content).toBeDefined();
    const linkElement = content?.find((el) => el.tag === "a");
    expect(linkElement).toBeDefined();
    if (linkElement && linkElement.tag === "a") {
      expect(linkElement.href).toBe("https://google.com");
      expect(linkElement.text).toBe("Google");
    }
  });

  it("handles multi-line text", () => {
    const result = markdownToFeishuPost("Line 1\nLine 2\nLine 3");
    expect(result.zh_cn?.content.length).toBe(3);
  });

  it("converts code to code style", () => {
    const result = markdownToFeishuPost("Run `npm install`");
    const content = result.zh_cn?.content[0];
    expect(content).toBeDefined();
    const codeElement = content?.find((el) => el.tag === "text" && el.style?.includes("code"));
    expect(codeElement).toBeDefined();
  });

  it("handles empty input", () => {
    const result = markdownToFeishuPost("");
    expect(result.zh_cn?.content).toBeDefined();
  });
});
