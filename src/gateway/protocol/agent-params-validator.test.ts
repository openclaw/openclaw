import { describe, expect, it } from "vitest";
import { validateAgentParams } from "./index.js";

describe("validateAgentParams", () => {
  // Regression for https://github.com/openclaw/openclaw/issues/74635.
  // Paperclip and other external agents inject a `paperclip` property
  // into the gateway agent invocation payload. Before the schema added
  // `paperclip: Type.Optional(Type.Unknown())`, AgentParamsSchema's
  // `additionalProperties: false` rejected the entire payload with
  // "unexpected property 'paperclip'", and Paperclip heartbeats never
  // reached the agent.
  it("accepts a Paperclip-style root-level metadata field", () => {
    const ok = validateAgentParams({
      message: "agent heartbeat",
      idempotencyKey: "paperclip-heartbeat-1",
      paperclip: { agentRev: "3494e84", lastSeen: 1775154056736 },
    });
    expect(ok).toBe(true);
  });

  // The metadata is opaque from the gateway's perspective — it must
  // accept an empty object and a primitive payload too (Paperclip
  // hasn't committed to a fixed shape, and the gateway shouldn't gate
  // on one prematurely).
  it("treats the paperclip field as opaque (any JSON value)", () => {
    expect(
      validateAgentParams({
        message: "x",
        idempotencyKey: "k1",
        paperclip: {},
      }),
    ).toBe(true);
    expect(
      validateAgentParams({
        message: "x",
        idempotencyKey: "k2",
        paperclip: "ping",
      }),
    ).toBe(true);
    expect(
      validateAgentParams({
        message: "x",
        idempotencyKey: "k3",
        paperclip: true,
      }),
    ).toBe(true);
  });

  it("still rejects truly unknown properties (additionalProperties guard intact)", () => {
    expect(
      validateAgentParams({
        message: "x",
        idempotencyKey: "k4",
        someRandomFutureField: "should-not-be-accepted",
      }),
    ).toBe(false);
  });

  it("still requires the canonical message + idempotencyKey fields", () => {
    expect(
      validateAgentParams({
        paperclip: { agentRev: "3494e84" },
      }),
    ).toBe(false);
  });
});
