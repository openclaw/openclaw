/**
 * Routines management page — adapted from Paperclip ui/src/pages/Routines.tsx.
 *
 * Key adaptations:
 * - Removed React Query / TanStack Query — uses sendRpc() via useGateway()
 * - Removed companyId/selectedCompanyId references (no multi-tenant)
 * - Removed Paperclip-only components (InlineEntitySelector, MarkdownEditor,
 *   PageSkeleton, EmptyState, AgentIcon) — replaced with native HTML + Tailwind
 * - Removed better-auth session checks
 * - Uses only shadcn components available in ui-next (Button, Dialog,
 *   Collapsible, DropdownMenu) — no Card, Select (not in this ui-next)
 */
import { useEffect, useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Plus,
  Repeat,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useGateway } from "@/hooks/use-gateway";
import { useToast } from "@/components/ui/custom/toast";

/* ── Types ─────────────────────────────────────────────────────────── */

type RoutineStatus = "active" | "paused" | "archived";

type Routine = {
  id: string;
  title: string;
  description?: string | null;
  status: RoutineStatus;
  assigneeAgentId?: string | null;
  projectId?: string | null;
  concurrencyPolicy: string;
  catchUpPolicy: string;
  lastRun?: {
    triggeredAt: string | null;
    status: string;
  } | null;
  createdAt: string;
};

type AgentSummary = {
  id: string;
  name: string;
  status?: string;
};

type ProjectSummary = {
  id: string;
  name: string;
  color?: string | null;
};

type RoutineDraft = {
  title: string;
  description: string;
  assigneeAgentId: string;
  projectId: string;
  concurrencyPolicy: string;
  catchUpPolicy: string;
};

/* ── Constants ──────────────────────────────────────────────────────── */

const CONCURRENCY_POLICIES = [
  "coalesce_if_active",
  "always_enqueue",
  "skip_if_active",
] as const;
const CATCH_UP_POLICIES = ["skip_missed", "enqueue_missed_with_cap"] as const;

const CONCURRENCY_DESCRIPTIONS: Record<string, string> = {
  coalesce_if_active: "If a run is already active, keep just one follow-up run queued.",
  always_enqueue: "Queue every trigger occurrence, even if the routine is already running.",
  skip_if_active: "Drop new trigger occurrences while a run is still active.",
};
const CATCH_UP_DESCRIPTIONS: Record<string, string> = {
  skip_missed: "Ignore windows that were missed while the scheduler or routine was paused.",
  enqueue_missed_with_cap: "Catch up missed schedule windows in capped batches after recovery.",
};

const DEFAULT_DRAFT: RoutineDraft = {
  title: "",
  description: "",
  assigneeAgentId: "",
  projectId: "",
  concurrencyPolicy: "coalesce_if_active",
  catchUpPolicy: "skip_missed",
};

/* ── Helpers ────────────────────────────────────────────────────────── */

function formatLastRun(value: string | null | undefined): string {
  if (!value) return "Never";
  return new Date(value).toLocaleString();
}

function nextStatus(current: RoutineStatus, enable: boolean): RoutineStatus {
  if (current === "archived" && enable) return "active";
  return enable ? "active" : "paused";
}

/* ── Main component ─────────────────────────────────────────────────── */

export function RoutinesPage() {
  const { sendRpc } = useGateway();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [routines, setRoutines] = useState<Routine[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [composerOpen, setComposerOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [draft, setDraft] = useState<RoutineDraft>(DEFAULT_DRAFT);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [runningId, setRunningId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const [routineList, agentList, projectList] = await Promise.all([
        sendRpc<Routine[]>("routines.list"),
        sendRpc<AgentSummary[]>("agents.list").catch(() => [] as AgentSummary[]),
        sendRpc<ProjectSummary[]>("projects.list").catch(() => [] as ProjectSummary[]),
      ]);
      setRoutines(routineList ?? []);
      setAgents((agentList ?? []).filter((a) => a.status !== "terminated"));
      setProjects(projectList ?? []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load routines");
    } finally {
      setIsLoading(false);
    }
  }, [sendRpc]);

  useEffect(() => {
    void load();
  }, [load]);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);

  async function handleCreate() {
    if (!draft.title.trim()) return;
    setIsCreating(true);
    setCreateError(null);
    try {
      const routine = await sendRpc<Routine>("routines.create", {
        title: draft.title.trim(),
        description: draft.description.trim() || null,
        assigneeAgentId: draft.assigneeAgentId || null,
        projectId: draft.projectId || null,
        concurrencyPolicy: draft.concurrencyPolicy,
        catchUpPolicy: draft.catchUpPolicy,
      });
      setDraft(DEFAULT_DRAFT);
      setComposerOpen(false);
      setAdvancedOpen(false);
      toast("Routine created — add the first trigger to turn it into a live workflow.", "success");
      await load();
      navigate(`/routines/${routine.id}?tab=triggers`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create routine");
    } finally {
      setIsCreating(false);
    }
  }

  async function handleToggleStatus(routine: Routine, enable: boolean) {
    setTogglingId(routine.id);
    try {
      await sendRpc("routines.update", {
        id: routine.id,
        status: nextStatus(routine.status, enable),
      });
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not update the routine.", "error");
    } finally {
      setTogglingId(null);
    }
  }

  async function handleArchive(routine: Routine) {
    const newStatus = routine.status === "archived" ? "active" : "archived";
    try {
      await sendRpc("routines.update", { id: routine.id, status: newStatus });
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not archive the routine.", "error");
    }
  }

  async function handleRunNow(routine: Routine) {
    setRunningId(routine.id);
    try {
      await sendRpc("routines.run", { id: routine.id });
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not start the routine run.", "error");
    } finally {
      setRunningId(null);
    }
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Repeat className="h-6 w-6" />
            Routines
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-400">
              Beta
            </span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Recurring work definitions that materialize into auditable execution runs.
          </p>
        </div>
        <Button onClick={() => setComposerOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create routine
        </Button>
      </div>

      {/* Create routine dialog */}
      <Dialog
        open={composerOpen}
        onOpenChange={(open) => {
          if (!isCreating) setComposerOpen(open);
        }}
      >
        <DialogContent className="max-w-2xl gap-0 overflow-hidden p-0">
          {/* Dialog header */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
                New routine
              </p>
              <p className="text-sm text-muted-foreground">
                Define the recurring work first. Trigger setup comes next on the detail page.
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setComposerOpen(false);
                setAdvancedOpen(false);
              }}
              disabled={isCreating}
            >
              Cancel
            </Button>
          </div>

          <div className="px-5 pt-5 pb-3 space-y-4">
            {/* Title */}
            <div className="space-y-1">
              <label htmlFor="routine-title" className="text-sm font-medium">
                Title
              </label>
              <input
                id="routine-title"
                type="text"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                placeholder="Routine title"
                value={draft.title}
                autoFocus
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                  }
                }}
              />
            </div>

            {/* Instructions */}
            <div className="space-y-1">
              <label htmlFor="routine-description" className="text-sm font-medium">
                Instructions
              </label>
              <textarea
                id="routine-description"
                className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring min-h-[100px]"
                placeholder="Add instructions..."
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              />
            </div>

            {/* Agent + Project selects */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor="routine-agent" className="text-sm font-medium">
                  Assigned agent
                </label>
                <select
                  id="routine-agent"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={draft.assigneeAgentId}
                  onChange={(e) => setDraft((d) => ({ ...d, assigneeAgentId: e.target.value }))}
                >
                  <option value="">No assignee</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label htmlFor="routine-project" className="text-sm font-medium">
                  Project
                </label>
                <select
                  id="routine-project"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={draft.projectId}
                  onChange={(e) => setDraft((d) => ({ ...d, projectId: e.target.value }))}
                >
                  <option value="">No project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Advanced settings */}
          <div className="border-t border-border/60 px-5 py-3">
            <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <CollapsibleTrigger className="flex w-full items-center justify-between text-left">
                <div>
                  <p className="text-sm font-medium">Advanced delivery settings</p>
                  <p className="text-sm text-muted-foreground">Concurrency and catch-up policies.</p>
                </div>
                {advancedOpen ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-3">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                      Concurrency
                    </p>
                    <select
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={draft.concurrencyPolicy}
                      onChange={(e) => setDraft((d) => ({ ...d, concurrencyPolicy: e.target.value }))}
                    >
                      {CONCURRENCY_POLICIES.map((v) => (
                        <option key={v} value={v}>
                          {v.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">
                      {CONCURRENCY_DESCRIPTIONS[draft.concurrencyPolicy]}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                      Catch-up
                    </p>
                    <select
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={draft.catchUpPolicy}
                      onChange={(e) => setDraft((d) => ({ ...d, catchUpPolicy: e.target.value }))}
                    >
                      {CATCH_UP_POLICIES.map((v) => (
                        <option key={v} value={v}>
                          {v.replaceAll("_", " ")}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">
                      {CATCH_UP_DESCRIPTIONS[draft.catchUpPolicy]}
                    </p>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>

          {/* Footer */}
          <div className="flex flex-col gap-3 border-t border-border/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              After creation, you will be taken to trigger setup.
            </p>
            <div className="flex flex-col gap-2 sm:items-end">
              <Button
                onClick={() => void handleCreate()}
                disabled={isCreating || !draft.title.trim()}
              >
                <Plus className="mr-2 h-4 w-4" />
                {isCreating ? "Creating..." : "Create routine"}
              </Button>
              {createError ? (
                <p className="text-sm text-destructive">{createError}</p>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Error state */}
      {loadError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {loadError}
        </div>
      ) : null}

      {/* Loading state */}
      {isLoading ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          Loading routines...
        </div>
      ) : null}

      {/* Empty state */}
      {!isLoading && !loadError && routines.length === 0 ? (
        <div className="py-12 flex flex-col items-center gap-3 text-muted-foreground">
          <Repeat className="h-10 w-10 opacity-30" />
          <p className="text-sm">
            No routines yet. Use Create routine to define the first recurring workflow.
          </p>
        </div>
      ) : null}

      {/* Routines table */}
      {!isLoading && routines.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/30">
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Project</th>
                <th className="px-3 py-2 font-medium">Agent</th>
                <th className="px-3 py-2 font-medium">Last run</th>
                <th className="px-3 py-2 font-medium">Enabled</th>
                <th className="w-12 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {routines.map((routine) => {
                const enabled = routine.status === "active";
                const isArchived = routine.status === "archived";
                const isToggling = togglingId === routine.id;
                const isRunning = runningId === routine.id;
                const agent = routine.assigneeAgentId
                  ? agentById.get(routine.assigneeAgentId)
                  : null;
                const project = routine.projectId
                  ? projectById.get(routine.projectId)
                  : null;
                return (
                  <tr
                    key={routine.id}
                    className="align-middle border-b border-border transition-colors hover:bg-accent/50 last:border-b-0 cursor-pointer"
                    onClick={() => navigate(`/routines/${routine.id}`)}
                  >
                    <td className="px-3 py-2.5">
                      <div className="min-w-[180px]">
                        <span className="font-medium">{routine.title}</span>
                        {isArchived || routine.status === "paused" ? (
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {isArchived ? "archived" : "paused"}
                          </div>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      {project ? (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <span
                            className="shrink-0 h-3 w-3 rounded-sm"
                            style={{ backgroundColor: project.color ?? "#6366f1" }}
                          />
                          <span className="truncate">{project.name}</span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {agent ? (
                        <span className="text-sm text-muted-foreground truncate">
                          {agent.name}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      <div>{formatLastRun(routine.lastRun?.triggeredAt)}</div>
                      {routine.lastRun ? (
                        <div className="mt-0.5 text-xs">
                          {routine.lastRun.status.replaceAll("_", " ")}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          role="switch"
                          data-slot="toggle"
                          aria-checked={enabled}
                          aria-label={enabled ? `Disable ${routine.title}` : `Enable ${routine.title}`}
                          disabled={isToggling || isArchived}
                          className={[
                            "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                            enabled ? "bg-foreground" : "bg-muted",
                            isToggling || isArchived ? "cursor-not-allowed opacity-50" : "",
                          ].join(" ")}
                          onClick={() => void handleToggleStatus(routine, !enabled)}
                        >
                          <span
                            className={[
                              "inline-block h-5 w-5 rounded-full bg-background shadow-sm transition-transform",
                              enabled ? "translate-x-5" : "translate-x-0.5",
                            ].join(" ")}
                          />
                        </button>
                        <span className="text-xs text-muted-foreground">
                          {isArchived ? "Archived" : enabled ? "On" : "Off"}
                        </span>
                      </div>
                    </td>
                    <td
                      className="px-3 py-2.5 text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            aria-label={`More actions for ${routine.title}`}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => navigate(`/routines/${routine.id}`)}
                          >
                            View / Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={isRunning || isArchived}
                            onClick={() => void handleRunNow(routine)}
                          >
                            {isRunning ? "Running..." : "Run now"}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            disabled={isToggling || isArchived}
                            onClick={() => void handleToggleStatus(routine, !enabled)}
                          >
                            {enabled ? "Pause" : "Enable"}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            disabled={isToggling}
                            onClick={() => void handleArchive(routine)}
                          >
                            {isArchived ? "Restore" : "Archive"}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
