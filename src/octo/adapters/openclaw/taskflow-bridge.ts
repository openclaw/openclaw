// Octopus Orchestrator — Upstream bridge: Task Flow schema
//
// Per OCTO-DEC-033, every touch-point with OpenClaw upstream code flows
// through a bridge file in this directory. Downstream Octopus code
// imports from this bridge, never from the upstream module directly.
// When upstream changes shape, the bridge absorbs the diff; the rest
// of Octopus stays quiet.
//
// Wraps: The OpenClaw Task Flow schema and step-type registration
//        surface — used for mirrored-mode flow records per mission.
//        This is the file the `clawflow` → `taskflow` rename in
//        INTEGRATION.md §Upstream Change Playbook walks through.
// Tested against OpenClaw: 2026.4.7-1 (upstream commit 9ece252; deployed reference OpenClaw 2026.4.8)
// Stable assumptions:
//   - Mirrored mode is strictly observer-only: Octopus writes flow
//     records describing missions it is running, but never depends
//     on Task Flow for mission state of record.
//   - The `octo.mission` step type can be registered via the
//     documented step-type registration point (INTEGRATION.md
//     §Required Upstream Changes) additively.
//   - Task Flow is addressed through its documented CLI verbs
//     (`openclaw tasks flow ...`), not module paths, so module-level
//     renames are absorbed here.
// Reach-arounds:
//   - CLI-verb addressing (not module paths) is the explicit
//     reach-around that survived the `clawflow` → `taskflow` rename
//     as documented in INTEGRATION.md §Upstream Change Playbook.
//   - Transitional compatibility shims (if any) for upstream renames
//     live only in this file and are time-bounded — removed after
//     two Octopus releases, per INTEGRATION.md.
// Rollback plan: If Task Flow breaks shape, mirrored mode degrades
//   to no flow records written; missions continue to run on their
//   own state of record, the only loss is visibility in the Task
//   Flow UI until the bridge is updated.
//
// Lifecycle: placeholder — real wrapper lands when mirrored mode
//   work begins in Milestone 2 (see HLD §Adapter layer and
//   INTEGRATION.md §First-Class Citizenship Checklist).
//
// See also:
//   - docs/octopus-orchestrator/INTEGRATION.md §Upstream Dependency Classification
//   - docs/octopus-orchestrator/INTEGRATION.md §Upstream Change Playbook
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-033

// ──────────────────────────────────────────────────────────────────────────
// FlowStep -- the shape of a single step update (per OCTO-DEC-030)
// ──────────────────────────────────────────────────────────────────────────

export interface FlowStep {
  name: string;
  status: "pending" | "running" | "done" | "failed";
  detail?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// TaskflowBridge -- the bridge contract
// ──────────────────────────────────────────────────────────────────────────

export interface TaskflowBridge {
  /** Create a mirrored flow record for a mission. Returns the flow ID. */
  createMirroredFlow(missionId: string): Promise<string>;

  /** Update a step within a mirrored flow. */
  updateFlowStep(flowId: string, step: FlowStep): Promise<void>;
}

// ──────────────────────────────────────────────────────────────────────────
// Mock factory -- for tests (no OpenClaw internals needed)
// ──────────────────────────────────────────────────────────────────────────

export interface MockTaskflowBridge extends TaskflowBridge {
  calls: Record<string, unknown[][]>;
  /** Map of flowId -> steps for inspection. */
  flowSteps: Map<string, FlowStep[]>;
}

export function createMockTaskflowBridge(): MockTaskflowBridge {
  let flowCounter = 0;
  const flowSteps = new Map<string, FlowStep[]>();

  const calls: Record<string, unknown[][]> = {
    createMirroredFlow: [],
    updateFlowStep: [],
  };

  return {
    calls,
    flowSteps,

    async createMirroredFlow(missionId: string): Promise<string> {
      calls.createMirroredFlow.push([missionId]);
      flowCounter++;
      const flowId = `flow-${flowCounter}`;
      flowSteps.set(flowId, []);
      return flowId;
    },

    async updateFlowStep(flowId: string, step: FlowStep): Promise<void> {
      calls.updateFlowStep.push([flowId, step]);
      const steps = flowSteps.get(flowId);
      if (steps) {
        steps.push(step);
      }
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// createTaskflowBridge -- production bridge (stub)
//
// The real factory will wrap the upstream Task Flow schema surface.
// For now it throws -- mirrored mode has not landed yet.
// ──────────────────────────────────────────────────────────────────────────

export async function createTaskflowBridge(): Promise<TaskflowBridge> {
  try {
    // Dynamic import of OpenClaw internals -- allowed from this bridge file.
    // @ts-expect-error -- upstream module is not part of the Octopus build graph
    const mod = (await import("../../taskflow/flows.js")) as Record<string, unknown>;

    if (typeof mod.createFlow !== "function") {
      throw new Error("upstream taskflow/flows module missing 'createFlow' export");
    }

    const upstream = mod as {
      createFlow: (missionId: string) => Promise<string>;
      updateStep?: (flowId: string, step: FlowStep) => Promise<void>;
    };

    return {
      async createMirroredFlow(missionId: string): Promise<string> {
        return upstream.createFlow(missionId);
      },

      async updateFlowStep(flowId: string, step: FlowStep): Promise<void> {
        if (!upstream.updateStep) {
          throw new Error("upstream taskflow/flows module missing 'updateStep' export");
        }
        return upstream.updateStep(flowId, step);
      },
    };
  } catch (err) {
    throw new Error(
      `Failed to create TaskflowBridge: could not import upstream taskflow module. ` +
        `This is expected in isolated test mode. Use createMockTaskflowBridge() for tests. ` +
        `Original error: ${String(err)}`,
      { cause: err },
    );
  }
}
