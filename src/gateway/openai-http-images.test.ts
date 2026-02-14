import { describe, expect, it } from "vitest";

// These functions are module-private in openai-http.ts and not exported.
// We replicate the pure logic here to unit-test the parsing behavior.
// The e2e tests in openai-http.e2e.test.ts verify the full integration
// through the actual HTTP handler, ensuring no drift matters at runtime.

type ImageContent = { type: "image"; data: string; mimeType: string };

function extractImages(content: unknown): ImageContent[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const images: ImageContent[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const type = (part as { type?: unknown }).type;
    if (type !== "image_url") {
      continue;
    }
    const imageUrl = (part as { image_url?: { url?: string } }).image_url;
    const url = imageUrl?.url;
    if (typeof url !== "string") {
      continue;
    }
    const match = /^data:([^;]+);base64,(.+)$/i.exec(url);
    if (match) {
      images.push({ type: "image", data: match[2], mimeType: match[1] });
    }
  }
  return images;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        const type = (part as { type?: unknown }).type;
        const text = (part as { text?: unknown }).text;
        const inputText = (part as { input_text?: unknown }).input_text;
        if (type === "text" && typeof text === "string") {
          return text;
        }
        if (type === "input_text" && typeof text === "string") {
          return text;
        }
        if (typeof inputText === "string") {
          return inputText;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

describe("extractImages", () => {
  it("extracts base64 data URL images from multimodal content", () => {
    const base64 = "iVBORw0KGgoAAAANSUhEUg==";
    const content = [
      { type: "text", text: "What is this?" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
    ];
    const images = extractImages(content);
    expect(images).toHaveLength(1);
    expect(images[0]).toEqual({ type: "image", data: base64, mimeType: "image/png" });
  });

  it("extracts multiple images", () => {
    const content = [
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,BBB" } },
    ];
    const images = extractImages(content);
    expect(images).toHaveLength(2);
    expect(images[0].mimeType).toBe("image/png");
    expect(images[1].mimeType).toBe("image/jpeg");
  });

  it("ignores non-data-url image_url entries", () => {
    const content = [{ type: "image_url", image_url: { url: "https://example.com/image.png" } }];
    expect(extractImages(content)).toHaveLength(0);
  });

  it("ignores entries without image_url object", () => {
    const content = [{ type: "image_url" }, { type: "image_url", image_url: {} }];
    expect(extractImages(content)).toHaveLength(0);
  });

  it("returns empty for string content", () => {
    expect(extractImages("hello")).toHaveLength(0);
  });

  it("returns empty for null/undefined", () => {
    expect(extractImages(null)).toHaveLength(0);
    expect(extractImages(undefined)).toHaveLength(0);
  });

  it("skips non-object parts", () => {
    const content = [
      null,
      "string",
      42,
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ];
    const images = extractImages(content);
    expect(images).toHaveLength(1);
  });
});

describe("extractTextContent with multimodal content", () => {
  it("extracts text from array content alongside images", () => {
    const content = [
      { type: "text", text: "What is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ];
    expect(extractTextContent(content)).toBe("What is this?");
  });

  it("extracts text from plain string", () => {
    expect(extractTextContent("hello")).toBe("hello");
  });

  it("ignores image_url parts in text extraction", () => {
    const content = [{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } }];
    expect(extractTextContent(content)).toBe("");
  });

  it("extracts input_text type parts", () => {
    const content = [
      { type: "input_text", text: "from input_text type" },
      { type: "text", text: "from text type" },
    ];
    expect(extractTextContent(content)).toBe("from input_text type\nfrom text type");
  });

  it("extracts input_text property without type field", () => {
    const content = [{ input_text: "raw input text" }];
    expect(extractTextContent(content)).toBe("raw input text");
  });
});
