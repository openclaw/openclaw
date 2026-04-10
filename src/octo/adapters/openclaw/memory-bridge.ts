// Octopus Orchestrator — Upstream bridge: Memory backends
//
// Per OCTO-DEC-033, every touch-point with OpenClaw upstream code flows
// through a bridge file in this directory. Downstream Octopus code
// imports from this bridge, never from the upstream module directly.
// When upstream changes shape, the bridge absorbs the diff; the rest
// of Octopus stays quiet.
//
// Wraps: OpenClaw's agent memory backends — the pluggable memory
//        subsystem an agent carries into a session.
// Tested against OpenClaw: 2026.4.7-1 (upstream commit 9ece252; deployed reference OpenClaw 2026.4.8)
// Stable assumptions:
//   - Octopus arms inherit whatever memory backend the parent agent
//     already has configured; Octopus never instantiates a backend
//     directly and never reads/writes memory state itself.
//   - The agent-to-backend binding is opaque to Octopus; we only
//     observe which tools the agent exposes, not the storage layer.
//   - Backend implementation changes (new store, new index) are
//     transparent to Octopus as long as the agent tool surface is
//     unchanged.
// Reach-arounds:
//   - Deliberate "we only read the agent's existing tools" posture:
//     never touch memory APIs directly, which means backend churn
//     cannot break this bridge unless the tool shape changes.
// Rollback plan: If the agent tool surface changes shape, this
//   bridge reports memory as unavailable for the affected arm; the
//   arm still runs, memory-dependent operations downgrade to a
//   structured "memory unavailable" result.
//
// Lifecycle: placeholder — real wrapper (if any work is needed
//   beyond passive inheritance) lands when memory-consuming
//   missions come online (see HLD §Adapter layer and INTEGRATION.md
//   §Upstream Dependency Classification).
//
// See also:
//   - docs/octopus-orchestrator/INTEGRATION.md §Upstream Dependency Classification
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-033

// ──────────────────────────────────────────────────────────────────────────
// MemoryBridge -- the bridge contract
// ──────────────────────────────────────────────────────────────────────────

export interface MemoryBridge {
  /** Return the memory backend identifier the agent has configured. */
  getMemoryBackend(agentId: string): Promise<string>;
}

// ──────────────────────────────────────────────────────────────────────────
// Mock factory -- for tests (no OpenClaw internals needed)
// ──────────────────────────────────────────────────────────────────────────

export interface MockMemoryBridge extends MemoryBridge {
  calls: Record<string, unknown[][]>;
  /** Preset backend map for test scenarios. */
  backendMap: Map<string, string>;
}

export function createMockMemoryBridge(): MockMemoryBridge {
  const backendMap = new Map<string, string>();

  const calls: Record<string, unknown[][]> = {
    getMemoryBackend: [],
  };

  return {
    calls,
    backendMap,

    async getMemoryBackend(agentId: string): Promise<string> {
      calls.getMemoryBackend.push([agentId]);
      return backendMap.get(agentId) ?? "none";
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// createMemoryBridge -- production bridge (stub)
//
// The real factory will query the upstream memory backend registry.
// For now it throws -- upstream wiring has not landed yet.
// ──────────────────────────────────────────────────────────────────────────

export async function createMemoryBridge(): Promise<MemoryBridge> {
  try {
    // Dynamic import of OpenClaw internals -- allowed from this bridge file.
    // @ts-expect-error -- upstream module is not part of the Octopus build graph
    const mod = (await import("../../memory/backends.js")) as Record<string, unknown>;

    if (typeof mod.getBackendForAgent !== "function") {
      throw new Error("upstream memory/backends module missing 'getBackendForAgent' export");
    }

    const upstream = mod as {
      getBackendForAgent: (agentId: string) => Promise<string>;
    };

    return {
      async getMemoryBackend(agentId: string): Promise<string> {
        return upstream.getBackendForAgent(agentId);
      },
    };
  } catch (err) {
    throw new Error(
      `Failed to create MemoryBridge: could not import upstream memory backends module. ` +
        `This is expected in isolated test mode. Use createMockMemoryBridge() for tests. ` +
        `Original error: ${String(err)}`,
      { cause: err },
    );
  }
}
