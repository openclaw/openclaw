// Octopus Orchestrator -- SubagentAdapter (M2-10)
//
// Full Adapter implementation for structured_subagent. Drives OpenClaw's
// native subagent runtime via the SessionsSpawnBridge (OCTO-DEC-033).
//
// The adapter imports from the bridge, never from OpenClaw internals
// directly. This keeps the upstream isolation boundary clean: if upstream
// changes shape, only the bridge file absorbs the diff.
//
// References:
//   - docs/octopus-orchestrator/LLD.md, SubagentAdapter (~line 375)
//   - DECISIONS.md OCTO-DEC-033 (upstream isolation)
//   - DECISIONS.md OCTO-DEC-036 (structured_subagent as primary for OpenClaw model work)
//   - src/octo/adapters/openclaw/sessions-spawn.ts (bridge)

import type { ArmSpec } from "../wire/schema.ts";
import {
  AdapterError,
  type Adapter,
  type AdapterEvent,
  type CheckpointMeta,
  type SessionRef,
} from "./base.ts";
import type { SessionsSpawnBridge } from "./openclaw/sessions-spawn.ts";

// ──────────────────────────────────────────────────────────────────────────
// SubagentAdapter
// ──────────────────────────────────────────────────────────────────────────

export class SubagentAdapter implements Adapter {
  readonly type = "structured_subagent" as const;

  constructor(private readonly bridge: SessionsSpawnBridge) {}

  // ── spawn ──────────────────────────────────────────────────────────────

  async spawn(spec: ArmSpec): Promise<SessionRef> {
    const rtOpts = spec.runtime_options as {
      model?: string;
      thinking?: string;
      runTimeoutSeconds?: number;
      cleanup?: "delete" | "keep";
    };

    let result: { runId: string; sessionKey: string };
    try {
      result = await this.bridge.spawn({
        agentId: spec.agent_id,
        runtime: spec.runtime_name,
        model: rtOpts.model,
        deliver: false,
      });
    } catch (err) {
      throw new AdapterError("spawn_failed", `subagent spawn failed: ${String(err)}`, {
        agentId: spec.agent_id,
      });
    }

    return {
      adapter_type: this.type,
      session_id: result.sessionKey,
      cwd: spec.cwd,
      metadata: {
        runId: result.runId,
        sessionKey: result.sessionKey,
        agentId: spec.agent_id,
        model: rtOpts.model,
        task_ref: spec.idempotency_key,
      },
    };
  }

  // ── resume ─────────────────────────────────────────────────────────────

  async resume(ref: SessionRef): Promise<SessionRef> {
    const sessionKey = ref.session_id;
    const alive = await this.bridge.isAlive(sessionKey);
    if (!alive) {
      throw new AdapterError(
        "session_not_found",
        `subagent session "${sessionKey}" is not alive for resume`,
      );
    }

    return {
      ...ref,
      metadata: { ...ref.metadata, resumed: true },
    };
  }

  // ── send ───────────────────────────────────────────────────────────────
  //
  // Subagents do not support interactive input. The initial prompt is
  // delivered at spawn time; subsequent messages are not supported.

  async send(_ref: SessionRef, _message: string): Promise<void> {
    throw new AdapterError(
      "not_supported",
      "SubagentAdapter does not support send -- subagents receive input at spawn time only",
    );
  }

  // ── stream ─────────────────────────────────────────────────────────────
  //
  // TODO: would consume the subagent output stream via bridge. For now,
  // yields a single completion event based on history from the bridge.

  async *stream(ref: SessionRef): AsyncGenerator<AdapterEvent> {
    const sessionKey = ref.session_id;
    const history = await this.bridge.getHistory(sessionKey);

    yield {
      kind: "output",
      ts: Date.now(),
      data: { messages: history.messages, source: "history" },
    };

    yield {
      kind: "completion",
      ts: Date.now(),
      data: { reason: "history_snapshot" },
    };
  }

  // ── checkpoint ─────────────────────────────────────────────────────────

  async checkpoint(ref: SessionRef): Promise<CheckpointMeta> {
    const sessionKey = ref.session_id;
    const alive = await this.bridge.isAlive(sessionKey);
    const history = await this.bridge.getHistory(sessionKey);

    return {
      ts: Date.now(),
      alive,
      cwd: ref.cwd,
      metadata: {
        sessionKey,
        historyCursor: history.messages.length,
      },
    };
  }

  // ── terminate ──────────────────────────────────────────────────────────

  async terminate(ref: SessionRef): Promise<void> {
    const sessionKey = ref.session_id;
    try {
      await this.bridge.cancel(sessionKey);
    } catch (err) {
      throw new AdapterError(
        "internal",
        `subagent terminate failed for "${sessionKey}": ${String(err)}`,
      );
    }
  }

  // ── health ─────────────────────────────────────────────────────────────

  async health(ref: SessionRef): Promise<string> {
    const alive = await this.bridge.isAlive(ref.session_id);
    return alive ? "active" : "dead";
  }
}
