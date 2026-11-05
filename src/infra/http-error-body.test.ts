import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockWarn } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: mockWarn }),
}));

import { readResponseBodySnippet } from "./http-error-body.js";

describe("readResponseBodySnippet", () => {
  it.each(["short text", null])("returns full text when under both limits: %s", async (text) => {
    const result = await readResponseBodySnippet(new Response(text), {
      maxBytes: 1024,
      maxChars: 50,
    });
    expect(result).toBe(text ?? "");
  });

  it("returns empty string when maxBytes is 0", async () => {
    const result = await readResponseBodySnippet(new Response("some text"), {
      maxBytes: 0,
      maxChars: 100,
    });
    expect(result).toBe("");
  });

  it.each([
    {
      name: "character-limited response",
      maxBytes: 1024,
      expected: "a" + "🦞".repeat(4),
    },
    {
      name: "byte-limited response",
      // Cut a UTF-8 sequence before the character cap can hide it.
      maxBytes: 7,
      expected: "a🦞",
    },
    {
      name: "character-limited response after byte truncation",
      maxBytes: 30,
      expected: "a" + "🦞".repeat(4),
    },
  ])("keeps Unicode intact for $name", async ({ maxBytes, expected }) => {
    const result = await readResponseBodySnippet(new Response("a" + "🦞".repeat(10)), {
      maxBytes,
      maxChars: 10,
    });

    expect(result).toBe(expected);
  });
});

describe("readResponseBodySnippet error visibility", () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  it.each([
    {
      name: "body-less response read rejection",
      response: () => {
        const response = new Response(null);
        vi.spyOn(response, "arrayBuffer").mockRejectedValue(new Error("body already consumed"));
        return response;
      },
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
