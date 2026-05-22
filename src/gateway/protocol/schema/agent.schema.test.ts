import AjvModule from "ajv";
import { describe, expect, it } from "vitest";
import { AgentParamsSchema } from "./agent.js";
const Ajv = (AjvModule as any).default ?? AjvModule;

const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(AgentParamsSchema);

describe("AgentParamsSchema", () => {
  const baseParams = {
    message: "test message",
    idempotencyKey: "test-key-123",
  };
  const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

  it("accepts minimal valid params", () => {
    const valid = validate(baseParams);
    expect(valid).toBe(true);
  });

  it("accepts drainsContinuationDelegateQueue: true", () => {
    const valid = validate({
      ...baseParams,
      drainsContinuationDelegateQueue: true,
    });
    expect(valid).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it("accepts drainsContinuationDelegateQueue: false", () => {
    const valid = validate({
      ...baseParams,
      drainsContinuationDelegateQueue: false,
    });
    expect(valid).toBe(true);
  });

  it("marks runner-only knobs as internal for public protocol generators", () => {
    const properties = AgentParamsSchema.properties as Record<
      string,
      { "x-openclaw-internal"?: boolean }
    >;

    expect(properties.drainsContinuationDelegateQueue?.["x-openclaw-internal"]).toBe(true);
    expect(properties.traceparent?.["x-openclaw-internal"]).toBe(true);
  });

  it("accepts params without drainsContinuationDelegateQueue (optional)", () => {
    const valid = validate(baseParams);
    expect(valid).toBe(true);
  });

  it("rejects unknown additional properties", () => {
    const valid = validate({
      ...baseParams,
      notARealField: "should fail",
    });
    expect(valid).toBe(false);
  });

  it("accepts the full spawn payload shape from spawnSubagentDirect", () => {
    const valid = validate({
      ...baseParams,
      deliver: false,
      lane: "subagent",
      drainsContinuationDelegateQueue: true,
      continuationTrigger: "delegate-return",
      traceparent,
    });
    expect(valid).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it("rejects malformed inherited traceparent values", () => {
    const valid = validate({
      ...baseParams,
      traceparent: "not-a-traceparent",
    });
    expect(valid).toBe(false);
  });
});
