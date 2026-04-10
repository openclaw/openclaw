// Octopus Orchestrator -- Chaos test: operator without octo.writer rejected (M5-08)
//
// Scope: unit test of the CONCEPT of writer-capability gating. The actual
// enforcement lives at the Gateway dispatch layer (M0-24 PR). This test
// validates the gating logic and rejection-event shape in isolation --
// no running Gateway, no real dispatch.
//
// Boundary discipline (OCTO-DEC-033): only node:* builtins, vitest, and
// relative imports inside src/octo/. No external dependencies.

import { describe, expect, it } from "vitest";

// ──────────────────────────────────────────────────────────────────────────
// Capability check (self-contained -- mirrors Gateway dispatch gating)
// ──────────────────────────────────────────────────────────────────────────

const WRITER_SCOPE = "operator.octo.writer";

function checkWriterCapability(operatorScopes: readonly string[]): boolean {
  return operatorScopes.includes(WRITER_SCOPE);
}

// ──────────────────────────────────────────────────────────────────────────
// Rejection audit event structure
// ──────────────────────────────────────────────────────────────────────────

interface OperatorRejectedEvent {
  readonly kind: "operator.rejected";
  readonly ts: number;
  readonly operatorId: string;
  readonly action: string;
  readonly requiredScope: string;
  readonly presentScopes: readonly string[];
  readonly reason: string;
}

function buildRejectionEvent(
  operatorId: string,
  action: string,
  presentScopes: readonly string[],
): OperatorRejectedEvent {
  return {
    kind: "operator.rejected",
    ts: Date.now(),
    operatorId,
    action,
    requiredScope: WRITER_SCOPE,
    presentScopes,
    reason: `operator ${operatorId} lacks ${WRITER_SCOPE} for ${action}`,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe("Chaos: operator without octo.writer capability", () => {
  const SIDE_EFFECTING_ACTIONS = ["arm.spawn", "arm.terminate", "mission.abort"] as const;

  it("allows operator with octo.writer scope", () => {
    const scopes = ["operator.octo.reader", WRITER_SCOPE];
    expect(checkWriterCapability(scopes)).toBe(true);
  });

  it("rejects operator without octo.writer scope", () => {
    const scopes = ["operator.octo.reader"];
    expect(checkWriterCapability(scopes)).toBe(false);
  });

  it("rejects operator with empty scopes", () => {
    expect(checkWriterCapability([])).toBe(false);
  });

  it("rejection event has correct shape for each side-effecting action", () => {
    const operatorId = "op-chaos-test-42";
    const scopes = ["operator.octo.reader"] as const;

    for (const action of SIDE_EFFECTING_ACTIONS) {
      const event = buildRejectionEvent(operatorId, action, scopes);

      expect(event.kind).toBe("operator.rejected");
      expect(typeof event.ts).toBe("number");
      expect(event.operatorId).toBe(operatorId);
      expect(event.action).toBe(action);
      expect(event.requiredScope).toBe(WRITER_SCOPE);
      expect(event.presentScopes).toEqual(scopes);
      expect(event.reason).toContain(operatorId);
      expect(event.reason).toContain(WRITER_SCOPE);
      expect(event.reason).toContain(action);
    }
  });
});
