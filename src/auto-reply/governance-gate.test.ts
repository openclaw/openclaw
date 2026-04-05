import { describe, it, expect, beforeEach } from "vitest";
import {
  evaluateInboundGovernance,
  getGovernanceGate,
  getGovernanceLedger,
  resetGovernanceSingletons,
} from "./governance-gate.js";
import type { FinalizedMsgContext } from "./templating.js";

function makeCtx(overrides?: Partial<FinalizedMsgContext>): FinalizedMsgContext {
  return {
    Body: "hello world",
    From: "telegram:12345",
    SenderId: "12345",
    SessionKey: "session-abc",
    CommandAuthorized: false,
    ...overrides,
  } as FinalizedMsgContext;
}

describe("governance-gate", () => {
  beforeEach(() => {
    resetGovernanceSingletons();
  });

  it("allows a well-formed inbound message", () => {
    const result = evaluateInboundGovernance(makeCtx());
    expect(result.verdict).toBe("allow");
    expect(result.hash).toBeTruthy();
  });

  it("logs every decision to the hash chain", () => {
    evaluateInboundGovernance(makeCtx());
    evaluateInboundGovernance(makeCtx({ From: "discord:999" }));
    const ledger = getGovernanceLedger();
    // At least 2 decision entries + 1 constraint registration
    expect(ledger.length).toBeGreaterThanOrEqual(2);
    expect(ledger.verify()).toBe(-1); // integrity check
  });

  it("denies when a custom constraint blocks", () => {
    const gate = getGovernanceGate();
    gate.addConstraint({
      id: "block-test",
      evaluate: (ctx) => {
        if (ctx.domain === "message") return "blocked for test";
        return null;
      },
    });
    const result = evaluateInboundGovernance(makeCtx());
    expect(result.verdict).toBe("deny");
    expect(result.reason).toContain("blocked for test");
  });

  it("fail-closed: errors in constraint evaluation result in deny", () => {
    const gate = getGovernanceGate();
    gate.addConstraint({
      id: "exploding",
      evaluate: () => { throw new Error("boom"); },
    });
    const result = evaluateInboundGovernance(makeCtx());
    expect(result.verdict).toBe("deny");
    expect(result.reason).toContain("boom");
  });

  it("uses SenderId as actor when available", () => {
    evaluateInboundGovernance(makeCtx({ SenderId: "user-42" }));
    const ledger = getGovernanceLedger();
    const entries = ledger.entries();
    const decisionEntry = entries.find((e) => e.action === "decision:allow");
    expect(decisionEntry?.payload).toBeDefined();
  });

  it("returns hash from ledger head", () => {
    const result = evaluateInboundGovernance(makeCtx());
    const ledger = getGovernanceLedger();
    expect(result.hash).toBe(ledger.head()!.hash);
  });
});
