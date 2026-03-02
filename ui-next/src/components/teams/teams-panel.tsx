import {
  ChevronRight,
  ChevronDown,
  Users,
  CheckCircle2,
  Clock,
  XCircle,
  ExternalLink,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { useTeamRuns, useTeamRun, type TeamRun } from "@/hooks/use-teams";
import { cn } from "@/lib/utils";

// ── Helpers ──────────────────────────────────────────────────────────

function formatTimeSince(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) {
    return "just now";
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}m ago`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)}h ago`;
  }
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatDuration(startMs: number, endMs: number): string {
  const diff = endMs - startMs;
  if (diff < 60_000) {
    return `${Math.floor(diff / 1000)}s`;
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}m`;
  }
  return `${Math.floor(diff / 3_600_000)}h ${Math.floor((diff % 3_600_000) / 60_000)}m`;
}

const STATE_DOT: Record<string, string> = {
  idle: "bg-muted-foreground",
  running: "bg-chart-2",
  done: "bg-primary",
};

// ── Team row detail (lazy-loaded via useTeamRun) ─────────────────────

function TeamRunDetail({ teamRunId }: { teamRunId: string }) {
  const { teamRun, tasks, loading } = useTeamRun(teamRunId);
  const navigate = useNavigate();

  if (loading) {
    return <div className="px-4 pb-3 text-xs text-muted-foreground">Loading...</div>;
  }

  if (!teamRun) {
    return null;
  }

  const doneTasks = tasks.filter((t) => t.status === "completed").length;

  return (
    <div className="border-t px-4 pb-3 pt-2 space-y-2">
      {/* Members */}
      <div>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Members
        </span>
        <div className="mt-1 space-y-1">
          {teamRun.members.map((m) => (
            <button
              key={m.agentId}
              className="flex w-full items-center gap-2 text-xs rounded px-1 py-0.5 -mx-1 hover:bg-muted/40 transition-colors text-left group"
              onClick={(e) => {
                e.stopPropagation();
                void navigate(`/sessions?search=${encodeURIComponent(m.sessionKey)}`);
              }}
              title={`View session ${m.sessionKey}`}
            >
              <span
                className={cn(
                  "inline-block h-2 w-2 shrink-0 rounded-full",
                  STATE_DOT[m.state] ?? STATE_DOT.idle,
                )}
                title={m.state}
              />
              <span className="font-mono">{m.agentId}</span>
              {m.role && <span className="text-muted-foreground">({m.role})</span>}
              <ExternalLink className="h-3 w-3 ml-auto shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
            </button>
          ))}
        </div>
      </div>

      {/* Tasks progress */}
      {tasks.length > 0 && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <CheckCircle2 className="h-3 w-3" />
          <span>
            {doneTasks}/{tasks.length} tasks done
          </span>
        </div>
      )}
    </div>
  );
}

// ── Single team row ──────────────────────────────────────────────────

function TeamRunRow({ run }: { run: TeamRun }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-border/50 last:border-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-muted/30 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}

        {/* Name */}
        <span className="font-medium text-sm truncate">{run.name}</span>

        {/* Leader */}
        <span className="text-xs text-muted-foreground truncate">
          led by <span className="font-mono">{run.leader}</span>
        </span>

        {/* Member count badge */}
        <Badge variant="secondary" className="ml-auto text-[10px] px-1.5 py-0">
          <Users className="h-3 w-3 mr-0.5" />
          {run.members.length}
        </Badge>

        {/* Time info */}
        {run.state === "active" ? (
          <span className="text-[10px] text-muted-foreground whitespace-nowrap flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatTimeSince(run.createdAt)}
          </span>
        ) : (
          <>
            <Badge
              variant={run.state === "completed" ? "outline" : "destructive"}
              className="text-[10px] px-1.5 py-0"
            >
              {run.state === "completed" ? (
                <CheckCircle2 className="h-3 w-3 mr-0.5" />
              ) : (
                <XCircle className="h-3 w-3 mr-0.5" />
              )}
              {run.state}
            </Badge>
            {run.completedAt && (
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                {formatDuration(run.createdAt, run.completedAt)}
              </span>
            )}
          </>
        )}
      </button>

      {expanded && <TeamRunDetail teamRunId={run.id} />}
    </div>
  );
}

// ── Main panel ───────────────────────────────────────────────────────

export function TeamsPanel() {
  const { teamRuns, loading } = useTeamRuns();
  const [showCompleted, setShowCompleted] = useState(false);

  const activeRuns = teamRuns.filter((r) => r.state === "active");
  const completedRuns = teamRuns.filter((r) => r.state !== "active");

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
        Loading team runs...
      </div>
    );
  }

  if (teamRuns.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-6 text-center text-muted-foreground">
        <Users className="h-6 w-6 mx-auto mb-2 opacity-30" />
        <p className="text-sm">No team runs found</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Active Teams */}
      {activeRuns.length > 0 && (
        <div className="rounded-lg border bg-card">
          <div className="flex items-center gap-2 px-4 py-3 border-b">
            <span className="inline-block h-2 w-2 rounded-full bg-chart-2 animate-pulse" />
            <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              Active Teams
            </span>
            <span className="text-xs text-muted-foreground ml-auto">{activeRuns.length}</span>
          </div>
          <div>
            {activeRuns.map((run) => (
              <TeamRunRow key={run.id} run={run} />
            ))}
          </div>
        </div>
      )}

      {/* Completed Teams (collapsed by default) */}
      {completedRuns.length > 0 && (
        <div className="rounded-lg border bg-card">
          <button
            onClick={() => setShowCompleted(!showCompleted)}
            className="flex w-full items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors"
          >
            <div className="flex items-center gap-2">
              {showCompleted ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              )}
              <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                Completed Teams
              </span>
            </div>
            <span className="text-xs text-muted-foreground">{completedRuns.length}</span>
          </button>

          {showCompleted && (
            <div className="border-t">
              {completedRuns.map((run) => (
                <TeamRunRow key={run.id} run={run} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
