import { describe, expect, it } from "vitest";
import { resolveReactionLevel } from "./reaction-level.js";

describe("resolveReactionLevel", () => {
  it("defaults when value is missing", () => {
    expect(
      resolveReactionLevel({ value: undefined, defaultLevel: "minimal", invalidFallback: "ack" }),
    ).toEqual({
      level: "minimal",
      ackEnabled: false,
      agentReactionsEnabled: true,
      agentReactionGuidance: "minimal",
    });
  });

  it("supports ack", () => {
    expect(
      resolveReactionLevel({ value: "ack", defaultLevel: "minimal", invalidFallback: "ack" }),
    ).toEqual({ level: "ack", ackEnabled: true, agentReactionsEnabled: false });
  });

  it("supports extensive", () => {
    expect(
      resolveReactionLevel({
        value: "extensive",
        defaultLevel: "minimal",
        invalidFallback: "ack",
      }),
    ).toEqual({
      level: "extensive",
      ackEnabled: false,
      agentReactionsEnabled: true,
      agentReactionGuidance: "extensive",
    });
  });

  it("uses invalid fallback ack", () => {
    expect(
      resolveReactionLevel({ value: "bogus", defaultLevel: "minimal", invalidFallback: "ack" }),
    ).toEqual({ level: "ack", ackEnabled: true, agentReactionsEnabled: false });
  });

  it("uses invalid fallback minimal", () => {
    expect(
      resolveReactionLevel({ value: "bogus", defaultLevel: "minimal", invalidFallback: "minimal" }),
    ).toEqual({
      level: "minimal",
      ackEnabled: false,
      agentReactionsEnabled: true,
      agentReactionGuidance: "minimal",
    });
  });
});
