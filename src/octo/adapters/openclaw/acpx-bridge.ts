// Octopus Orchestrator -- Upstream bridge: ACP / `acpx` runtime
//
// STATUS: OPT-IN ONLY per OCTO-DEC-036 -- never the default path for external
//         agentic coding tools. Preference order is cli_exec -> pty_tmux; ACP
//         is selected only on explicit operator opt-in in the ArmSpec. The
//         scheduler and agent decision guide must never auto-select this
//         bridge for Claude Code, Codex, Gemini CLI, Cursor, Copilot, or any
//         other external agentic coding tool.
//
// Per OCTO-DEC-033, every touch-point with OpenClaw upstream code flows
// through a bridge file in this directory. Downstream Octopus code
// imports from this bridge, never from the upstream module directly.
// When upstream changes shape, the bridge absorbs the diff; the rest
// of Octopus stays quiet.
//
// Wraps: The OpenClaw ACP / `acpx` plugin runtime -- the Agent Client
//        Protocol harness set and its feature-detection surface.
// Tested against OpenClaw: 2026.4.7-1 (upstream commit 9ece252; deployed reference OpenClaw 2026.4.8)
// Stable assumptions:
//   - `acpx` exposes a discoverable harness set that can be
//     feature-detected at runtime; missing harnesses are reported
//     structurally rather than as crashes.
//   - The ACP message shape (prompt/result/tool_use framing) is
//     stable across the `acpx` plugin's minor versions.
//   - ACP arms are never auto-scheduled; selection is gated on an
//     explicit `adapter_type: "structured_acp"` in ArmSpec (per
//     OCTO-DEC-036).
// Reach-arounds:
//   - Harness availability is probed via feature detection; a missing
//     harness degrades the arm cleanly instead of hard-failing the
//     mission.
//   - The bridge refuses to launch if the operator has not explicitly
//     opted in, even if an ArmSpec somehow requested it by default --
//     belt-and-braces enforcement of OCTO-DEC-036.
// Rollback plan: ACP support can be disabled wholesale by making this
//   bridge return an "unavailable" capability to the adapter layer;
//   downstream callers see `structured_acp` as absent and must either
//   use an alternate adapter or fail the mission with a clear reason.
//
// See also:
//   - docs/octopus-orchestrator/INTEGRATION.md  Upstream Dependency Classification
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-033
//   - docs/octopus-orchestrator/DECISIONS.md OCTO-DEC-036

// ──────────────────────────────────────────────────────────────────────────
// AcpxBridge -- interface consumed by AcpAdapter (M2-11)
//
// The bridge abstracts the upstream `acpx` harness runtime behind a
// minimal session-lifecycle surface. AcpAdapter never imports upstream
// code directly (OCTO-DEC-033); it calls AcpxBridge methods.
// ──────────────────────────────────────────────────────────────────────────

export interface AcpxSpawnOptions {
  agentId: string;
  harness: string;
  model?: string;
  mode?: string;
  permissions?: string;
}

export interface AcpxBridge {
  /** Spawn an ACP session. Returns a unique session key. */
  spawn(opts: AcpxSpawnOptions): Promise<{ sessionKey: string }>;

  /** Send a steering message to a live ACP session. */
  steer(sessionKey: string, message: string): Promise<void>;

  /** Close / terminate an ACP session. */
  close(sessionKey: string): Promise<void>;

  /** Check whether a session is still alive. */
  isAlive(sessionKey: string): Promise<boolean>;
}

// ──────────────────────────────────────────────────────────────────────────
// Mock bridge -- for tests. Tracks all calls for assertion.
// ──────────────────────────────────────────────────────────────────────────

export interface MockAcpxBridge extends AcpxBridge {
  calls: Record<string, unknown[][]>;
}

export function createMockAcpxBridge(): MockAcpxBridge {
  let sessionCounter = 0;
  const aliveSessions = new Set<string>();

  const calls: Record<string, unknown[][]> = {
    spawn: [],
    steer: [],
    close: [],
    isAlive: [],
  };

  return {
    calls,

    async spawn(opts: AcpxSpawnOptions): Promise<{ sessionKey: string }> {
      calls.spawn.push([opts]);
      sessionCounter++;
      const sessionKey = `acp-session-${sessionCounter}`;
      aliveSessions.add(sessionKey);
      return { sessionKey };
    },

    async steer(sessionKey: string, message: string): Promise<void> {
      calls.steer.push([sessionKey, message]);
    },

    async close(sessionKey: string): Promise<void> {
      calls.close.push([sessionKey]);
      aliveSessions.delete(sessionKey);
    },

    async isAlive(sessionKey: string): Promise<boolean> {
      calls.isAlive.push([sessionKey]);
      return aliveSessions.has(sessionKey);
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────
// createAcpxBridge -- production bridge (stub until upstream wiring lands)
//
// This is the real bridge factory that will wrap upstream `acpx` APIs.
// For now it throws -- the adapter layer gates on explicit opt-in
// (OCTO-DEC-036) and will surface a clear error if someone tries to
// use it before the upstream integration is complete.
// ──────────────────────────────────────────────────────────────────────────

export async function createAcpxBridge(): Promise<AcpxBridge> {
  throw new Error(
    "createAcpxBridge: production ACP bridge not yet implemented. " +
      "Use createMockAcpxBridge() for tests. (OCTO-DEC-036: ACP is opt-in only.)",
  );
}
