// Octopus Orchestrator — Upstream bridge: Skills loader
//
// Per OCTO-DEC-033, every touch-point with OpenClaw upstream code flows
// through a bridge file in this directory. Downstream Octopus code
// imports from this bridge, never from the upstream module directly.
// When upstream changes shape, the bridge absorbs the diff; the rest
// of Octopus stays quiet.
//
// Wraps: The OpenClaw skills loader — the subsystem that resolves
//        an agent's inherited skills from persona config, project
//        config, and user config.
// Tested against OpenClaw: 2026.4.7-1 (upstream commit 9ece252; deployed reference OpenClaw 2026.4.8)
// Stable assumptions:
//   - Skills resolve via inheritance only; Octopus never rewrites
//     the skill allowlist directly. An arm inherits exactly what the
//     agent it was spawned from would have inherited.
//   - The loader returns a deterministic, ordered list for a given
//     agent identity, so the same arm gets the same skills on every
//     spawn.
//   - Skill identifiers are stable strings; renames happen at major
//     version bumps and are surfaced by the compatibility matrix.
// Reach-arounds:
//   - Inheritance-only posture: Octopus never adds to or removes from
//     the resolved skill set, so any future loader refactor that
//     tightens allowlist semantics cannot break us via privilege
//     escalation.
// Rollback plan: If the skills loader surface changes incompatibly,
//   arms fall back to an empty skills set and the mission logs a
//   structured warning; the agent still runs, just without skills
//   until the bridge is updated.
//
// Lifecycle: placeholder — real wrapper lands with the first
//   adapter that needs to resolve an arm's skills (see HLD
//   §Adapter layer and INTEGRATION.md §Upstream Dependency
//   Classification).
//
// See also:
//   - docs/octopus-orchestrator/INTEGRATION.md §Upstream Dependency Classification
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-033

// ──────────────────────────────────────────────────────────────────────────
// SkillsLoaderBridge -- the bridge contract
// ──────────────────────────────────────────────────────────────────────────

export interface SkillsLoaderBridge {
  /** Load the list of skill identifiers an arm inherits from its agent. */
  loadSkillsForArm(agentId: string): Promise<string[]>;
}

// ──────────────────────────────────────────────────────────────────────────
// Mock factory -- for tests (no OpenClaw internals needed)
// ──────────────────────────────────────────────────────────────────────────

export interface MockSkillsLoaderBridge extends SkillsLoaderBridge {
  calls: Record<string, unknown[][]>;
  /** Preset skills map for test scenarios. */
  skillsMap: Map<string, string[]>;
}

export function createMockSkillsLoaderBridge(): MockSkillsLoaderBridge {
  const skillsMap = new Map<string, string[]>();

  const calls: Record<string, unknown[][]> = {
    loadSkillsForArm: [],
  };

  return {
    calls,
    skillsMap,

    async loadSkillsForArm(agentId: string): Promise<string[]> {
      calls.loadSkillsForArm.push([agentId]);
      return skillsMap.get(agentId) ?? [];
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// createSkillsLoaderBridge -- production bridge (stub)
//
// The real factory will wrap the upstream skills resolver.
// For now it throws -- upstream wiring has not landed yet.
// ──────────────────────────────────────────────────────────────────────────

export async function createSkillsLoaderBridge(): Promise<SkillsLoaderBridge> {
  try {
    // Dynamic import of OpenClaw internals -- allowed from this bridge file.
    // @ts-expect-error -- upstream module is not part of the Octopus build graph
    const mod = (await import("../../skills/loader.js")) as Record<string, unknown>;

    if (typeof mod.loadSkills !== "function") {
      throw new Error("upstream skills/loader module missing 'loadSkills' export");
    }

    const upstream = mod as {
      loadSkills: (agentId: string) => Promise<string[]>;
    };

    return {
      async loadSkillsForArm(agentId: string): Promise<string[]> {
        return upstream.loadSkills(agentId);
      },
    };
  } catch (err) {
    throw new Error(
      `Failed to create SkillsLoaderBridge: could not import upstream skills loader module. ` +
        `This is expected in isolated test mode. Use createMockSkillsLoaderBridge() for tests. ` +
        `Original error: ${String(err)}`,
      { cause: err },
    );
  }
}
