import { describe, it, expect } from "vitest";
import { extractDocRefsFromText, extractDocRefsFromPost } from "./docs.js";

describe("extractDocRefsFromText", () => {
  it("should extract docx URL", () => {
    const text = "Check this document https://example.feishu.cn/docx/B4EPdAYx8oi8HRxgPQQb";
    const refs = extractDocRefsFromText(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].docToken).toBe("B4EPdAYx8oi8HRxgPQQb");
    expect(refs[0].docType).toBe("docx");
  });

  it("should extract wiki URL", () => {
    const text = "Wiki link: https://company.feishu.cn/wiki/WikiTokenExample123";
    const refs = extractDocRefsFromText(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].docType).toBe("wiki");
    expect(refs[0].docToken).toBe("WikiTokenExample123");
  });

  it("should extract sheet URL", () => {
    const text = "Sheet URL https://open.larksuite.com/sheets/SheetToken1234567890";
    const refs = extractDocRefsFromText(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].docType).toBe("sheet");
  });

  it("should extract bitable/base URL", () => {
    const text = "Bitable https://abc.feishu.cn/base/BitableToken1234567890";
    const refs = extractDocRefsFromText(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].docType).toBe("bitable");
  });

  it("should extract multiple URLs", () => {
    const text = `
      Doc 1: https://example.feishu.cn/docx/Doc1Token12345678901
      Doc 2: https://example.feishu.cn/wiki/Wiki1Token12345678901
    `;
    const refs = extractDocRefsFromText(text);
    expect(refs).toHaveLength(2);
  });

  it("should deduplicate same token", () => {
    const text = `
      https://example.feishu.cn/docx/SameToken123456789012
      https://example.feishu.cn/docx/SameToken123456789012
    `;
    const refs = extractDocRefsFromText(text);
    expect(refs).toHaveLength(1);
  });

  it("should return empty array for text without URLs", () => {
    const text = "This is plain text without any document links";
    const refs = extractDocRefsFromText(text);
    expect(refs).toHaveLength(0);
  });
});

describe("extractDocRefsFromPost", () => {
  it("should extract URL from link element", () => {
    const content = {
      title: "Test rich text",
      content: [
        [
          {
            tag: "a",
            text: "API Documentation",
            href: "https://example.feishu.cn/docx/ApiDocToken123456789",
          },
        ],
      ],
    };
    const refs = extractDocRefsFromPost(content);
    expect(refs).toHaveLength(1);
    expect(refs[0].title).toBe("API Documentation");
    expect(refs[0].docToken).toBe("ApiDocToken123456789");
  });

  it("should extract URL from title", () => {
    const content = {
      title: "See https://example.feishu.cn/docx/TitleDocToken1234567",
      content: [],
    };
    const refs = extractDocRefsFromPost(content);
    expect(refs).toHaveLength(1);
  });

  it("should extract URL from text element", () => {
    const content = {
      content: [
        [
          {
            tag: "text",
            text: "Visit https://example.feishu.cn/wiki/TextWikiToken12345678",
          },
        ],
      ],
    };
    const refs = extractDocRefsFromPost(content);
    expect(refs).toHaveLength(1);
    expect(refs[0].docType).toBe("wiki");
  });

  it("should handle stringified JSON", () => {
    const content = JSON.stringify({
      title: "Document Share",
      content: [
        [
          {
            tag: "a",
            text: "Click to view",
            href: "https://example.feishu.cn/docx/JsonDocToken123456789",
          },
        ],
      ],
    });
    const refs = extractDocRefsFromPost(content);
    expect(refs).toHaveLength(1);
  });

  it("should return empty array for post without doc links", () => {
    const content = {
      title: "Normal title",
      content: [
        [
          { tag: "text", text: "Normal text" },
          { tag: "a", text: "Normal link", href: "https://example.com" },
        ],
      ],
    };
    const refs = extractDocRefsFromPost(content);
    expect(refs).toHaveLength(0);
  });
});
