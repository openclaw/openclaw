// Octopus Orchestrator — Upstream bridge: Presence layer
//
// Per OCTO-DEC-033, every touch-point with OpenClaw upstream code flows
// through a bridge file in this directory. Downstream Octopus code
// imports from this bridge, never from the upstream module directly.
// When upstream changes shape, the bridge absorbs the diff; the rest
// of Octopus stays quiet.
//
// Wraps: OpenClaw's presence layer — the subsystem that broadcasts
//        "who/what is active" signals. Classified as "unstable" in
//        INTEGRATION.md §Upstream Dependency Classification.
// Tested against OpenClaw: 2026.4.7-1 (upstream commit 9ece252; deployed reference OpenClaw 2026.4.8)
// Stable assumptions:
//   - Emission is strictly one-way: Octopus publishes presence
//     events, never depends on reading them back.
//   - Presence absence is tolerable: if the upstream layer is
//     missing, renamed, or disabled, Octopus continues to run and
//     only the "who is active" UI feature goes dark.
//   - The publish API is fire-and-forget; failures do not block
//     mission progress.
// Reach-arounds:
//   - One-way emission is the reach-around: by never depending on
//     the return shape or the read side, we are insulated from most
//     upstream churn in this unstable surface.
//   - Publish calls are wrapped in a try/catch at this bridge so
//     presence breakage never propagates into the mission loop.
// Rollback plan: If the presence layer changes incompatibly, this
//   bridge becomes a no-op publisher; the presence feature disables
//   cleanly (a cosmetic regression, not a functional one) until the
//   bridge is updated.
//
// Lifecycle: placeholder — real wrapper lands when presence
//   emission is wired in Milestone 2 (see HLD §Adapter layer,
//   INTEGRATION.md §First-Class Citizenship Checklist, and
//   §Upstream Dependency Classification).
//
// See also:
//   - docs/octopus-orchestrator/INTEGRATION.md §Upstream Dependency Classification
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-033

// ──────────────────────────────────────────────────────────────────────────
// PresenceBridge -- the bridge contract
// ──────────────────────────────────────────────────────────────────────────

export type ArmPresenceState = "active" | "idle" | "finished" | "failed";

export interface PresenceBridge {
  /** Emit a presence state change for an arm. Fire-and-forget. */
  emitPresence(armId: string, state: ArmPresenceState): void;
}

// ──────────────────────────────────────────────────────────────────────────
// Mock factory -- for tests (no OpenClaw internals needed)
// ──────────────────────────────────────────────────────────────────────────

export interface MockPresenceBridge extends PresenceBridge {
  calls: Record<string, unknown[][]>;
}

export function createMockPresenceBridge(): MockPresenceBridge {
  const calls: Record<string, unknown[][]> = {
    emitPresence: [],
  };

  return {
    calls,

    emitPresence(armId: string, state: ArmPresenceState): void {
      calls.emitPresence.push([armId, state]);
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// createPresenceBridge -- production bridge (stub)
//
// The real factory will wrap the upstream presence publisher.
// For now it throws -- upstream wiring has not landed yet.
// Presence is classified as "unstable" so the real bridge will wrap
// calls in try/catch to prevent presence failures from breaking missions.
// ──────────────────────────────────────────────────────────────────────────

export async function createPresenceBridge(): Promise<PresenceBridge> {
  try {
    // Dynamic import of OpenClaw internals -- allowed from this bridge file.
    // @ts-expect-error -- upstream module is not part of the Octopus build graph
    const mod = (await import("../../presence/publisher.js")) as Record<string, unknown>;

    if (typeof mod.emitPresence !== "function") {
      throw new Error("upstream presence/publisher module missing 'emitPresence' export");
    }

    const upstream = mod as {
      emitPresence: (id: string, state: string) => void;
    };

    return {
      emitPresence(armId: string, state: ArmPresenceState): void {
        try {
          upstream.emitPresence(armId, state);
        } catch {
          // Presence is fire-and-forget; swallow errors per rollback plan.
        }
      },
    };
  } catch (err) {
    throw new Error(
      `Failed to create PresenceBridge: could not import upstream presence publisher module. ` +
        `This is expected in isolated test mode. Use createMockPresenceBridge() for tests. ` +
        `Original error: ${String(err)}`,
      { cause: err },
    );
  }
}
