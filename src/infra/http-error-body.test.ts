import { describe, expect, it } from "vitest";
import { readResponseBodySnippet } from "./http-error-body.js";

function bodyLessResponse(text: string, opts?: { contentLength?: string }): Response {
  return {
    body: {} as ReadableStream,
    headers: {
      get: (name: string) => (name === "content-length" ? (opts?.contentLength ?? null) : null),
    },
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  } as unknown as Response;
}

describe("readResponseBodySnippet", () => {
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

  it("returns empty when Content-Length exceeds maxBytes (no-reader path)", async () => {
    let arrayBufferCalled = false;
    const bigResponse = {
      body: {} as ReadableStream,
      headers: { get: () => "1000" },
      arrayBuffer: async () => {
        arrayBufferCalled = true;
        return new ArrayBuffer(0);
      },
    } as unknown as Response;
    const result = await readResponseBodySnippet(bigResponse, {
      maxBytes: 50,
      maxChars: 100,
    });
    expect(arrayBufferCalled).toBe(false);
    expect(result).toBe("");
  });

  it("returns empty when maxBytes is 0 (no-reader path)", async () => {
    const result = await readResponseBodySnippet(
      bodyLessResponse("some text", { contentLength: "9" }),
      { maxBytes: 0, maxChars: 100 },
    );
    expect(result).toBe("");
  });

  it("fails closed when Content-Length is missing (no-reader path)", async () => {
    let arrayBufferCalled = false;
    const response = {
      body: {} as ReadableStream,
      arrayBuffer: async () => {
        arrayBufferCalled = true;
        return new ArrayBuffer(0);
      },
    } as unknown as Response;
    const result = await readResponseBodySnippet(response, {
      maxBytes: 100,
      maxChars: 50,
    });
    expect(arrayBufferCalled).toBe(false);
    expect(result).toBe("");
  });

  it("fails closed when Content-Length is invalid (no-reader path)", async () => {
    let arrayBufferCalled = false;
    const response = {
      body: {} as ReadableStream,
      headers: { get: () => "not-a-number" },
      arrayBuffer: async () => {
        arrayBufferCalled = true;
        return new ArrayBuffer(0);
      },
    } as unknown as Response;
    const result = await readResponseBodySnippet(response, {
      maxBytes: 100,
      maxChars: 50,
    });
    expect(arrayBufferCalled).toBe(false);
    expect(result).toBe("");
  });

  it("fails closed when Content-Length is within maxBytes (understated risk)", async () => {
    // Content-Length ≤ maxBytes cannot be trusted — the actual body may be
    // far larger. readResponsePrefix throws; readResponseBodySnippet catches
    // and returns "" as the safe fallback.
    let arrayBufferCalled = false;
    const response = {
      body: {} as ReadableStream,
      headers: { get: () => "50" },
      arrayBuffer: async () => {
        arrayBufferCalled = true;
        return new ArrayBuffer(0);
      },
    } as unknown as Response;
    const result = await readResponseBodySnippet(response, {
      maxBytes: 100,
      maxChars: 50,
    });
    expect(arrayBufferCalled).toBe(false);
    expect(result).toBe("");
  });
});
