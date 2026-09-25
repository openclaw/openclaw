import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockWarn } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: mockWarn }),
}));

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

  it("does not split multi-byte UTF-8 characters at the byte boundary", async () => {
    const text = "ab😀cd";
    // 2 ASCII bytes (ab) + cut before the 4-byte emoji
    const result = await readResponseBodySnippet(bodyLessResponse(text), {
      maxBytes: 3,
      maxChars: 100,
    });
    expect(result).toBe("ab");
  });

  it("stream path drops partial UTF-8 characters at the byte boundary", async () => {
    const response = new Response(new Blob([new TextEncoder().encode("ab😀cd")]).stream());
    const result = await readResponseBodySnippet(response, {
      maxBytes: 3,
      maxChars: 100,
    });

    expect(result).toBe("ab");
  });

  it("returns empty string when maxBytes is 0 (body-less path)", async () => {
    const result = await readResponseBodySnippet(bodyLessResponse("some text"), {
      maxBytes: 0,
      maxChars: 100,
    });
    expect(result).toBe("");
  });

  it.each([
    {
      name: "body-less response under the byte limit",
      response: () => bodyLessResponse("a" + "🦞".repeat(10)),
      maxBytes: 1024,
    },
    {
      name: "body-less response truncated by the byte limit",
      response: () => bodyLessResponse("a" + "🦞".repeat(10)),
      maxBytes: 30,
    },
    {
      name: "streamed response",
      response: () =>
        new Response(new Blob([new TextEncoder().encode("a" + "🦞".repeat(10))]).stream()),
      maxBytes: 1024,
    },
  ])("preserves surrogate pairs for $name", async ({ response, maxBytes }) => {
    const result = await readResponseBodySnippet(response(), {
      maxBytes,
      maxChars: 10,
    });

    expect(result).toBe("a" + "🦞".repeat(4));
  });
});

describe("readResponseBodySnippet error visibility", () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  it.each([
    {
      name: "response.text() rejection",
      response: () =>
        ({
          body: null,
          text: async () => {
            throw new Error("body already consumed");
          },
        }) as unknown as Response,
      expectedError: "body already consumed",
    },
    {
      name: "body stream failure",
      response: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"));
              controller.error(new Error("stream aborted"));
            },
          }),
        ),
      expectedError: "stream aborted",
    },
  ])(
    "logs the read error and preserves the empty fallback for $name",
    async ({ response, expectedError }) => {
      const result = await readResponseBodySnippet(response(), {
        maxBytes: 1024,
        maxChars: 50,
      });

      expect(result).toBe("");
      expect(mockWarn).toHaveBeenCalledExactlyOnceWith(
        `Failed to read response body snippet: ${expectedError}`,
      );
    },
  );
});
