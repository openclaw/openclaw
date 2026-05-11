/**
 * OpenResponses request schema unit tests
 *
 * Pinpoints the request-shape contract for `/v1/responses`. The `text` field
 * in particular is auto-populated by current OpenAI Node SDKs (>= 6.x) and
 * @langchain/openai (>= 1.x) on every request, so the schema must accept it
 * even when the gateway does not yet honor non-default formats at runtime.
 */

import { describe, expect, it } from "vitest";
import { CreateResponseBodySchema } from "./open-responses.schema.js";

const baseRequest = {
  model: "openclaw",
  input: "hello",
} as const;

describe("CreateResponseBodySchema", () => {
  describe("text field (OpenAI Responses parity)", () => {
    it("accepts the default text format auto-populated by the OpenAI SDK", () => {
      const result = CreateResponseBodySchema.safeParse({
        ...baseRequest,
        text: { format: { type: "text" } },
      });
      expect(result.success).toBe(true);
    });

    it("accepts a json_schema format request", () => {
      const result = CreateResponseBodySchema.safeParse({
        ...baseRequest,
        text: {
          format: {
            type: "json_schema",
            name: "user",
            schema: { type: "object", properties: { id: { type: "string" } } },
            strict: true,
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts a json_object format request", () => {
      const result = CreateResponseBodySchema.safeParse({
        ...baseRequest,
        text: { format: { type: "json_object" } },
      });
      expect(result.success).toBe(true);
    });

    it("accepts text.verbosity without a format", () => {
      const result = CreateResponseBodySchema.safeParse({
        ...baseRequest,
        text: { verbosity: "low" },
      });
      expect(result.success).toBe(true);
    });

    it("accepts an empty text object", () => {
      const result = CreateResponseBodySchema.safeParse({
        ...baseRequest,
        text: {},
      });
      expect(result.success).toBe(true);
    });

    it("rejects an unknown format type", () => {
      const result = CreateResponseBodySchema.safeParse({
        ...baseRequest,
        text: { format: { type: "yaml" } },
      });
      expect(result.success).toBe(false);
    });

    it("rejects a json_schema format missing required fields", () => {
      const result = CreateResponseBodySchema.safeParse({
        ...baseRequest,
        text: { format: { type: "json_schema" } },
      });
      expect(result.success).toBe(false);
    });

    it("rejects unknown top-level keys on text", () => {
      const result = CreateResponseBodySchema.safeParse({
        ...baseRequest,
        text: { format: { type: "text" }, unexpected: "value" },
      });
      expect(result.success).toBe(false);
    });
  });

  it("still rejects unknown top-level fields", () => {
    const result = CreateResponseBodySchema.safeParse({
      ...baseRequest,
      definitelyNotASupportedField: 1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts the full request shape an OpenAI SDK 6.x client sends today", () => {
    const result = CreateResponseBodySchema.safeParse({
      ...baseRequest,
      tools: [{ type: "function", name: "echo" }],
      tool_choice: "auto",
      stream: false,
      text: { format: { type: "text" } },
      store: false,
    });
    expect(result.success).toBe(true);
  });
});
