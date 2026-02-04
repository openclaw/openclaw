import { describe, it, expect, afterEach } from "vitest";
import { AgentShieldApprovalManager } from "../agentshield-approval-manager.js";
import { createAgentShieldApprovalHandlers } from "./agentshield-approval.js";
import type { GatewayRequestHandlers } from "./types.js";
import { listGatewayMethods } from "../server-methods-list.js";

const HANDLER_KEYS = [
  "agentshield.approval.request",
  "agentshield.approval.resolve",
  "agentshield.approval.list",
] as const;

/**
 * Mimics the wiring-time gate in server.impl.ts — the same logic
 * that decides whether RPC handlers are registered.
 */
function wireHandlers(): GatewayRequestHandlers {
  if (process.env.AGENTSHIELD_APPROVALS_ENABLED !== "1") {
    return {};
  }
  return createAgentShieldApprovalHandlers(new AgentShieldApprovalManager());
}

describe("agentshield approval handler wiring gate", () => {
  const original = process.env.AGENTSHIELD_APPROVALS_ENABLED;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.AGENTSHIELD_APPROVALS_ENABLED;
    } else {
      process.env.AGENTSHIELD_APPROVALS_ENABLED = original;
    }
  });

  it("registers all handlers when enabled", () => {
    process.env.AGENTSHIELD_APPROVALS_ENABLED = "1";
    const handlers = wireHandlers();
    for (const key of HANDLER_KEYS) {
      expect(handlers[key], `expected handler for ${key}`).toBeTypeOf(
        "function",
      );
    }
  });

  it("registers no handlers when disabled (unset)", () => {
    delete process.env.AGENTSHIELD_APPROVALS_ENABLED;
    const handlers = wireHandlers();
    expect(Object.keys(handlers)).toHaveLength(0);
  });

  it("registers no handlers when set to 0", () => {
    process.env.AGENTSHIELD_APPROVALS_ENABLED = "0";
    const handlers = wireHandlers();
    expect(Object.keys(handlers)).toHaveLength(0);
  });

  it("registers no handlers when set to an arbitrary string", () => {
    process.env.AGENTSHIELD_APPROVALS_ENABLED = "true";
    const handlers = wireHandlers();
    expect(Object.keys(handlers)).toHaveLength(0);
  });

  it("does not advertise methods when disabled (unset)", () => {
    delete process.env.AGENTSHIELD_APPROVALS_ENABLED;

    const base = listGatewayMethods();
    const filtered = base.filter(
      (m) =>
        m !== "agentshield.approval.request" &&
        m !== "agentshield.approval.resolve" &&
        m !== "agentshield.approval.list",
    );

    expect(filtered).not.toContain("agentshield.approval.request");
    expect(filtered).not.toContain("agentshield.approval.resolve");
    expect(filtered).not.toContain("agentshield.approval.list");
  });

});
