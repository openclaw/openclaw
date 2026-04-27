import { describe, expect, it } from "vitest";
import { validateAgentParams } from "../index.js";

const minimalAgentParams = {
  message: "wake",
  idempotencyKey: "idem-1234",
} as const;

describe("AgentParamsSchema", () => {
  it("accepts minimal params", () => {
    expect(validateAgentParams(minimalAgentParams)).toBe(true);
  });

  it("accepts a paperclip context object in the payload", () => {
    // Paperclip ≥ 2026.416.0 includes a `paperclip` field in wake payloads.
    // The gateway must not reject it as an unexpected property.
    expect(
      validateAgentParams({
        ...minimalAgentParams,
        paperclip: {
          runId: "run-abc123",
          companyId: "13808fb1-a29b-4465-9796-b8b200845155",
          agentId: "agent-xyz",
          issueId: "issue-001",
        },
      }),
    ).toBe(true);
  });

  it("accepts a paperclip field with arbitrary shape", () => {
    expect(
      validateAgentParams({
        ...minimalAgentParams,
        paperclip: { nested: { deep: true }, list: [1, 2, 3] },
      }),
    ).toBe(true);
  });

  it("rejects a payload missing idempotencyKey", () => {
    expect(validateAgentParams({ message: "wake" })).toBe(false);
  });

  it("rejects a payload missing message", () => {
    expect(validateAgentParams({ idempotencyKey: "idem-1234" })).toBe(false);
  });

  it("rejects unknown top-level properties other than paperclip", () => {
    expect(validateAgentParams({ ...minimalAgentParams, notAKnownField: "value" })).toBe(false);
  });
});
