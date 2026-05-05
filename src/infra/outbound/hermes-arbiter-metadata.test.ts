import { describe, expect, it } from "vitest";
import { buildHermesArbiterMetadata } from "./hermes-arbiter-metadata.js";

describe("buildHermesArbiterMetadata", () => {
  it("builds Hermes-compatible snake_case metadata with trace and idempotency", () => {
    expect(
      buildHermesArbiterMetadata({
        topic: " ops ",
        botName: " alpha ",
        actionType: " notify ",
        traceId: " trace-1 ",
        idempotencyKey: " idem-1 ",
        extra: {
          arbiter_reason: "integration test",
          unsafe_key: "ignored",
          arbiter_topic: "ignored",
        },
      }),
    ).toEqual({
      arbiter_topic: "ops",
      arbiter_bot_name: "alpha",
      arbiter_action_type: "notify",
      arbiter_trace_id: "trace-1",
      arbiter_idempotency_key: "idem-1",
      arbiter_reason: "integration test",
    });
  });

  it("defaults actionType to send", () => {
    expect(
      buildHermesArbiterMetadata({
        topic: "ops",
        botName: "alpha",
        traceId: "trace-1",
        idempotencyKey: "idem-1",
      }).arbiter_action_type,
    ).toBe("send");
  });

  it("requires topic, bot, trace, and idempotency", () => {
    expect(() =>
      buildHermesArbiterMetadata({
        topic: " ",
        botName: "alpha",
        traceId: "t",
        idempotencyKey: "i",
      }),
    ).toThrow(/topic/);
  });
});
