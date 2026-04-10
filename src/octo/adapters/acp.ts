// Octopus Orchestrator -- AcpAdapter (M2-11)
//
// Adapter implementation for structured_acp. Drives ACP sessions via
// the AcpxBridge (OCTO-DEC-033: upstream isolation through bridge file).
//
// IMPORTANT (OCTO-DEC-036): This adapter is OPT-IN ONLY. It must never
// be auto-selected by the scheduler or agent decision guide. Only
// explicit `adapter_type: "structured_acp"` in an ArmSpec activates it.
//
// After this lands, update factory.ts to wire `structured_acp` to
// AcpAdapter (factory.ts currently throws "not_supported" for this type).
//
// References:
//   - docs/octopus-orchestrator/LLD.md, AcpAdapter (line 431)
//   - DECISIONS.md OCTO-DEC-033 (upstream isolation -- bridge pattern)
//   - DECISIONS.md OCTO-DEC-036 (ACP opt-in only, never default)

import type { ArmSpec } from "../wire/schema.ts";
import {
  AdapterError,
  type Adapter,
  type AdapterEvent,
  type CheckpointMeta,
  type SessionRef,
} from "./base.ts";
import type { AcpxBridge } from "./openclaw/acpx-bridge.ts";

// ──────────────────────────────────────────────────────────────────────────
// Logger interface -- injected for opt-in warning + diagnostics
// ──────────────────────────────────────────────────────────────────────────

export interface AcpAdapterLogger {
  warn(message: string): void;
}

const defaultLogger: AcpAdapterLogger = {
  warn(message: string): void {
    console.warn(message);
  },
};

// ──────────────────────────────────────────────────────────────────────────
// Internal session record
// ──────────────────────────────────────────────────────────────────────────

interface AcpSession {
  sessionKey: string;
  cwd: string;
  spawnedAt: number;
  agentId: string;
}

// ──────────────────────────────────────────────────────────────────────────
// AcpAdapter
// ──────────────────────────────────────────────────────────────────────────

export class AcpAdapter implements Adapter {
  readonly type = "structured_acp" as const;

  private readonly sessions = new Map<string, AcpSession>();

  constructor(
    private readonly bridge: AcpxBridge,
    private readonly logger: AcpAdapterLogger = defaultLogger,
  ) {}

  // ── spawn ──────────────────────────────────────────────────────────────
  //
  // OCTO-DEC-036 opt-in enforcement: log a warning unconditionally so
  // operators are always aware ACP is being used. If this adapter was
  // somehow selected without explicit `adapter_type: "structured_acp"`
  // in the ArmSpec, the warning serves as a diagnostic breadcrumb.

  async spawn(spec: ArmSpec): Promise<SessionRef> {
    this.logger.warn(
      `[AcpAdapter] ACP adapter activated for agent "${spec.agent_id}" ` +
        `(OCTO-DEC-036: structured_acp is opt-in only -- ensure this was explicitly requested)`,
    );

    const rtOpts = spec.runtime_options as {
      acpxHarness: string;
      model?: string;
      permissions?: string;
      mode?: string;
    };

    let result: { sessionKey: string };
    try {
      result = await this.bridge.spawn({
        agentId: spec.agent_id,
        harness: rtOpts.acpxHarness,
        model: rtOpts.model,
        mode: rtOpts.mode,
        permissions: rtOpts.permissions,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new AdapterError("spawn_failed", `ACP spawn failed: ${msg}`);
    }

    const session: AcpSession = {
      sessionKey: result.sessionKey,
      cwd: spec.cwd,
      spawnedAt: Date.now(),
      agentId: spec.agent_id,
    };
    this.sessions.set(result.sessionKey, session);

    return {
      adapter_type: this.type,
      session_id: result.sessionKey,
      cwd: spec.cwd,
      metadata: {
        harness: rtOpts.acpxHarness,
        agent_id: spec.agent_id,
      },
    };
  }

  // ── resume ─────────────────────────────────────────────────────────────

  async resume(ref: SessionRef): Promise<SessionRef> {
    const alive = await this.bridge.isAlive(ref.session_id);
    if (!alive) {
      throw new AdapterError(
        "session_not_found",
        `ACP session "${ref.session_id}" is not alive (cannot resume)`,
      );
    }

    // Re-populate local tracking if not present (e.g. after restart)
    if (!this.sessions.has(ref.session_id)) {
      this.sessions.set(ref.session_id, {
        sessionKey: ref.session_id,
        cwd: ref.cwd,
        spawnedAt: Date.now(),
        agentId: (ref.metadata?.agent_id as string) ?? "unknown",
      });
    }

    return {
      ...ref,
      adapter_type: this.type,
      metadata: { ...ref.metadata, resumed: true },
    };
  }

  // ── send ───────────────────────────────────────────────────────────────
  //
  // ACP adapters DO support send (unlike subagent). Maps to bridge.steer.

  async send(ref: SessionRef, message: string): Promise<void> {
    try {
      await this.bridge.steer(ref.session_id, message);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new AdapterError("send_failed", `ACP steer failed for "${ref.session_id}": ${msg}`);
    }
  }

  // ── stream (stub) ──────────────────────────────────────────────────────
  // TODO (future): consume ACP session events from upstream bridge

  async *stream(_ref: SessionRef): AsyncIterable<AdapterEvent> {
    // Yields nothing until the upstream ACP event stream is wired.
  }

  // ── checkpoint ─────────────────────────────────────────────────────────

  async checkpoint(ref: SessionRef): Promise<CheckpointMeta> {
    const session = this.sessions.get(ref.session_id);
    const alive = await this.bridge.isAlive(ref.session_id);

    return {
      ts: Date.now(),
      alive,
      cwd: session?.cwd,
      elapsed_ms: session ? Date.now() - session.spawnedAt : undefined,
      metadata: {
        session_key: ref.session_id,
        agent_id: session?.agentId,
      },
    };
  }

  // ── terminate ──────────────────────────────────────────────────────────

  async terminate(ref: SessionRef): Promise<void> {
    try {
      await this.bridge.close(ref.session_id);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new AdapterError("internal", `ACP close failed for "${ref.session_id}": ${msg}`);
    }
    this.sessions.delete(ref.session_id);
  }

  // ── health ─────────────────────────────────────────────────────────────

  async health(ref: SessionRef): Promise<string> {
    const alive = await this.bridge.isAlive(ref.session_id);
    return alive ? "active" : "dead";
  }
}
