import { Brain, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/store/chat-store";

// ─── Compaction Divider ───

/**
 * Check if a message is a compaction marker injected by the gateway.
 * These have role: "system" with __openclaw.kind === "compaction".
 */
export function isCompactionMessage(msg: ChatMessage): boolean {
  return msg.role === "system" && msg.__openclaw?.kind === "compaction";
}

/**
 * Inline divider rendered in the message stream for compaction events.
 * Replaces the generic system message pill with a centered line divider.
 */
export function CompactionDivider({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-2 px-4 py-3 animate-fade-in select-none",
        className,
      )}
      role="status"
      aria-label="Context compacted"
    >
      <Minus className="h-3 w-3 text-muted-foreground/40" />
      <div className="flex items-center gap-1.5">
        <Brain className="h-3 w-3 text-muted-foreground/50" />
        <span className="text-[11px] text-muted-foreground/60 font-medium tracking-wide uppercase">
          Context compacted
        </span>
      </div>
      <Minus className="h-3 w-3 text-muted-foreground/40" />
    </div>
  );
}

// ─── Agent Event Types ───

export type AgentEventPayload = {
  stream?: string;
  runId?: string;
  sessionKey?: string;
  agentId?: string;
  data?: Record<string, unknown>;
};

/**
 * Parse an agent event payload and return a system event notification
 * descriptor if one should be shown, or null if it should be ignored.
 */
export function parseAgentSystemEvent(
  payload: AgentEventPayload,
): { message: string; variant: "info" | "warning" } | null {
  if (!payload) {
    return null;
  }

  // Compaction events
  if (payload.stream === "compaction") {
    const phase = typeof payload.data?.phase === "string" ? payload.data.phase : "";
    if (phase === "start") {
      return { message: "Compacting context...", variant: "info" };
    }
    if (phase === "end") {
      return { message: "Context compacted", variant: "info" };
    }
    return null;
  }

  // Fallback events
  if (payload.stream === "fallback" || payload.stream === "lifecycle") {
    const data = payload.data ?? {};
    const phase =
      payload.stream === "fallback"
        ? "fallback"
        : (typeof data.phase === "string" ? data.phase : "");

    if (phase !== "fallback" && phase !== "fallback_cleared") {
      return null;
    }

    const active = resolveModelRef(data.activeProvider, data.activeModel) ??
      resolveModelRef(data.toProvider, data.toModel);
    const reason = trimString(data.reasonSummary) ?? trimString(data.reason);

    if (phase === "fallback_cleared") {
      const selected = resolveModelRef(data.selectedProvider, data.selectedModel) ??
        resolveModelRef(data.fromProvider, data.fromModel);
      return {
        message: `Returned to ${selected ?? "selected model"}`,
        variant: "info",
      };
    }

    const reasonSuffix = reason ? ` (${reason})` : "";
    return {
      message: `Switched to ${active ?? "fallback model"}${reasonSuffix}`,
      variant: "warning",
    };
  }

  return null;
}

// ─── Helpers ───

function resolveModelRef(
  provider: unknown,
  model: unknown,
): string | null {
  const p = trimString(provider);
  const m = trimString(model);
  if (!m) {
    return null;
  }
  // Return just the model name for brevity; include provider if different
  return p ? `${m}` : m;
}

function trimString(val: unknown): string | null {
  if (typeof val !== "string") {
    return null;
  }
  const trimmed = val.trim();
  return trimmed || null;
}
