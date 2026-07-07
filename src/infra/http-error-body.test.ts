import { describe, expect, it } from "vitest";
import { readResponseBodySnippet } from "./http-error-body.js";

function streamResponseFromText(text: string): Response {
  return new Response(new Blob([text]).stream());
}

describe("readResponseBodySnippet", () => {
  it("returns full text when under both limits", async () => {
    const text = "short text";
    const result = await readResponseBodySnippet(streamResponseFromText(text), {
      maxBytes: 1024,
      maxChars: 50,
    });
    expect(result).toBe(text);
  });

  it("truncates by maxChars when under maxBytes", async () => {
    const text = "abcdefghij";
    const result = await readResponseBodySnippet(streamResponseFromText(text), {
      maxBytes: 1024,
      maxChars: 5,
    });
    expect(result).toBe("abcde");
  });

  it("truncates by maxBytes before maxChars", async () => {
    const text = "a".repeat(200);
    const result = await readResponseBodySnippet(streamResponseFromText(text), {
      maxBytes: 50,
      maxChars: 500,
    });
    const byteLen = new TextEncoder().encode(result).length;
    expect(byteLen).toBeLessThanOrEqual(50);
    expect(result.length).toBeLessThan(text.length);
  });

  it("enforces maxBytes before maxChars", async () => {
    const text = "a".repeat(500);
    const result = await readResponseBodySnippet(streamResponseFromText(text), {
      maxBytes: 30,
      maxChars: 500,
    });
    const byteLen = new TextEncoder().encode(result).length;
    expect(byteLen).toBeLessThanOrEqual(30);
  });

  it("does not split multi-byte UTF-8 characters at the byte boundary", async () => {
    // U+1F600 (😀) is 4 bytes in UTF-8: F0 9F 98 80
    const text = "ab😀cd";
    // 2 ASCII bytes (ab) + cut before the 4-byte emoji.
    // Without stream:true flag, incomplete multi-byte produces U+FFFD.
    const result = await readResponseBodySnippet(streamResponseFromText(text), {
      maxBytes: 3,
      maxChars: 100,
    });
    expect(result).toBe("ab�");
  });

  it("stream path enforces maxBytes", async () => {
    const data = new Uint8Array(500).fill(97); // 500 'a' bytes
    const response = new Response(new Blob([data]).stream());
    const result = await readResponseBodySnippet(response, {
      maxBytes: 100,
      maxChars: 500,
    });
    const byteLen = new TextEncoder().encode(result).length;
    expect(byteLen).toBeLessThanOrEqual(100);
  });

  it("stream path enforces maxChars", async () => {
    const data = new Uint8Array(500).fill(97);
    const response = new Response(new Blob([data]).stream());
    const result = await readResponseBodySnippet(response, {
      maxBytes: 200,
      maxChars: 10,
    });
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it("returns empty string when maxBytes is 0", async () => {
    const result = await readResponseBodySnippet(streamResponseFromText("some text"), {
      maxBytes: 0,
      maxChars: 100,
    });
    expect(result).toBe("");
  });

  it("returns empty string for empty response body", async () => {
    const result = await readResponseBodySnippet(streamResponseFromText(""), {
      maxBytes: 1024,
      maxChars: 50,
    });
    expect(result).toBe("");
  });

  it("fails closed when body has no getReader (avoids arrayBuffer)", async () => {
    let arrayBufferCalled = false;
    const noReaderResponse = {
      body: {} as ReadableStream,
      arrayBuffer: async () => {
        arrayBufferCalled = true;
        return new TextEncoder().encode("large body").buffer;
      },
    } as unknown as Response;
    const result = await readResponseBodySnippet(noReaderResponse, {
      maxBytes: 1024,
      maxChars: 100,
    });
    expect(arrayBufferCalled).toBe(false);
    expect(result).toBe("");
  });

  it("returns empty immediately when body is null", async () => {
    let arrayBufferCalled = false;
    const nullBodyResponse = {
      body: null,
      arrayBuffer: async () => {
        arrayBufferCalled = true;
        return new ArrayBuffer(0);
      },
    } as unknown as Response;
    const result = await readResponseBodySnippet(nullBodyResponse, {
      maxBytes: 1024,
      maxChars: 50,
    });
    expect(arrayBufferCalled).toBe(false);
    expect(result).toBe("");
  });
});
