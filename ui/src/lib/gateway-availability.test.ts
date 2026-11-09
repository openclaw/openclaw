// @vitest-environment node
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { describe, expect, it } from "vitest";
import {
  isAgentDatabaseInspectionPendingError,
  isAwaitingGatewayFailure,
  resolveGatewayReadRetryDelayMs,
} from "./gateway-availability.ts";

const pending = {
  code: "UNAVAILABLE",
  message: "Agent is preparing. Run Doctor if preparation fails.",
  retryable: true,
  retryAfterMs: 250,
  details: { code: "agent-database-inspection-pending", agentId: "main" },
};

describe("agent startup availability", () => {
  it.each([
    { shape: pending, expected: true },
    { shape: { ...pending, retryable: false }, expected: false },
    { shape: { ...pending, code: "INVALID_REQUEST" }, expected: false },
    {
      shape: { ...pending, details: { code: "agent-database-inspection-failed" } },
      expected: false,
    },
    { shape: { ...pending, details: undefined }, expected: false },
  ])(
    "classifies only retryable pending admission: $shape.details / $expected",
    ({ shape, expected }) => {
      const error = new GatewayProtocolRequestError(shape);
      expect(isAgentDatabaseInspectionPendingError(error)).toBe(expected);
      expect(isAwaitingGatewayFailure(error, { phase: "connected" })).toBe(expected);
    },
  );

  it("does not infer startup from diagnostic text or untyped errors", () => {
    expect(isAgentDatabaseInspectionPendingError(new Error(pending.message))).toBe(false);
    expect(isAgentDatabaseInspectionPendingError(pending)).toBe(false);
  });

  it("backs off to five seconds without shortening a server minimum", () => {
    const error = new GatewayProtocolRequestError(pending);
    expect(
      [0, 1, 2, 3, 4, 100].map((attempt) => resolveGatewayReadRetryDelayMs(error, attempt)),
    ).toEqual([500, 1_000, 2_000, 4_000, 5_000, 5_000]);
    expect(
      resolveGatewayReadRetryDelayMs(
        new GatewayProtocolRequestError({ ...pending, retryAfterMs: 12_000 }),
        10,
      ),
    ).toBe(12_000);
    expect(
      resolveGatewayReadRetryDelayMs(
        new GatewayProtocolRequestError({ ...pending, retryAfterMs: Number.NaN }),
        1,
      ),
    ).toBe(1_000);
  });
});
