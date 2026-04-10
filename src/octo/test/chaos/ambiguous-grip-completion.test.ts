// Octopus Orchestrator -- Chaos test: ambiguous duplicate grip completion (M3-15)
//
// Constructs a scenario where two arms complete the same grip, then exercises
// the ambiguous-resolver interface. Since M3-12's ambiguous-resolver.ts may
// not exist yet (parallel agent race), this file defines a local stub of the
// LLD SS5 seed design interface. If ambiguous-resolver.ts lands later, these
// tests should be updated to import from it.
//
// Tests:
//   1. Side-effecting grip: both results quarantined, operator prompted, no auto-merge
//   2. Read-only grip: auto-resolved by lowest arm_id
//   3. After resolve: selected result kept, other discarded
//
// Boundary discipline (OCTO-DEC-033): only node:* builtins and relative
// imports inside src/octo/.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLogService } from "../../head/event-log.ts";
import { type GripInput, RegistryService } from "../../head/registry.ts";
import { closeOctoRegistry, openOctoRegistry } from "../../head/storage/migrate.ts";
import type { GripSpec } from "../../wire/schema.ts";

// ══════════════════════════════════════════════════════════════════════════
// Ambiguous-resolver stub (LLD SS5 seed design interface)
//
// This stub is defined locally because M3-12 (ambiguous-resolver.ts) may
// be running in parallel and not yet committed. The interface contract
// follows the LLD SS5 ambiguous-grip resolution design:
//
//   - onGripAmbiguous(gripId, armA, armB, refA, refB) is called when the
//     scheduler detects two arms completed the same grip.
//   - For side-effecting grips: both results are quarantined and an
//     OperatorPrompt is returned (no auto-merge).
//   - For read-only grips: auto-resolved by lowest arm_id (deterministic
//     tiebreak), selected result kept, other discarded.
//   - resolve(gripId, selectedArmId) finalises the resolution.
// ══════════════════════════════════════════════════════════════════════════

interface AmbiguousResult {
  arm_id: string;
  result_ref: string;
}

type ResolutionOutcome =
  | { kind: "quarantined"; operator_prompt: OperatorPrompt }
  | { kind: "auto_resolved"; selected: AmbiguousResult; discarded: AmbiguousResult };

interface OperatorPrompt {
  grip_id: string;
  candidates: readonly AmbiguousResult[];
  reason: string;
}

interface ResolveOutcome {
  grip_id: string;
  selected: AmbiguousResult;
  discarded: AmbiguousResult;
}

/**
 * Minimal stub implementing the LLD SS5 ambiguous-resolver interface.
 * Operates against a RegistryService and EventLogService for state
 * queries. Does NOT mutate registry state -- callers apply the outcome.
 */
class AmbiguousResolverStub {
  private readonly registry: RegistryService;
  private readonly quarantined: Map<string, { a: AmbiguousResult; b: AmbiguousResult }> = new Map();

  constructor(deps: { registry: RegistryService; eventLog: EventLogService }) {
    this.registry = deps.registry;
  }

  onGripAmbiguous(
    gripId: string,
    armA: string,
    armB: string,
    refA: string,
    refB: string,
  ): ResolutionOutcome {
    const grip = this.registry.getGrip(gripId);
    if (!grip) {
      throw new Error(`AmbiguousResolver: grip ${gripId} not found`);
    }

    const candidateA: AmbiguousResult = { arm_id: armA, result_ref: refA };
    const candidateB: AmbiguousResult = { arm_id: armB, result_ref: refB };

    if (grip.side_effecting) {
      // Side-effecting: quarantine both, require operator intervention
      this.quarantined.set(gripId, { a: candidateA, b: candidateB });
      return {
        kind: "quarantined",
        operator_prompt: {
          grip_id: gripId,
          candidates: [candidateA, candidateB],
          reason: "side_effecting_grip_ambiguous_completion",
        },
      };
    }

    // Read-only: deterministic tiebreak by lowest arm_id (lexicographic)
    const [selected, discarded] = armA < armB ? [candidateA, candidateB] : [candidateB, candidateA];
    return { kind: "auto_resolved", selected, discarded };
  }

  resolve(gripId: string, selectedArmId: string): ResolveOutcome {
    const entry = this.quarantined.get(gripId);
    if (!entry) {
      throw new Error(`AmbiguousResolver: no quarantined entry for grip ${gripId}`);
    }

    const selected = entry.a.arm_id === selectedArmId ? entry.a : entry.b;
    const discarded = entry.a.arm_id === selectedArmId ? entry.b : entry.a;
    this.quarantined.delete(gripId);
    return { grip_id: gripId, selected, discarded };
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Test harness
// ══════════════════════════════════════════════════════════════════════════

let tempDir: string;
let db: DatabaseSync;
let registry: RegistryService;
let eventLog: EventLogService;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "octo-chaos-m3-15-"));
  const dbPath = path.join(tempDir, "registry.sqlite");
  db = openOctoRegistry({ path: dbPath });
  registry = new RegistryService(db);
  eventLog = new EventLogService({ path: path.join(tempDir, "events.jsonl") });
});

afterEach(() => {
  closeOctoRegistry(db);
  rmSync(tempDir, { recursive: true, force: true });
});

function makeGripSpec(overrides: Partial<GripSpec> = {}): GripSpec {
  return {
    spec_version: 1,
    mission_id: "mission-ambig-1",
    type: "code-edit",
    retry_policy: {
      max_attempts: 3,
      backoff: "exponential",
      initial_delay_s: 1,
      max_delay_s: 60,
      multiplier: 2,
      retry_on: ["transient", "timeout"],
      abandon_on: ["unrecoverable"],
    },
    timeout_s: 300,
    side_effecting: false,
    ...overrides,
  };
}

function makeGripInput(overrides: Partial<GripInput> = {}): GripInput {
  return {
    grip_id: `grip-${Math.random().toString(36).slice(2, 10)}`,
    mission_id: "mission-ambig-1",
    type: "code-edit",
    input_ref: null,
    priority: 0,
    assigned_arm_id: null,
    status: "running",
    timeout_s: 300,
    side_effecting: false,
    idempotency_key: null,
    result_ref: null,
    spec: makeGripSpec(),
    ...overrides,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// Tests
// ══════════════════════════════════════════════════════════════════════════

describe("Chaos: ambiguous duplicate grip completion (M3-15)", () => {
  it("quarantines both results and prompts operator for side-effecting grip", () => {
    // Insert a side-effecting grip in running state assigned to arm-A
    const grip = registry.putGrip(
      makeGripInput({
        grip_id: "grip-se-001",
        assigned_arm_id: "arm-A",
        status: "running",
        side_effecting: true,
        idempotency_key: "idem-se-001",
        spec: makeGripSpec({ side_effecting: true, idempotency_key: "idem-se-001" }),
      }),
    );

    const resolver = new AmbiguousResolverStub({ registry, eventLog });
    const outcome = resolver.onGripAmbiguous(
      grip.grip_id,
      "arm-A",
      "arm-B",
      "ref-result-A",
      "ref-result-B",
    );

    // Both results quarantined, operator prompted, no auto-merge
    expect(outcome.kind).toBe("quarantined");
    if (outcome.kind === "quarantined") {
      expect(outcome.operator_prompt.grip_id).toBe("grip-se-001");
      expect(outcome.operator_prompt.candidates).toHaveLength(2);
      expect(outcome.operator_prompt.reason).toContain("side_effecting");

      // Verify both arms are represented
      const armIds = outcome.operator_prompt.candidates.map((c) => c.arm_id);
      expect(armIds).toContain("arm-A");
      expect(armIds).toContain("arm-B");
    }
  });

  it("auto-resolves read-only grip by lowest arm_id", () => {
    // Insert a read-only grip in running state
    const grip = registry.putGrip(
      makeGripInput({
        grip_id: "grip-ro-001",
        assigned_arm_id: "arm-Z",
        status: "running",
        side_effecting: false,
        spec: makeGripSpec({ side_effecting: false }),
      }),
    );

    const resolver = new AmbiguousResolverStub({ registry, eventLog });

    // arm-Z completed first, then arm-A also completed (lower id wins)
    const outcome = resolver.onGripAmbiguous(
      grip.grip_id,
      "arm-Z",
      "arm-A",
      "ref-result-Z",
      "ref-result-A",
    );

    expect(outcome.kind).toBe("auto_resolved");
    if (outcome.kind === "auto_resolved") {
      // Lowest arm_id ("arm-A") wins
      expect(outcome.selected.arm_id).toBe("arm-A");
      expect(outcome.selected.result_ref).toBe("ref-result-A");
      expect(outcome.discarded.arm_id).toBe("arm-Z");
      expect(outcome.discarded.result_ref).toBe("ref-result-Z");
    }
  });

  it("after resolve: selected result kept, other discarded", () => {
    // Insert a side-effecting grip so it gets quarantined first
    const grip = registry.putGrip(
      makeGripInput({
        grip_id: "grip-resolve-001",
        assigned_arm_id: "arm-X",
        status: "running",
        side_effecting: true,
        idempotency_key: "idem-resolve-001",
        spec: makeGripSpec({ side_effecting: true, idempotency_key: "idem-resolve-001" }),
      }),
    );

    const resolver = new AmbiguousResolverStub({ registry, eventLog });

    // Trigger quarantine
    const quarantineOutcome = resolver.onGripAmbiguous(
      grip.grip_id,
      "arm-X",
      "arm-Y",
      "ref-result-X",
      "ref-result-Y",
    );
    expect(quarantineOutcome.kind).toBe("quarantined");

    // Operator selects arm-Y's result
    const resolveOutcome = resolver.resolve(grip.grip_id, "arm-Y");

    expect(resolveOutcome.grip_id).toBe("grip-resolve-001");
    expect(resolveOutcome.selected.arm_id).toBe("arm-Y");
    expect(resolveOutcome.selected.result_ref).toBe("ref-result-Y");
    expect(resolveOutcome.discarded.arm_id).toBe("arm-X");
    expect(resolveOutcome.discarded.result_ref).toBe("ref-result-X");

    // Apply the resolution to the registry: update grip with selected result
    const updated = registry.casUpdateGrip(grip.grip_id, grip.version, {
      result_ref: resolveOutcome.selected.result_ref,
      assigned_arm_id: resolveOutcome.selected.arm_id,
    });

    expect(updated.result_ref).toBe("ref-result-Y");
    expect(updated.assigned_arm_id).toBe("arm-Y");

    // Verify the discarded result is not in the registry
    const final = registry.getGrip(grip.grip_id);
    expect(final).not.toBeNull();
    expect(final!.result_ref).toBe("ref-result-Y");
    expect(final!.assigned_arm_id).toBe("arm-Y");
  });

  it("resolve throws when no quarantined entry exists", () => {
    const resolver = new AmbiguousResolverStub({ registry, eventLog });

    expect(() => resolver.resolve("grip-nonexistent", "arm-A")).toThrowError(
      /no quarantined entry/,
    );
  });
});
