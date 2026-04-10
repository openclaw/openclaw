// Octopus Orchestrator -- Upstream bridge: sessions-spawn (M2-10)
//
// Per OCTO-DEC-033, every touch-point with OpenClaw upstream code flows
// through a bridge file in this directory. Downstream Octopus code
// imports from this bridge, never from the upstream module directly.
// When upstream changes shape, the bridge absorbs the diff; the rest
// of Octopus stays quiet.
//
// Wraps: The upstream `sessions_spawn` entrypoint used to launch
//        subagent runtimes (OpenClaw's native subagent spawner).
//
// See also:
//   - docs/octopus-orchestrator/INTEGRATION.md, Upstream Dependency Classification
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-033

// ──────────────────────────────────────────────────────────────────────────
// SessionsSpawnBridge -- the bridge contract
// ──────────────────────────────────────────────────────────────────────────

export interface SessionsSpawnBridge {
  spawn(opts: {
    agentId: string;
    runtime?: string;
    model?: string;
    deliver?: boolean;
  }): Promise<{ runId: string; sessionKey: string }>;

  cancel(sessionKey: string): Promise<void>;

  getHistory(sessionKey: string): Promise<{ messages: unknown[] }>;

  isAlive(sessionKey: string): Promise<boolean>;
}

// ──────────────────────────────────────────────────────────────────────────
// Mock factory -- for tests (no OpenClaw internals needed)
// ──────────────────────────────────────────────────────────────────────────

export interface MockSessionsSpawnBridge extends SessionsSpawnBridge {
  calls: Record<string, unknown[][]>;
  /** Map of sessionKey -> alive status. Defaults to true on spawn. */
  aliveMap: Map<string, boolean>;
}

export function createMockSessionsSpawnBridge(): MockSessionsSpawnBridge {
  const aliveMap = new Map<string, boolean>();
  let runCounter = 0;

  const calls: Record<string, unknown[][]> = {
    spawn: [],
    cancel: [],
    getHistory: [],
    isAlive: [],
  };

  return {
    calls,
    aliveMap,

    async spawn(opts) {
      calls.spawn.push([opts]);
      runCounter++;
      const runId = `run-${runCounter}`;
      const sessionKey = `sk-${runCounter}`;
      aliveMap.set(sessionKey, true);
      return { runId, sessionKey };
    },

    async cancel(sessionKey) {
      calls.cancel.push([sessionKey]);
      aliveMap.set(sessionKey, false);
    },

    async getHistory(sessionKey) {
      calls.getHistory.push([sessionKey]);
      return { messages: [] };
    },

    async isAlive(sessionKey) {
      calls.isAlive.push([sessionKey]);
      return aliveMap.get(sessionKey) ?? false;
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

export async function createSessionsSpawnBridge(): Promise<SessionsSpawnBridge> {
  try {
    // Dynamic import of OpenClaw internals -- allowed from this bridge file.
    // The exact path may change as upstream evolves; the bridge absorbs it.
    // The module may not exist at compile time (e.g. in isolated test or CI
    // builds); the catch block handles that gracefully.
    // @ts-expect-error -- upstream module is not part of the Octopus build graph
    const mod = (await import("../../gateway/sessions-spawn.js")) as Record<string, unknown>;

    // Validate that the expected exports exist
    if (typeof mod.spawn !== "function") {
      throw new Error("upstream sessions-spawn module missing 'spawn' export");
    }

    // Wrap upstream functions into the bridge contract
    const upstream = mod as {
      spawn: (opts: Record<string, unknown>) => Promise<{ runId: string; sessionKey: string }>;
      cancel?: (sessionKey: string) => Promise<void>;
      getHistory?: (sessionKey: string) => Promise<{ messages: unknown[] }>;
      isAlive?: (sessionKey: string) => Promise<boolean>;
    };

    return {
      async spawn(opts) {
        return upstream.spawn(opts);
      },
      async cancel(sessionKey) {
        if (!upstream.cancel) {
          throw new Error("upstream sessions-spawn module missing 'cancel' export");
        }
        return upstream.cancel(sessionKey);
      },
      async getHistory(sessionKey) {
        if (!upstream.getHistory) {
          throw new Error("upstream sessions-spawn module missing 'getHistory' export");
        }
        return upstream.getHistory(sessionKey);
      },
      async isAlive(sessionKey) {
        if (!upstream.isAlive) {
          throw new Error("upstream sessions-spawn module missing 'isAlive' export");
        }
        return upstream.isAlive(sessionKey);
      },
    };
  } catch (err) {
    throw new Error(
      `Failed to create SessionsSpawnBridge: could not import upstream sessions-spawn module. ` +
        `This is expected in isolated test mode. Use createMockSessionsSpawnBridge() for tests. ` +
        `Original error: ${String(err)}`,
      { cause: err },
    );
  }
}
