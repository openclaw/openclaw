import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  resolveSessionStewardBoundary,
  type SessionStewardBoundaryDecision,
} from "./session-steward-policy.js";

type SessionStewardBoundaryFixture = {
  name: string;
  sessionKey?: string | null;
  requestedAgentId?: string | null;
  expected: SessionStewardBoundaryDecision;
  rawMustNotContain?: string[];
};

const fixtures = JSON.parse(
  readFileSync("test/fixtures/session-steward-boundary-cases.json", "utf8"),
) as SessionStewardBoundaryFixture[];

describe("Session Steward boundary policy", () => {
  it.each(fixtures)("classifies and redacts $name", (fixture) => {
    const decision = resolveSessionStewardBoundary({
      sessionKey: fixture.sessionKey,
      requestedAgentId: fixture.requestedAgentId,
    });
    expect(decision).toEqual(fixture.expected);
    expect(decision.affectedSession).toBe(fixture.expected.affectedSession);
    for (const rawValue of fixture.rawMustNotContain ?? []) {
      expect(JSON.stringify(decision)).not.toContain(rawValue);
    }
  });

  it("does not return raw session tails in serialized decisions", () => {
    const decision = resolveSessionStewardBoundary({
      sessionKey: "agent:main:direct:person-123:thread:thread-456",
      requestedAgentId: "worker",
    });
    const serialized = JSON.stringify(decision);
    expect(decision).toMatchObject({
      kind: "agent",
      ownerAgentId: "main",
      requestedAgentId: "worker",
      agentRelation: "cross_agent",
      affectedSession: "agent:main:REDACTED",
    });
    expect(serialized).not.toContain("person-123");
    expect(serialized).not.toContain("thread-456");
  });
});
