// Octopus Orchestrator — Upstream bridge: `hello-ok.features`
//
// Per OCTO-DEC-033, every touch-point with OpenClaw upstream code flows
// through a bridge file in this directory. Downstream Octopus code
// imports from this bridge, never from the upstream module directly.
// When upstream changes shape, the bridge absorbs the diff; the rest
// of Octopus stays quiet.
//
// Wraps: The `hello-ok.features` Gateway handshake surface — the
//        capability descriptor block where Octopus advertises
//        `features.octo` to connecting clients (see INTEGRATION.md
//        §Required Upstream Changes for the upstream PR that adds
//        the `features.octo` builder).
// Tested against OpenClaw: 2026.4.7-1 (upstream commit 9ece252; deployed reference OpenClaw 2026.4.8)
// Stable assumptions:
//   - `hello-ok.features` is an additive descriptor map; adding a
//     new top-level key (`octo`) does not disturb existing keys or
//     clients that do not know about it.
//   - Clients always check `features.octo?.enabled === true` before
//     assuming any Octopus capability exists — defensive-read
//     pattern documented in INTEGRATION.md §Upstream Change Playbook.
//   - The advertised `features.octo.methods` list aligns with the
//     upstream `server-methods-list.ts` registration point.
// Reach-arounds:
//   - Writes go through a structured wrapper so a future top-level
//     shape change in `hello-ok.features` touches only this file.
//   - Defensive reads on the client side mean any shape change that
//     drops `features.octo` simply disables Octopus cleanly rather
//     than crashing handshake consumers.
// Rollback plan: If `hello-ok.features` changes shape incompatibly,
//   this bridge stops advertising `features.octo`; clients fall back
//   to the "Octopus disabled" path (per the defensive-read pattern)
//   until the bridge is updated to match the new shape.
//
// Lifecycle: placeholder — real wrapper lands with the handshake
//   integration work in Milestone 1/2 (see HLD §Adapter layer,
//   INTEGRATION.md §First-Class Citizenship Checklist, and
//   §Upstream Dependency Classification).
//
// See also:
//   - docs/octopus-orchestrator/INTEGRATION.md §Upstream Dependency Classification
//   - docs/octopus-orchestrator/INTEGRATION.md §Upstream Change Playbook
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-033

// ──────────────────────────────────────────────────────────────────────────
// FeaturesOcto -- the shape advertised in hello-ok.features.octo
// ──────────────────────────────────────────────────────────────────────────

export interface FeaturesOcto {
  enabled: boolean;
  methods: string[];
  version: string;
}

// ──────────────────────────────────────────────────────────────────────────
// FeaturesAdvertiserBridge -- the bridge contract
// ──────────────────────────────────────────────────────────────────────────

export interface OctoConfig {
  enabled: boolean;
  methods?: string[];
  version?: string;
}

export interface FeaturesAdvertiserBridge {
  /** Build the features.octo descriptor from Octopus config. */
  advertise(octoConfig: OctoConfig): FeaturesOcto;
}

// ──────────────────────────────────────────────────────────────────────────
// Mock factory -- for tests (no OpenClaw internals needed)
// ──────────────────────────────────────────────────────────────────────────

export interface MockFeaturesAdvertiserBridge extends FeaturesAdvertiserBridge {
  calls: Record<string, unknown[][]>;
}

export function createMockFeaturesAdvertiserBridge(): MockFeaturesAdvertiserBridge {
  const calls: Record<string, unknown[][]> = {
    advertise: [],
  };

  return {
    calls,

    advertise(octoConfig: OctoConfig): FeaturesOcto {
      calls.advertise.push([octoConfig]);
      return {
        enabled: octoConfig.enabled,
        methods: octoConfig.methods ?? [],
        version: octoConfig.version ?? "0.0.0",
      };
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// createFeaturesAdvertiserBridge -- production bridge (stub)
//
// The real factory will wire into the upstream hello-ok.features builder.
// For now it throws -- the handshake integration has not landed yet.
// ──────────────────────────────────────────────────────────────────────────

export async function createFeaturesAdvertiserBridge(): Promise<FeaturesAdvertiserBridge> {
  try {
    // Dynamic import of OpenClaw internals -- allowed from this bridge file.
    // @ts-expect-error -- upstream module is not part of the Octopus build graph
    const mod = (await import("../../gateway/hello-ok.js")) as Record<string, unknown>;

    if (typeof mod.buildFeaturesOcto !== "function") {
      throw new Error("upstream hello-ok module missing 'buildFeaturesOcto' export");
    }

    const upstream = mod as {
      buildFeaturesOcto: (config: OctoConfig) => FeaturesOcto;
    };

    return {
      advertise(octoConfig: OctoConfig): FeaturesOcto {
        return upstream.buildFeaturesOcto(octoConfig);
      },
    };
  } catch (err) {
    throw new Error(
      `Failed to create FeaturesAdvertiserBridge: could not import upstream hello-ok module. ` +
        `This is expected in isolated test mode. Use createMockFeaturesAdvertiserBridge() for tests. ` +
        `Original error: ${String(err)}`,
      { cause: err },
    );
  }
}
