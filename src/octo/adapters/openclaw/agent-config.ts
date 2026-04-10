// Octopus Orchestrator — Upstream bridge: `openclaw.json` top-level schema
//
// Per OCTO-DEC-033, every touch-point with OpenClaw upstream code flows
// through a bridge file in this directory. Downstream Octopus code
// imports from this bridge, never from the upstream module directly.
// When upstream changes shape, the bridge absorbs the diff; the rest
// of Octopus stays quiet.
//
// Wraps: The `openclaw.json` top-level config schema and the upstream
//        config loader for the `octo:` block (see INTEGRATION.md
//        §Required Upstream Changes — `octo.enabled` config loader
//        key) plus agent persona/configuration inheritance.
// Tested against OpenClaw: 2026.4.7-1 (upstream commit 9ece252; deployed reference OpenClaw 2026.4.8)
// Stable assumptions:
//   - The `openclaw.json` top-level schema is classified "stable" in
//     INTEGRATION.md; new blocks can be added without disturbing
//     existing consumers.
//   - The Octopus `octo:` block is self-contained — no other
//     subsystem reaches into it and no upstream key collides with it.
//   - Agent persona fields (name, system prompt, tool allowlist,
//     skills list) are readable from the config without running the
//     full agent runtime.
// Reach-arounds:
//   - None currently; the config surface is stable and the octo block
//     is owned entirely by Octopus.
// Rollback plan: If `openclaw.json` schema changes incompatibly, this
//   bridge reports a structured config error and Octopus refuses to
//   enable, logging the minimum required upstream version (per
//   OCTO-DEC-034); the rest of OpenClaw keeps running normally.
//
// Lifecycle: placeholder — real wrapper lands with `octo-config.ts`
//   integration in Milestone 0/1 (see HLD §Adapter layer and
//   INTEGRATION.md §Upstream Dependency Classification).
//
// See also:
//   - docs/octopus-orchestrator/INTEGRATION.md §Upstream Dependency Classification
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-033

// ──────────────────────────────────────────────────────────────────────────
// AgentConfigBridge -- the bridge contract
// ──────────────────────────────────────────────────────────────────────────

export interface AgentConfigBridge {
  /** Load the agent's full config for arm inheritance. */
  loadAgentConfig(agentId: string): Promise<Record<string, unknown>>;
}

// ──────────────────────────────────────────────────────────────────────────
// Mock factory -- for tests (no OpenClaw internals needed)
// ──────────────────────────────────────────────────────────────────────────

export interface MockAgentConfigBridge extends AgentConfigBridge {
  calls: Record<string, unknown[][]>;
  /** Preset config map for test scenarios. */
  configMap: Map<string, Record<string, unknown>>;
}

export function createMockAgentConfigBridge(): MockAgentConfigBridge {
  const configMap = new Map<string, Record<string, unknown>>();

  const calls: Record<string, unknown[][]> = {
    loadAgentConfig: [],
  };

  return {
    calls,
    configMap,

    async loadAgentConfig(agentId: string): Promise<Record<string, unknown>> {
      calls.loadAgentConfig.push([agentId]);
      return configMap.get(agentId) ?? {};
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// createAgentConfigBridge -- production bridge (stub)
//
// The real factory will wrap the upstream openclaw.json config loader.
// For now it throws -- upstream wiring has not landed yet.
// ──────────────────────────────────────────────────────────────────────────

export async function createAgentConfigBridge(): Promise<AgentConfigBridge> {
  try {
    // Dynamic import of OpenClaw internals -- allowed from this bridge file.
    // @ts-expect-error -- upstream module is not part of the Octopus build graph
    const mod = (await import("../../config/agent-loader.js")) as Record<string, unknown>;

    if (typeof mod.loadAgentConfig !== "function") {
      throw new Error("upstream config/agent-loader module missing 'loadAgentConfig' export");
    }

    const upstream = mod as {
      loadAgentConfig: (agentId: string) => Promise<Record<string, unknown>>;
    };

    return {
      async loadAgentConfig(agentId: string): Promise<Record<string, unknown>> {
        return upstream.loadAgentConfig(agentId);
      },
    };
  } catch (err) {
    throw new Error(
      `Failed to create AgentConfigBridge: could not import upstream agent config loader module. ` +
        `This is expected in isolated test mode. Use createMockAgentConfigBridge() for tests. ` +
        `Original error: ${String(err)}`,
      { cause: err },
    );
  }
}
