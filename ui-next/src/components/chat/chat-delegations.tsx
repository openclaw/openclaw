import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import type { DelegationEntry } from "@/store/delegation-store";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const s = Math.floor(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem}s`;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) {
    return str;
  }
  return str.slice(0, max) + "\u2026";
}

// ─── Status dot ───────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: DelegationEntry["status"] }) {
  if (status === "running") {
    return (
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
      </span>
    );
  }
  const colorMap: Record<DelegationEntry["status"], string> = {
    spawned: "bg-muted-foreground/50",
    running: "bg-blue-500",
    completed: "bg-green-500",
    stale: "bg-amber-500",
    failed: "bg-red-500",
  };
  return <span className={cn("inline-flex h-2 w-2 shrink-0 rounded-full", colorMap[status])} />;
}

// ─── Status badge ─────────────────────────────────────────────────────────────

const statusBadgeClass: Record<DelegationEntry["status"], string> = {
  spawned: "bg-muted text-muted-foreground border-border",
  running: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  completed: "bg-green-500/15 text-green-400 border-green-500/30",
  stale: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  failed: "bg-red-500/15 text-red-400 border-red-500/30",
};

function StatusBadge({ status }: { status: DelegationEntry["status"] }) {
  return (
    <Badge
      variant="outline"
      className={cn("text-[10px] px-1.5 py-0 font-mono leading-4 border", statusBadgeClass[status])}
    >
      {status}
    </Badge>
  );
}

// ─── Status icon (for completed / stale / failed summary) ────────────────────

function StatusIcon({ status }: { status: DelegationEntry["status"] }) {
  if (status === "running") {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400 shrink-0" />;
  }
  if (status === "completed") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-green-400 shrink-0" />;
  }
  if (status === "failed" || status === "stale") {
    return <AlertCircle className="h-3.5 w-3.5 text-amber-400 shrink-0" />;
  }
  return null;
}

// ─── Single delegation card ────────────────────────────────────────────────────

function DelegationDetailModal({
  entry,
  open,
  onClose,
}: {
  entry: DelegationEntry;
  open: boolean;
  onClose: () => void;
}) {
  if (!open) {
    return null;
  }
  const agentFromKey = entry.childSessionKey?.split(":")?.[1];
  const agentName = entry.agentId ?? agentFromKey ?? "sub-agent";

  return (
    <div className="fixed inset-0 z-[100] bg-black/60" onClick={onClose}>
      <div
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg rounded-lg border bg-card p-5 shadow-xl flex flex-col gap-3 max-h-[80vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <StatusDot status={entry.status} />
            <h3 className="font-semibold text-sm">{agentName}</h3>
            <StatusBadge status={entry.status} />
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {entry.label && (
          <div className="text-xs text-muted-foreground">
            <span className="font-medium">Label:</span> {entry.label}
          </div>
        )}

        <div className="text-xs">
          <span className="font-medium text-muted-foreground">Task:</span>
          <pre className="mt-1 whitespace-pre-wrap text-foreground/80 bg-muted/30 rounded p-2 text-[11px] leading-relaxed max-h-[200px] overflow-y-auto">
            {entry.task ?? "No task description"}
          </pre>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
          <div>
            <span className="font-medium">Run ID:</span>{" "}
            <span className="font-mono">{entry.runId?.slice(0, 12)}...</span>
          </div>
          <div>
            <span className="font-medium">Status:</span> {entry.status}
          </div>
          <div>
            <span className="font-medium">Created:</span>{" "}
            {entry.createdAt ? new Date(entry.createdAt).toLocaleString() : "—"}
          </div>
          <div>
            <span className="font-medium">Started:</span>{" "}
            {entry.startedAt ? new Date(entry.startedAt).toLocaleString() : "—"}
          </div>
          <div>
            <span className="font-medium">Ended:</span>{" "}
            {entry.endedAt ? new Date(entry.endedAt).toLocaleString() : "—"}
          </div>
          <div>
            <span className="font-medium">Elapsed:</span> {formatElapsed(entry.elapsedMs)}
          </div>
        </div>

        {entry.resultPreview && (
          <div className="text-xs">
            <span className="font-medium text-muted-foreground">Result:</span>
            <pre className="mt-1 whitespace-pre-wrap text-green-400/80 bg-green-500/5 border border-green-500/20 rounded p-2 text-[11px] leading-relaxed max-h-[200px] overflow-y-auto">
              {entry.resultPreview}
            </pre>
          </div>
        )}

        {(entry.status === "stale" || entry.status === "failed") && (
          <div className="pt-1">
            <DelegationActions runId={entry.runId} />
          </div>
        )}
      </div>
    </div>
  );
}

function DelegationCard({ entry }: { entry: DelegationEntry }) {
  const [showDetail, setShowDetail] = useState(false);
  // Auto-update elapsed time every second for active delegations
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (entry.status === "running" || entry.status === "spawned" || entry.status === "stale") {
      const id = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(id);
    }
  }, [entry.status]);

  // Compute elapsed — timestamps are in ms (Date.now() style)
  const refTime = entry.startedAt ?? entry.createdAt;
  const elapsed =
    entry.endedAt != null && entry.endedAt > 0 ? entry.elapsedMs : refTime > 0 ? now - refTime : 0;

  // Extract agent name from childSessionKey (agent:<name>:subagent:...) or use label/agentId
  // Extract agent name from childSessionKey (agent:<name>:subagent:...)
  const agentFromKey = entry.childSessionKey?.split(":")?.[1];
  const agentName = entry.agentId ?? agentFromKey ?? "sub-agent";
  const taskLabel = entry.label ?? null;
  const agentDisplay = `${agentName}${taskLabel ? ` — ${taskLabel}` : ""}`;
  const task = entry.task ? truncate(entry.task, 80) : null;

  return (
    <>
      <DelegationDetailModal entry={entry} open={showDetail} onClose={() => setShowDetail(false)} />
      <div
        onClick={() => setShowDetail(true)}
        className={cn(
          "flex flex-col gap-1 rounded-md border px-3 py-2 text-xs transition-colors cursor-pointer hover:brightness-110",
          entry.status === "running"
            ? "border-blue-500/20 bg-blue-500/5"
            : entry.status === "completed"
              ? "border-green-500/20 bg-green-500/5"
              : entry.status === "failed"
                ? "border-red-500/20 bg-red-500/5"
                : entry.status === "stale"
                  ? "border-amber-500/20 bg-amber-500/5"
                  : "border-border bg-muted/30",
        )}
      >
        {/* Top row: dot + agent name + status badge + actions + elapsed */}
        <div className="flex items-center gap-2 min-w-0">
          <StatusDot status={entry.status} />
          <span className="font-medium text-foreground/90 truncate max-w-[200px]">
            {agentDisplay}
          </span>
          <StatusBadge status={entry.status} />
          {(entry.status === "stale" || entry.status === "failed") && (
            <DelegationActions runId={entry.runId} />
          )}
          <span className="ml-auto text-muted-foreground font-mono tabular-nums shrink-0">
            {formatElapsed(elapsed)}
          </span>
          <StatusIcon status={entry.status} />
        </div>

        {/* Task description */}
        {task && <p className="text-muted-foreground leading-snug pl-4">{task}</p>}

        {/* Result preview (completed only) */}
        {entry.status === "completed" && entry.resultPreview && (
          <p className="mt-0.5 pl-4 text-green-400/80 leading-snug line-clamp-3">
            {truncate(entry.resultPreview, 200)}
          </p>
        )}
      </div>
    </>
  );
}

function DelegationActions({ runId }: { runId: string }) {
  const { sendRpc } = useGateway();
  const [acting, setActing] = useState<string | null>(null);

  const act = (e: React.MouseEvent, action: string, method: string) => {
    e.stopPropagation();
    setActing(action);
    sendRpc<{
      ok?: boolean;
      sessionKey?: string;
      agentName?: string;
      task?: string;
      action?: string;
    }>(method, { runId })
      .then((result) => {
        console.log(`[delegation] ${action} succeeded for ${runId.slice(0, 8)}`);
        // If the RPC returns task context, send a chat message to trigger re-delegation
        if (result?.sessionKey && result?.task && (action === "resume" || action === "retry")) {
          const prefix = action === "resume" ? "[Delegation Resume]" : "[Delegation Retry]";
          const agentName = result.agentName ?? "the sub-agent";
          void sendRpc("chat.send", {
            sessionKey: result.sessionKey,
            message: `${prefix} Please re-delegate this task to ${agentName}:\n\n${result.task}`,
            idempotencyKey: crypto.randomUUID(),
          });
        }
      })
      .catch((err) => {
        console.error(`[delegation] ${action} failed for ${runId.slice(0, 8)}:`, err);
      })
      .finally(() => setActing(null));
  };

  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant="ghost"
        className="h-5 px-1.5 text-[10px] text-blue-400 hover:bg-blue-500/10"
        onClick={(e) => act(e, "resume", "sessions.delegations.resume")}
        disabled={acting !== null}
        title="Resume — nudge the sub-agent to continue"
      >
        {acting === "resume" ? <Loader2 className="h-3 w-3 animate-spin" /> : <>&#9654;</>}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-5 px-1.5 text-[10px] text-amber-400 hover:bg-amber-500/10"
        onClick={(e) => act(e, "retry", "sessions.delegations.retry")}
        disabled={acting !== null}
        title="Retry — start fresh with the same task"
      >
        {acting === "retry" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <RefreshCw className="h-3 w-3" />
        )}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-5 px-1.5 text-[10px] text-red-400 hover:bg-red-500/10"
        onClick={(e) => act(e, "cancel", "sessions.delegations.cancel")}
        disabled={acting !== null}
        title="Cancel — stop and dismiss"
      >
        {acting === "cancel" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <X className="h-3 w-3" />
        )}
      </Button>
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export interface ChatDelegationsProps {
  delegations: DelegationEntry[];
}

const COMPLETED_VISIBLE_MS = 2 * 60 * 1000; // Show completed delegations for 2 minutes

export function ChatDelegations({ delegations }: ChatDelegationsProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Re-render every 10s so completed entries auto-hide after COMPLETED_VISIBLE_MS
  useEffect(() => {
    if (delegations.length === 0) {
      return;
    }
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, [delegations.length]);

  // Filter: show active (spawned/running/stale/failed) always,
  // show completed only if ended within the last 2 minutes
  const visible = delegations.filter((d) => {
    if (
      d.status === "running" ||
      d.status === "spawned" ||
      d.status === "stale" ||
      d.status === "failed"
    ) {
      return true;
    }
    // Completed — show briefly then hide
    if (d.status === "completed" && d.endedAt != null) {
      return now - d.endedAt < COMPLETED_VISIBLE_MS;
    }
    return false;
  });

  if (visible.length === 0) {
    return null;
  }

  const activeCount = visible.filter(
    (d) => d.status === "running" || d.status === "spawned",
  ).length;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-10">
      <div className="rounded-lg border border-border/60 bg-card/60 backdrop-blur-sm shadow-sm">
        {/* Header row */}
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="flex w-full items-center gap-2 px-3 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="font-medium">Sub-agent delegations</span>
          {activeCount > 0 && (
            <span className="ml-1 flex items-center gap-1 text-blue-400">
              <Loader2 className="h-3 w-3 animate-spin" />
              {activeCount} active
            </span>
          )}
          <span className="ml-auto text-muted-foreground/60">{visible.length} total</span>
        </button>

        {/* Delegation cards */}
        {!collapsed && (
          <div className="flex flex-col gap-2 px-3 pb-3">
            {visible.map((entry) => (
              <DelegationCard key={entry.runId} entry={entry} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
