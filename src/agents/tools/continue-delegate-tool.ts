import { Type } from "@sinclair/typebox";
import {
  stagePostCompactionDelegate,
  enqueuePendingDelegate,
  pendingDelegateCount,
  stagedPostCompactionDelegateCount,
} from "../../auto-reply/continuation-delegate-store.js";
import { resolveMaxDelegatesPerTurn } from "../../auto-reply/reply/continuation-runtime.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { optionalStringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";

const log = createSubsystemLogger("continuation/delegate-tool");

const DELEGATE_MODES = ["normal", "silent", "silent-wake", "post-compaction"] as const;

const ContinueDelegateToolSchema = Type.Object({
  task: Type.String({
    description:
      "The delegated sub-agent's task. Treat this like a letter to your future self: include scope, chunk/range, desired return shape, and what the parent should do with the result.",
    maxLength: 4096,
  }),
  delaySeconds: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Seconds to wait before spawning the delegate. 0 or omitted = immediate. " +
        "Clamped to continuation.minDelayMs / maxDelayMs from config.",
    }),
  ),
  mode: optionalStringEnum(DELEGATE_MODES, {
    description:
      'Return mode. "normal" = announces to channel (default). ' +
      '"silent" = result injected as internal context only, no channel echo; use for ambient enrichment and future recall. ' +
      '"silent-wake" = silent + triggers a new generation cycle so the agent can act on the enrichment immediately. ' +
      '"post-compaction" = silent-wake delegate that fires when compaction happens, not on a timer. ' +
      "Use for context evacuation: the shard starts at the moment of compaction and returns to the post-compaction session.",
  }),
});

/**
 * Creates the `continue_delegate` tool.
 *
 * This tool dispatches a sub-agent as a continuation delegate — tracked by the
 * gateway's continuation chain (cost caps, depth limits, chain counters).
 *
 * Architecture (Path A — side-channel):
 *   1. Tool writes to the module-level pending-delegate store during execution.
 *   2. After the agent's response finalizes, `agent-runner.ts` reads from the
 *      store and feeds delegates into the same scheduler that bracket-parsed
 *      `[[CONTINUE_DELEGATE:]]` signals use.
 *   3. Both paths (tool + brackets) converge at the same dispatch point —
 *      same cost cap, same chain depth, same delay clamping.
 *
 * The tool can be called multiple times per turn (multi-delegate fan-out).
 * Each call enqueues independently. No single-per-response regex limitation.
 *
 * NOTE: Delayed fan-out (multiple delegates with delaySeconds > 0) is subject
 * to the generation guard — each scheduled timer checks that the session's
 * generation counter hasn't advanced. In busy channels, intervening messages
 * may cancel earlier timers. Use delaySeconds: 0 for reliable parallel fan-out,
 * or set generationGuardTolerance >= N-1 for N delayed delegates.
 */
export function createContinueDelegateTool(opts: { agentSessionKey?: string }): AnyAgentTool {
  return {
    label: "Continuation",
    name: "continue_delegate",
    description:
      "Schedule a continuation delegate — a background sub-agent that can run now, later, " +
      "or at compaction, then return visibly or silently to this session. Use for ambient " +
      "enrichment, chunked/aspected fan-out, or preserving working state across compaction. " +
      'Use "silent-wake" when the result should quietly enrich context and wake you to act. ' +
      "Can be called multiple times per turn for parallel fan-out while the main session stays free. " +
      "Prefer this over exec or raw sessions_spawn when the goal is gateway-managed delayed/silent/wake-on-return delegate work. " +
      "Note: delayed delegates share the same generation guard as delayed CONTINUE_WORK — use delay 0 for reliable parallel dispatch in noisy channels, or raise generationGuardTolerance.",
    parameters: ContinueDelegateToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const sessionKey = opts.agentSessionKey;

      if (!sessionKey) {
        throw new ToolInputError(
          "continue_delegate requires an active session. Not available in sessionless contexts.",
        );
      }

      const task = readStringParam(params, "task", { required: true });
      if (!task.trim()) {
        throw new ToolInputError("task must be a non-empty string describing the delegated work.");
      }

      const delaySeconds =
        typeof params.delaySeconds === "number" && Number.isFinite(params.delaySeconds)
          ? Math.max(0, params.delaySeconds)
          : undefined;
      const delayMs = delaySeconds !== undefined ? delaySeconds * 1000 : undefined;

      const modeRaw = typeof params.mode === "string" ? params.mode.trim().toLowerCase() : "";
      const isPostCompaction = modeRaw === "post-compaction";
      const silent = modeRaw === "silent" || modeRaw === "silent-wake" || isPostCompaction;
      const silentWake = modeRaw === "silent-wake" || isPostCompaction;

      // Check per-turn delegate limit
      const maxPerTurn = resolveMaxDelegatesPerTurn();
      const currentCount =
        pendingDelegateCount(sessionKey) + stagedPostCompactionDelegateCount(sessionKey);
      if (currentCount >= maxPerTurn) {
        return jsonResult({
          status: "error",
          reason: `maxDelegatesPerTurn exceeded (${maxPerTurn}). Cannot dispatch more delegates this turn.`,
          dispatched: currentCount,
          limit: maxPerTurn,
        });
      }

      if (isPostCompaction) {
        // Stage for the current turn. agent-runner commits successful turns to
        // SessionEntry so failed runs do not leak stale compaction delegates.
        stagePostCompactionDelegate(sessionKey, {
          task,
          createdAt: Date.now(),
        });

        return jsonResult({
          status: "queued-for-compaction",
          mode: "post-compaction",
          note:
            "Delegate will fire when compaction occurs, not on a timer. " +
            "The shard starts at the moment of compaction and returns to the post-compaction session. " +
            "Chain tracking applies at dispatch time.",
        });
      }

      // Enqueue for post-run processing by agent-runner.ts
      log.debug(
        `[continue_delegate:enqueue] session=${sessionKey} silent=${silent} silentWake=${silentWake} delayMs=${delayMs} task=${task.slice(0, 80)}`,
      );
      enqueuePendingDelegate(sessionKey, {
        task,
        delayMs,
        silent,
        silentWake,
      });

      const dispatchIndex = currentCount + 1;

      return jsonResult({
        status: "scheduled",
        mode: modeRaw || "normal",
        delaySeconds: delaySeconds ?? 0,
        delegateIndex: dispatchIndex,
        delegatesThisTurn: dispatchIndex,
        note:
          "Delegate will be dispatched after your response completes. " +
          "Chain tracking (cost cap, depth limit) applies.",
      });
    },
  };
}
