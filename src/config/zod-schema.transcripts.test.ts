import { describe, expect, it } from "vitest";
import { ALL_THINKING_LEVELS } from "../auto-reply/thinking.shared.js";
import { OpenClawSchemaShape } from "./zod-schema.root-shape.js";

describe("transcript summary thinking configuration", () => {
  it.each(ALL_THINKING_LEVELS)("accepts canonical thinking level %s", (summaryThinking) => {
    expect(OpenClawSchemaShape.transcripts.parse({ summaryThinking })).toEqual({ summaryThinking });
  });
  it("does not inject a thinking override when omitted", () => {
    expect(OpenClawSchemaShape.transcripts.parse({})).toEqual({});
  });
  it.each(["invalid", 1, null])("rejects invalid thinking value %s", (summaryThinking) => {
    expect(OpenClawSchemaShape.transcripts.safeParse({ summaryThinking }).success).toBe(false);
  });
});
