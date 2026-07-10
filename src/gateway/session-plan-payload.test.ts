// Seam test: the plan-mode slot flows through the session event payload the Control-UI reads.
import { describe, expect, it } from "vitest";
import type { SessionPlanState } from "../config/sessions/types.js";
import { buildGatewaySessionEventFields } from "./session-event-payload.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

function rowWith(plan?: SessionPlanState | null): GatewaySessionRow {
  return {
    key: "agent:main:web:main",
    sessionId: "s1",
    updatedAt: 1,
    ...(plan !== undefined ? { plan } : {}),
  } as unknown as GatewaySessionRow;
}

describe("session event payload plan exposure", () => {
  it("includes the plan slot when the session is in plan mode", () => {
    const plan: SessionPlanState = {
      schemaVersion: 1,
      status: "pending_approval",
      enteredAt: 1,
      updatedAt: 2,
      lastSummary: "ship it",
    };
    const fields = buildGatewaySessionEventFields({ sessionRow: rowWith(plan) });
    expect(fields.plan).toEqual(plan);
  });

  it("emits an explicit null plan when inactive so clients drop the chip on merge", () => {
    const fields = buildGatewaySessionEventFields({ sessionRow: rowWith(null) });
    expect(fields.plan).toBeNull();
    const fieldsNoSlot = buildGatewaySessionEventFields({ sessionRow: rowWith(undefined) });
    expect(fieldsNoSlot.plan).toBeNull();
  });
});
