import { describe, expect, it } from "vitest";
import { resolveReactionLevel } from "./reaction-level.js";

const minimal = {
  level: "minimal",
  ackEnabled: false,
  agentReactionsEnabled: true,
  agentReactionGuidance: "minimal",
};
const ack = { level: "ack", ackEnabled: true, agentReactionsEnabled: false };

describe("resolveReactionLevel", () => {
  it.each([
    {
      name: "defaults when value is missing",
      value: undefined,
      fallback: "ack",
      expected: minimal,
    },
    { name: "supports ack", value: "ack", fallback: "ack", expected: ack },
    {
      name: "supports extensive",
      value: "extensive",
      fallback: "ack",
      expected: { ...minimal, level: "extensive", agentReactionGuidance: "extensive" },
    },
    { name: "uses invalid fallback ack", value: "bogus", fallback: "ack", expected: ack },
    {
      name: "uses invalid fallback minimal",
      value: "bogus",
      fallback: "minimal",
      expected: minimal,
    },
  ] as const)("$name", ({ value, fallback, expected }) => {
    expect(
      resolveReactionLevel({ value, defaultLevel: "minimal", invalidFallback: fallback }),
    ).toEqual(expected);
  });
});
