// Octopus Orchestrator — Upstream bridge: Gateway WS transport
//
// Per OCTO-DEC-033, every touch-point with OpenClaw upstream code flows
// through a bridge file in this directory. Downstream Octopus code
// imports from this bridge, never from the upstream module directly.
// When upstream changes shape, the bridge absorbs the diff; the rest
// of Octopus stays quiet.
//
// Wraps: OpenClaw Gateway WebSocket transport and `octo.*` method
//        registration surface (upstream `src/gateway/*`, in particular
//        the server-methods-list and connect-handler registration
//        points named in INTEGRATION.md §Required Upstream Changes).
// Tested against OpenClaw: 2026.4.7-1 (upstream commit 9ece252; deployed reference OpenClaw 2026.4.8)
// Stable assumptions:
//   - Gateway WS wire format is versioned; the envelope shape for
//     method dispatch and response framing is stable across minor
//     versions (classified "stable" in INTEGRATION.md).
//   - `octo.*` methods can be registered via the documented
//     server-methods-list registration point without patching
//     existing method bodies.
//   - `caps.octo` flows through the existing `role: node` connect
//     payload additively; no new handshake opcode is required.
//   - Device pairing + token issuance is untouched by Octopus; we
//     only declare a new capability name.
// Reach-arounds:
//   - None currently; the Gateway surface is stable and Octopus is
//     purely additive at this layer. If a future version of the
//     Gateway changes its registration API, the shim lives here.
// Rollback plan: If the Gateway surface shifts under us, this bridge
//   absorbs the diff in one file; downstream `octo.*` handler
//   registrations degrade to a no-op and `hello-ok.features.octo`
//   simply never advertises, which is the documented off state.
//
// Lifecycle: placeholder — real wrapper lands in Milestone 1 alongside
//   the first `octo.*` handler registrations (see HLD §Adapter layer
//   and INTEGRATION.md §Upstream Dependency Classification).
//
// See also:
//   - docs/octopus-orchestrator/INTEGRATION.md §Upstream Dependency Classification
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-033

// ──────────────────────────────────────────────────────────────────────────
// Logger -- minimal logging interface (matches upstream shape)
// ──────────────────────────────────────────────────────────────────────────

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

// ──────────────────────────────────────────────────────────────────────────
// GatewayBridge -- the bridge contract
// ──────────────────────────────────────────────────────────────────────────

export interface GatewayBridge {
  /** Get a scoped logger for a component. */
  getLogger(component: string): Logger;

  /** Get the Gateway version string. */
  getGatewayVersion(): string;
}

// ──────────────────────────────────────────────────────────────────────────
// Mock factory -- for tests (no OpenClaw internals needed)
// ──────────────────────────────────────────────────────────────────────────

export interface MockLogger extends Logger {
  messages: Array<{ level: string; msg: string; meta?: Record<string, unknown> }>;
}

export interface MockGatewayBridge extends GatewayBridge {
  calls: Record<string, unknown[][]>;
  /** All loggers created, keyed by component name. */
  loggers: Map<string, MockLogger>;
  mockVersion: string;
}

function createMockLogger(): MockLogger {
  const messages: MockLogger["messages"] = [];
  return {
    messages,
    info(msg: string, meta?: Record<string, unknown>) {
      messages.push({ level: "info", msg, meta });
    },
    warn(msg: string, meta?: Record<string, unknown>) {
      messages.push({ level: "warn", msg, meta });
    },
    error(msg: string, meta?: Record<string, unknown>) {
      messages.push({ level: "error", msg, meta });
    },
    debug(msg: string, meta?: Record<string, unknown>) {
      messages.push({ level: "debug", msg, meta });
    },
  };
}

export function createMockGatewayBridge(): MockGatewayBridge {
  const loggers = new Map<string, MockLogger>();

  const calls: Record<string, unknown[][]> = {
    getLogger: [],
    getGatewayVersion: [],
  };

  return {
    calls,
    loggers,
    mockVersion: "0.0.0-test",

    getLogger(component: string): Logger {
      calls.getLogger.push([component]);
      let logger = loggers.get(component);
      if (!logger) {
        logger = createMockLogger();
        loggers.set(component, logger);
      }
      return logger;
    },

    getGatewayVersion(): string {
      calls.getGatewayVersion.push([]);
      return this.mockVersion;
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// createGatewayBridge -- production bridge (stub)
//
// The real factory will wrap the upstream Gateway logging and version
// surface. For now it throws -- upstream wiring has not landed yet.
// ──────────────────────────────────────────────────────────────────────────

export async function createGatewayBridge(): Promise<GatewayBridge> {
  try {
    // Dynamic import of OpenClaw internals -- allowed from this bridge file.
    // @ts-expect-error -- upstream module is not part of the Octopus build graph
    const mod = (await import("../../gateway/index.js")) as Record<string, unknown>;

    if (typeof mod.getLogger !== "function") {
      throw new Error("upstream gateway module missing 'getLogger' export");
    }

    const upstream = mod as {
      getLogger: (component: string) => Logger;
      version?: string;
    };

    return {
      getLogger(component: string): Logger {
        return upstream.getLogger(component);
      },

      getGatewayVersion(): string {
        return upstream.version ?? "unknown";
      },
    };
  } catch (err) {
    throw new Error(
      `Failed to create GatewayBridge: could not import upstream gateway module. ` +
        `This is expected in isolated test mode. Use createMockGatewayBridge() for tests. ` +
        `Original error: ${String(err)}`,
      { cause: err },
    );
  }
}
