import { describe, expect, it } from "vitest";
import { readResponseBodySnippet } from "./http-error-body.js";

function bodyLessResponse(text: string): Response {
  return {
    body: null,
    text: async () => text,
  } as unknown as Response;
}

describe("readResponseBodySnippet", () => {
  it("returns full text when under both limits (body-less path)", async () => {
    const text = "short text";
    const result = await readResponseBodySnippet(bodyLessResponse(text), {
      maxBytes: 1024,
      maxChars: 50,
    });
    expect(result).toBe(text);
  });

  it("truncates by maxChars when under maxBytes (body-less path)", async () => {
    const text = "abcdefghij";
    const result = await readResponseBodySnippet(bodyLessResponse(text), {
      maxBytes: 1024,
      maxChars: 5,
    });
    expect(result).toBe("abcde");
  });

  it("truncates by maxBytes in the body-less path", async () => {
    const text = "a".repeat(200);
    const result = await readResponseBodySnippet(bodyLessResponse(text), {
      maxBytes: 50,
      maxChars: 500,
    });
    const byteLen = new TextEncoder().encode(result).length;
    expect(byteLen).toBeLessThanOrEqual(50);
    expect(result.length).toBeLessThan(text.length);
  });

  it("enforces maxBytes before maxChars in the body-less path", async () => {
    const text = "a".repeat(500);
    const result = await readResponseBodySnippet(bodyLessResponse(text), {
      maxBytes: 30,
      maxChars: 500,
    });
    const byteLen = new TextEncoder().encode(result).length;
    expect(byteLen).toBeLessThanOrEqual(30);
  });

  it("does not split multi-byte UTF-8 characters at the byte boundary", async () => {
    // U+1F600 (😀) is 4 bytes in UTF-8: F0 9F 98 80
    const text = "ab😀cd";
    // 2 ASCII bytes (ab) + cut before the 4-byte emoji
    const result = await readResponseBodySnippet(bodyLessResponse(text), {
      maxBytes: 3,
      maxChars: 100,
    });
    // With stream:true, incomplete multi-byte sequence is dropped
    expect(result).toBe("ab");
  });

  it("stream path still enforces maxBytes", async () => {
    const data = new Uint8Array(500).fill(97); // 500 'a' bytes
    const response = new Response(new Blob([data]).stream());
    const result = await readResponseBodySnippet(response, {
      maxBytes: 100,
      maxChars: 500,
    });
    const byteLen = new TextEncoder().encode(result).length;
    expect(byteLen).toBeLessThanOrEqual(100);
  });

  it("stream path still enforces maxChars", async () => {
    const data = new Uint8Array(500).fill(97);
    const response = new Response(new Blob([data]).stream());
    const result = await readResponseBodySnippet(response, {
      maxBytes: 200,
      maxChars: 10,
    });
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it("returns empty string when maxBytes is 0 (body-less path)", async () => {
    const result = await readResponseBodySnippet(bodyLessResponse("some text"), {
      maxBytes: 0,
      maxChars: 100,
    });
    expect(result).toBe("");
  });

  it("returns empty string for empty response body", async () => {
    const result = await readResponseBodySnippet(bodyLessResponse(""), {
      maxBytes: 1024,
      maxChars: 50,
    });
    expect(result).toBe("");
  });

  it("does not split surrogate pairs when truncating by maxChars (body-less path)", async () => {
    // "a" (1 code unit) + 5×🦞 (10 code units) = 11 code units > maxChars=10
    // .slice(0, 10) would cut between the surrogates of the 5th emoji
    const text = "a" + "🦞".repeat(5);
    const result = await readResponseBodySnippet(bodyLessResponse(text), {
      maxBytes: 1024,
      maxChars: 10,
    });
    for (let i = 0; i < result.length; i++) {
      const cp = result.charCodeAt(i);
      if (cp >= 0xd800 && cp <= 0xdbff) {
        expect(result.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
        expect(result.charCodeAt(i + 1)).toBeLessThanOrEqual(0xdfff);
      }
    }
    const lastCode = result.charCodeAt(result.length - 1);
    expect(lastCode < 0xd800 || lastCode > 0xdbff).toBe(true);
  });

  it("does not split surrogate pairs in the stream path", async () => {
    const text = "a" + "🦞".repeat(5);
    const data = new TextEncoder().encode(text);
    const response = new Response(new Blob([data]).stream());
    const result = await readResponseBodySnippet(response, {
      maxBytes: 1024,
      maxChars: 10,
    });
    for (let i = 0; i < result.length; i++) {
      const cp = result.charCodeAt(i);
      if (cp >= 0xd800 && cp <= 0xdbff) {
        expect(result.charCodeAt(i + 1)).toBeGreaterThanOrEqual(0xdc00);
        expect(result.charCodeAt(i + 1)).toBeLessThanOrEqual(0xdfff);
      }
    }
  });
});
