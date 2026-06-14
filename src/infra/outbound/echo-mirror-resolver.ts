import type {
  GetReplyOptions,
  PartialReplyPayload,
} from "../../auto-reply/get-reply-options.types.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  type CliToolEventPayload,
  createCliToolSummaryTracker,
} from "../../auto-reply/reply/agent-runner-cli-dispatch.js";
import type { GetReplyFromConfig } from "../../auto-reply/reply/get-reply.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { type AgentEventPayload, onAgentEvent } from "../agent-events.js";
import { formatErrorMessage } from "../errors.js";

const log = createSubsystemLogger("outbound/echo-mirror");

/**
 * B-full native streaming echo — the "mirror replyResolver".
 *
 * The origin channel runs the agent ONCE. Every streaming event is broadcast on
 * the agent-event bus keyed by runId (infra/agent-events.ts). To render the same
 * turn NATIVELY on a pinned echo channel, we invoke that channel's own dispatch
 * with THIS resolver in place of the real agent: instead of calling the model, it
 * replays the origin run's bus events into the target dispatch's `opts.on*`
 * callbacks, so the target's native compositor (progress drafts, tool lanes, …)
 * renders live. It resolves with the accumulated final payload when the origin
 * run's lifecycle ends.
 *
 * Subscription starts at CREATION (not at resolver invocation) so the caller can
 * construct this the instant the origin run starts and not miss early events —
 * the bus has no replay buffer. Events are drained through a serial async queue
 * so ordering and per-callback backpressure are preserved even though the bus
 * notifies listeners synchronously.
 */
export type MirrorReplyResolver = {
  /** GetReplyFromConfig to hand to the target channel's dispatch. */
  resolver: GetReplyFromConfig;
  /** Detach the bus listener; safe to call multiple times. Auto-called on lifecycle end. */
  dispose: () => void;
};

type LifecyclePhase = "start" | "finishing" | "end" | "error" | (string & {});

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function createMirrorReplyResolver(params: {
  originRunId: string;
  /** Optional label for diagnostics (e.g. "telegram:123"). */
  targetLabel?: string;
  /** Tool-arg detail for the durable tool summary; mirrors the origin config. */
  toolProgressDetail?: "explain" | "raw";
}): MirrorReplyResolver {
  const { originRunId } = params;
  const queue: AgentEventPayload[] = [];

  // Final-payload accumulation from the "assistant" stream. The embedded and CLI
  // paths emit a cumulative `text` each tick; ACP-style paths may emit delta-only.
  let lastFullText: string | undefined;
  let deltaAccumulator = "";
  let finalMediaUrls: string[] | undefined;

  let finished = false;
  let disposed = false;
  let resolveFinal: ((payload: ReplyPayload | undefined) => void) | undefined;
  let attachedOpts: GetReplyOptions | undefined;

  // Serial drain: bus notifies synchronously, but on* callbacks are async and
  // order-sensitive. Enqueue + drain one-at-a-time.
  let draining = false;

  // The bus carries RAW tool start/result events (cli-runner emits both under
  // stream:"tool"); the durable "🛠️" summary is a render, not a bus payload. Reuse
  // the exact tracker the native CLI dispatch uses so the mirror's tool summaries
  // are byte-identical: "start" captures args-meta by toolCallId, "result" formats
  // the aggregate and delivers it through the target dispatch's onToolResult. The
  // target dispatch still gates the actual send on verbose (shouldSuppress…), so we
  // can forward unconditionally here.
  const toolSummary = createCliToolSummaryTracker({
    ...(params.toolProgressDetail ? { detailMode: params.toolProgressDetail } : {}),
    shouldEmitToolResult: () => true,
    shouldEmitToolOutput: () => false,
    deliver: async ({ text, isError }) => {
      await attachedOpts?.onToolResult?.({ text, ...(isError ? { isError: true } : {}) });
    },
  });

  const unsubscribe = onAgentEvent((evt) => {
    if (evt.runId !== originRunId || disposed) {
      return;
    }
    queue.push(evt);
    void drain();
  });

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    unsubscribe();
  }

  function resolveFinalText(): string | undefined {
    if (lastFullText !== undefined) {
      return lastFullText;
    }
    return deltaAccumulator || undefined;
  }

  function settle(): void {
    if (finished) {
      return;
    }
    finished = true;
    dispose();
    const text = resolveFinalText();
    const payload: ReplyPayload | undefined =
      text !== undefined || finalMediaUrls
        ? {
            ...(text !== undefined ? { text } : {}),
            ...(finalMediaUrls ? { mediaUrls: finalMediaUrls } : {}),
          }
        : undefined;
    resolveFinal?.(payload);
  }

  async function dispatchEvent(opts: GetReplyOptions, evt: AgentEventPayload): Promise<void> {
    const data = evt.data ?? {};
    switch (evt.stream) {
      case "assistant": {
        const text = asString(data.text);
        const delta = asString(data.delta);
        if (text !== undefined) {
          lastFullText = text;
        } else if (delta) {
          deltaAccumulator += delta;
        }
        if (Array.isArray(data.mediaUrls)) {
          finalMediaUrls = data.mediaUrls as string[];
        }
        const partial: PartialReplyPayload = {
          ...(text !== undefined ? { text } : {}),
          ...(delta ? { delta } : {}),
          ...(Array.isArray(data.mediaUrls) ? { mediaUrls: data.mediaUrls as string[] } : {}),
          ...(data.replace === true ? { replace: true as const } : {}),
        };
        await opts.onPartialReply?.(partial);
        return;
      }
      case "item":
        await opts.onItemEvent?.(
          data as Parameters<NonNullable<GetReplyOptions["onItemEvent"]>>[0],
        );
        return;
      case "tool": {
        const toolEvt = data as unknown as CliToolEventPayload;
        // Feed every phase to the summary tracker: "start" captures the args-meta,
        // "result" emits the durable 🛠️ summary via onToolResult. A "result" event
        // is NOT a start — routing it to onToolStart (as before) mis-rendered it and
        // dropped the verbose tool record from the mirror.
        await toolSummary.noteToolEvent(toolEvt);
        if (toolEvt.phase === "result") {
          return;
        }
        await opts.onToolStart?.(
          data as Parameters<NonNullable<GetReplyOptions["onToolStart"]>>[0],
        );
        return;
      }
      case "thinking":
      case "reasoning": {
        const phase = asString(data.phase);
        if (phase === "end") {
          await opts.onReasoningEnd?.();
        } else {
          await opts.onReasoningStream?.(data as ReplyPayload);
        }
        return;
      }
      case "plan":
        await opts.onPlanUpdate?.(
          data as Parameters<NonNullable<GetReplyOptions["onPlanUpdate"]>>[0],
        );
        return;
      case "approval":
        await opts.onApprovalEvent?.(
          data as Parameters<NonNullable<GetReplyOptions["onApprovalEvent"]>>[0],
        );
        return;
      case "command_output":
        await opts.onCommandOutput?.(
          data as Parameters<NonNullable<GetReplyOptions["onCommandOutput"]>>[0],
        );
        return;
      case "patch":
        await opts.onPatchSummary?.(
          data as Parameters<NonNullable<GetReplyOptions["onPatchSummary"]>>[0],
        );
        return;
      case "compaction": {
        const phase = asString(data.phase);
        if (phase === "end") {
          await opts.onCompactionEnd?.();
        } else {
          await opts.onCompactionStart?.();
        }
        return;
      }
      case "lifecycle": {
        const phase = asString(data.phase) as LifecyclePhase | undefined;
        if (phase === "end" || phase === "error") {
          settle();
        }
        return;
      }
      default:
        // Unknown stream: nothing to mirror.
        break;
    }
  }

  async function drain(): Promise<void> {
    if (draining) {
      return;
    }
    // Hold events until the resolver is invoked and opts are attached.
    if (!attachedOpts) {
      return;
    }
    draining = true;
    try {
      // `finished` is flipped by settle() reached THROUGH dispatchEvent below, so
      // it is checked inside the loop (a loop-condition check reads as unmodified
      // to static analysis).
      while (queue.length > 0) {
        if (finished) {
          break;
        }
        const evt = queue.shift();
        if (!evt) {
          break;
        }
        try {
          await dispatchEvent(attachedOpts, evt);
        } catch (err) {
          // A failing target render must never abort the origin turn.
          log.warn(
            `mirror render callback failed for ${params.targetLabel ?? originRunId}: ${formatErrorMessage(err)}`,
          );
        }
      }
    } finally {
      draining = false;
    }
  }

  const resolver: GetReplyFromConfig = (_ctx, opts) => {
    attachedOpts = opts ?? {};
    // Set up the settle channel BEFORE anything can call settle() (an
    // already-aborted signal would otherwise resolve into the void).
    const done = new Promise<ReplyPayload | undefined>((resolve) => {
      resolveFinal = resolve;
    });
    const abortSignal = opts?.abortSignal;
    if (abortSignal) {
      if (abortSignal.aborted) {
        settle();
      } else {
        abortSignal.addEventListener("abort", () => settle(), { once: true });
      }
    }
    // Drain anything that arrived before invocation.
    void drain();
    return done;
  };

  return { resolver, dispose };
}
