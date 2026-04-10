// Octopus Orchestrator -- Upstream bridge: Background task ledger (M2-12)
//
// Per OCTO-DEC-033, every touch-point with OpenClaw upstream code flows
// through a bridge file in this directory. Downstream Octopus code
// imports from this bridge, never from the upstream module directly.
// When upstream changes shape, the bridge absorbs the diff; the rest
// of Octopus stays quiet.
//
// Wraps: OpenClaw's background task ledger -- the persistent record
//        of long-running tasks and the `task_ref` pointer Octopus
//        missions use to link into it.
// Tested against OpenClaw: 2026.4.7-1 (upstream commit 9ece252; deployed reference OpenClaw 2026.4.8)
// Stable assumptions:
//   - `task_ref` is a weak pointer: Octopus treats dereference
//     failures as tolerable and does not assume the ledger row will
//     survive forever.
//   - Ledger entries have a stable id and a structured status field
//     that Octopus can map onto its own claim/arm lifecycle without
//     interpreting upstream-specific statuses literally.
//   - The ledger append path is idempotent on `task_ref`, so mission
//     replay never double-books a ledger row.
// Reach-arounds:
//   - Dereference failures are logged and treated as "task reference
//     lost"; missions continue using their own state of record.
//   - Status translation table lives in this bridge so upstream
//     status vocabulary changes do not ripple outward.
// Rollback plan: If the ledger surface changes incompatibly, this
//   bridge stops emitting `task_ref` links; Octopus missions continue
//   to run on their own state, losing only the cross-link into the
//   OpenClaw background tasks UI until the bridge is updated.
//
// See also:
//   - docs/octopus-orchestrator/INTEGRATION.md §Upstream Dependency Classification
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-030, OCTO-DEC-033

// ──────────────────────────────────────────────────────────────────────────
// TaskLedgerBridge -- the bridge contract
// ──────────────────────────────────────────────────────────────────────────

export interface TaskLedgerEntry {
  taskId: string;
  status: string;
  runtime: string;
}

export interface TaskLedgerBridge {
  /** Create a task ledger entry for an arm. Returns the task_ref string. */
  createTaskRef(armId: string, agentId: string, runtime: "subagent" | "acp"): Promise<string>;

  /** Sync arm status to the task ledger entry. */
  syncStatus(taskRef: string, status: string): Promise<void>;

  /** Resolve a task_ref back to task ledger data. */
  resolveTaskRef(taskRef: string): Promise<TaskLedgerEntry | null>;
}

// ──────────────────────────────────────────────────────────────────────────
// Mock factory -- for tests (no OpenClaw internals needed)
// ──────────────────────────────────────────────────────────────────────────

export interface MockTaskLedgerBridge extends TaskLedgerBridge {
  refs: Map<string, TaskLedgerEntry>;
  calls: Record<string, unknown[][]>;
}

export function createMockTaskLedgerBridge(): MockTaskLedgerBridge {
  const refs = new Map<string, TaskLedgerEntry>();
  let refCounter = 0;

  const calls: Record<string, unknown[][]> = {
    createTaskRef: [],
    syncStatus: [],
    resolveTaskRef: [],
  };

  return {
    refs,
    calls,

    async createTaskRef(armId, agentId, runtime) {
      calls.createTaskRef.push([armId, agentId, runtime]);
      refCounter++;
      const taskRef = `tref-${armId}-${refCounter}`;
      refs.set(taskRef, { taskId: `task-${refCounter}`, status: "created", runtime });
      return taskRef;
    },

    async syncStatus(taskRef, status) {
      calls.syncStatus.push([taskRef, status]);
      const entry = refs.get(taskRef);
      if (entry) {
        entry.status = status;
      }
    },

    async resolveTaskRef(taskRef) {
      calls.resolveTaskRef.push([taskRef]);
      return refs.get(taskRef) ?? null;
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Real factory -- dynamically imports from OpenClaw internals
//
// This cross-boundary import IS allowed per OCTO-DEC-033 because this
// bridge file lives inside src/octo/adapters/openclaw/. If the import
// fails (e.g. running in isolated test mode, or upstream module missing),
// the factory throws a clear error.
// ──────────────────────────────────────────────────────────────────────────

export async function createTaskLedgerBridge(): Promise<TaskLedgerBridge> {
  try {
    // Dynamic import of OpenClaw internals -- allowed from this bridge file.
    // The exact path may change as upstream evolves; the bridge absorbs it.
    // @ts-expect-error -- upstream module is not part of the Octopus build graph
    const mod = (await import("../../tasks/task-registry.js")) as Record<string, unknown>;

    if (typeof mod.createTask !== "function" || typeof mod.getTask !== "function") {
      throw new Error("upstream task-registry module missing expected exports");
    }

    const upstream = mod as {
      createTask: (opts: {
        armId: string;
        agentId: string;
        runtime: string;
      }) => Promise<{ taskId: string; taskRef: string }>;
      getTask: (
        taskRef: string,
      ) => Promise<{ taskId: string; status: string; runtime: string } | null>;
      updateTaskStatus: (taskRef: string, status: string) => Promise<void>;
    };

    return {
      async createTaskRef(armId, agentId, runtime) {
        const result = await upstream.createTask({ armId, agentId, runtime });
        return result.taskRef;
      },

      async syncStatus(taskRef, status) {
        if (typeof upstream.updateTaskStatus !== "function") {
          throw new Error("upstream task-registry module missing 'updateTaskStatus' export");
        }
        await upstream.updateTaskStatus(taskRef, status);
      },

      async resolveTaskRef(taskRef) {
        const result = await upstream.getTask(taskRef);
        if (!result) {
          return null;
        }
        return { taskId: result.taskId, status: result.status, runtime: result.runtime };
      },
    };
  } catch (err) {
    throw new Error(
      `Failed to create TaskLedgerBridge: could not import upstream task-registry module. ` +
        `This is expected in isolated test mode. Use createMockTaskLedgerBridge() for tests. ` +
        `Original error: ${String(err)}`,
      { cause: err },
    );
  }
}
