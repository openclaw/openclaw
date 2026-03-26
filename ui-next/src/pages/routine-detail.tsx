/**
 * Routine detail page — adapted from Paperclip ui/src/pages/RoutineDetail.tsx.
 *
 * Key adaptations:
 * - Removed React Query / TanStack Query — uses sendRpc() via useGateway()
 * - Removed companyId/selectedCompanyId (no multi-tenant)
 * - Removed Paperclip-only components (MarkdownEditor, InlineEntitySelector,
 *   ScheduleEditor, LiveRunWidget, PageSkeleton, AgentIcon)
 * - Uses only shadcn components available in ui-next (Button, Dialog, Separator)
 *   plus native HTML selects/inputs — no Card, Select, Badge (not in this ui-next)
 * - Removed better-auth session checks
 */
import { useEffect, useState, useCallback } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  Clock3,
  Copy,
  Play,
  RefreshCw,
  Repeat,
  Save,
  Trash2,
  Webhook,
  Zap,
  ChevronLeft,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
  createdAt: string;
  updatedAt: string;
};

type TriggerKind = "schedule" | "webhook" | "manual";

type Trigger = {
  id: string;
  routineId: string;
  kind: TriggerKind;
  cronExpr?: string | null;
  tz?: string | null;
  webhookSecret?: string | null;
  webhookUrl?: string | null;
  enabled: boolean;
  createdAt: string;
};

type Run = {
  id: string;
  routineId: string;
  triggerId?: string | null;
  status: string;
  triggeredAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  errorMessage?: string | null;
};

type AgentSummary = { id: string; name: string };
type ProjectSummary = { id: string; name: string; color?: string | null };

/* ── Helpers ────────────────────────────────────────────────────────── */

function formatTs(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function formatDuration(ms: number | null | undefined): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function statusColor(status: string): string {
  switch (status) {
    case "active":
    case "completed":
    case "success":
      return "text-green-600 dark:text-green-400";
    case "running":
      return "text-blue-600 dark:text-blue-400";
    case "failed":
    case "error":
      return "text-red-600 dark:text-red-400";
    default:
      return "text-muted-foreground";
  }
}

type Tab = "overview" | "triggers" | "runs";

/* ── Main component ─────────────────────────────────────────────────── */

export function RoutineDetailPage() {
  const { routineId } = useParams<{ routineId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { sendRpc } = useGateway();
  const { toast } = useToast();

  const activeTab: Tab = (searchParams.get("tab") as Tab) ?? "overview";

  function setTab(tab: Tab) {
    setSearchParams({ tab }, { replace: true });
  }

  const [routine, setRoutine] = useState<Routine | null>(null);
  const [triggers, setTriggers] = useState<Trigger[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Edit state (overview tab)
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editAgentId, setEditAgentId] = useState("");
  const [editProjectId, setEditProjectId] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // New trigger dialog
  const [addTriggerOpen, setAddTriggerOpen] = useState(false);
  const [newTriggerKind, setNewTriggerKind] = useState<TriggerKind>("schedule");
  const [newCronExpr, setNewCronExpr] = useState("0 9 * * 1-5");
  const [newTz, setNewTz] = useState("UTC");
  const [isAddingTrigger, setIsAddingTrigger] = useState(false);
  const [addTriggerError, setAddTriggerError] = useState<string | null>(null);

  const [runningId, setRunningId] = useState<string | null>(null);
  const [deletingTriggerId, setDeletingTriggerId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!routineId) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const [r, t, runList, agentList, projectList] = await Promise.all([
        sendRpc<Routine>("routines.get", { id: routineId }),
        sendRpc<Trigger[]>("routines.triggers.list", { routineId }).catch(
          () => [] as Trigger[],
        ),
        sendRpc<Run[]>("routines.runs.list", { routineId, limit: 50 }).catch(
          () => [] as Run[],
        ),
        sendRpc<AgentSummary[]>("agents.list").catch(() => [] as AgentSummary[]),
        sendRpc<ProjectSummary[]>("projects.list").catch(() => [] as ProjectSummary[]),
      ]);
      setRoutine(r);
      setTriggers(t ?? []);
      setRuns(runList ?? []);
      setAgents(agentList ?? []);
      setProjects(projectList ?? []);
      setEditTitle(r.title);
      setEditDescription(r.description ?? "");
      setEditAgentId(r.assigneeAgentId ?? "");
      setEditProjectId(r.projectId ?? "");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load routine");
    } finally {
      setIsLoading(false);
    }
  }, [routineId, sendRpc]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave() {
    if (!routine) return;
    setIsSaving(true);
    try {
      await sendRpc("routines.update", {
        id: routine.id,
        title: editTitle.trim() || routine.title,
        description: editDescription.trim() || null,
        assigneeAgentId: editAgentId || null,
        projectId: editProjectId || null,
      });
      await load();
      toast("Routine saved.", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save routine.", "error");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleToggleStatus() {
    if (!routine) return;
    const newStatus: RoutineStatus = routine.status === "active" ? "paused" : "active";
    try {
      await sendRpc("routines.update", { id: routine.id, status: newStatus });
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not update routine status.", "error");
    }
  }

  async function handleRunNow() {
    if (!routine) return;
    setRunningId(routine.id);
    try {
      await sendRpc("routines.run", { id: routine.id });
      toast("Run triggered.", "success");
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not start the routine run.", "error");
    } finally {
      setRunningId(null);
    }
  }

  async function handleAddTrigger() {
    if (!routine) return;
    setIsAddingTrigger(true);
    setAddTriggerError(null);
    try {
      await sendRpc("routines.triggers.create", {
        routineId: routine.id,
        kind: newTriggerKind,
        cronExpr: newTriggerKind === "schedule" ? newCronExpr : undefined,
        tz: newTriggerKind === "schedule" ? newTz : undefined,
      });
      setAddTriggerOpen(false);
      await load();
    } catch (err) {
      setAddTriggerError(err instanceof Error ? err.message : "Failed to add trigger");
    } finally {
      setIsAddingTrigger(false);
    }
  }

  async function handleDeleteTrigger(triggerId: string) {
    setDeletingTriggerId(triggerId);
    try {
      await sendRpc("routines.triggers.delete", { id: triggerId });
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not delete trigger.", "error");
    } finally {
      setDeletingTriggerId(null);
    }
  }

  async function copyToClipboard(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      /* ignore */
    }
  }

  if (isLoading) {
    return (
      <div className="p-6 text-center text-sm text-muted-foreground">
        Loading routine...
      </div>
    );
  }

  if (loadError || !routine) {
    return (
      <div className="p-6">
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {loadError ?? "Routine not found"}
        </div>
      </div>
    );
  }

  const agentName = routine.assigneeAgentId
    ? agents.find((a) => a.id === routine.assigneeAgentId)?.name ?? "Unknown"
    : null;
  const projectName = routine.projectId
    ? projects.find((p) => p.id === routine.projectId)?.name ?? "Unknown"
    : null;

  return (
    <div className="flex flex-col min-h-0">
      {/* Page header */}
      <div className="flex items-center gap-3 border-b border-border px-6 py-4 shrink-0">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0"
          onClick={() => navigate("/routines")}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Repeat className="h-4 w-4 text-muted-foreground shrink-0" />
            <h1 className="text-lg font-semibold truncate">{routine.title}</h1>
            <span
              className={[
                "text-xs font-medium px-1.5 py-0.5 rounded-full border",
                statusColor(routine.status),
              ].join(" ")}
            >
              {routine.status}
            </span>
          </div>
          {agentName ?? projectName ? (
            <p className="text-xs text-muted-foreground mt-0.5">
              {[
                agentName ? `Agent: ${agentName}` : null,
                projectName ? `Project: ${projectName}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleToggleStatus()}
            disabled={routine.status === "archived"}
          >
            {routine.status === "active" ? "Pause" : "Enable"}
          </Button>
          <Button
            size="sm"
            onClick={() => void handleRunNow()}
            disabled={runningId !== null || routine.status === "archived"}
          >
            <Play className="mr-1.5 h-3.5 w-3.5" />
            {runningId ? "Running..." : "Run now"}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border px-6 shrink-0">
        {(["overview", "triggers", "runs"] as Tab[]).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setTab(tab)}
            className={[
              "px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors capitalize",
              activeTab === tab
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto p-6">
        {/* Overview tab */}
        {activeTab === "overview" ? (
          <div className="max-w-2xl space-y-5">
            <div className="space-y-1">
              <label htmlFor="detail-title" className="text-sm font-medium">
                Title
              </label>
              <input
                id="detail-title"
                type="text"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="detail-description" className="text-sm font-medium">
                Instructions
              </label>
              <textarea
                id="detail-description"
                className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring min-h-[120px]"
                placeholder="Add instructions..."
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor="detail-agent" className="text-sm font-medium">
                  Assigned agent
                </label>
                <select
                  id="detail-agent"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={editAgentId}
                  onChange={(e) => setEditAgentId(e.target.value)}
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
                <label htmlFor="detail-project" className="text-sm font-medium">
                  Project
                </label>
                <select
                  id="detail-project"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  value={editProjectId}
                  onChange={(e) => setEditProjectId(e.target.value)}
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
            <Separator />
            <dl className="text-xs text-muted-foreground space-y-1">
              <div className="flex gap-2">
                <dt className="font-medium">Concurrency:</dt>
                <dd className="font-mono">{routine.concurrencyPolicy}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-medium">Catch-up:</dt>
                <dd className="font-mono">{routine.catchUpPolicy}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-medium">Created:</dt>
                <dd>{formatTs(routine.createdAt)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="font-medium">Last updated:</dt>
                <dd>{formatTs(routine.updatedAt)}</dd>
              </div>
            </dl>
            <div className="flex">
              <Button onClick={() => void handleSave()} disabled={isSaving}>
                <Save className="mr-2 h-4 w-4" />
                {isSaving ? "Saving..." : "Save changes"}
              </Button>
            </div>
          </div>
        ) : null}

        {/* Triggers tab */}
        {activeTab === "triggers" ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Triggers</h2>
              <Button size="sm" onClick={() => setAddTriggerOpen(true)}>
                <Zap className="mr-1.5 h-3.5 w-3.5" />
                Add trigger
              </Button>
            </div>

            {triggers.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                No triggers yet. Add one to schedule or webhook this routine.
              </div>
            ) : (
              <div className="space-y-3">
                {triggers.map((trigger) => (
                  <div
                    key={trigger.id}
                    className="rounded-md border border-border px-4 py-3 flex items-start justify-between gap-4"
                  >
                    <div className="flex items-start gap-3">
                      {trigger.kind === "schedule" ? (
                        <Clock3 className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                      ) : trigger.kind === "webhook" ? (
                        <Webhook className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                      ) : (
                        <Play className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                      )}
                      <div className="space-y-1">
                        <p className="text-sm font-medium capitalize">{trigger.kind}</p>
                        {trigger.kind === "schedule" && trigger.cronExpr ? (
                          <p className="text-xs text-muted-foreground font-mono">
                            {trigger.cronExpr}
                            {trigger.tz ? ` (${trigger.tz})` : ""}
                          </p>
                        ) : null}
                        {trigger.kind === "webhook" && trigger.webhookUrl ? (
                          <div className="flex items-center gap-2">
                            <p className="text-xs text-muted-foreground font-mono truncate max-w-xs">
                              {trigger.webhookUrl}
                            </p>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() =>
                                void copyToClipboard(trigger.webhookUrl!, trigger.id)
                              }
                            >
                              <Copy className="h-3 w-3" />
                            </Button>
                            {copiedId === trigger.id ? (
                              <span className="text-xs text-green-500">Copied!</span>
                            ) : null}
                          </div>
                        ) : null}
                        <span
                          className={[
                            "text-xs px-1.5 py-0.5 rounded border",
                            trigger.enabled
                              ? "text-green-600 border-green-300 dark:text-green-400"
                              : "text-muted-foreground border-border",
                          ].join(" ")}
                        >
                          {trigger.enabled ? "Enabled" : "Disabled"}
                        </span>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0"
                      disabled={deletingTriggerId === trigger.id}
                      onClick={() => void handleDeleteTrigger(trigger.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {/* Add trigger dialog */}
            <Dialog open={addTriggerOpen} onOpenChange={setAddTriggerOpen}>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>Add trigger</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-2">
                  <div className="space-y-1">
                    <label className="text-sm font-medium">Trigger type</label>
                    <select
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      value={newTriggerKind}
                      onChange={(e) => setNewTriggerKind(e.target.value as TriggerKind)}
                    >
                      <option value="schedule">Schedule (cron)</option>
                      <option value="webhook">Webhook</option>
                      <option value="manual">Manual only</option>
                    </select>
                  </div>
                  {newTriggerKind === "schedule" ? (
                    <>
                      <div className="space-y-1">
                        <label htmlFor="cron-expr" className="text-sm font-medium">
                          Cron expression
                        </label>
                        <input
                          id="cron-expr"
                          type="text"
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          placeholder="0 9 * * 1-5"
                          value={newCronExpr}
                          onChange={(e) => setNewCronExpr(e.target.value)}
                        />
                        <p className="text-xs text-muted-foreground">
                          Standard 5-field cron (minute hour day month weekday).
                        </p>
                      </div>
                      <div className="space-y-1">
                        <label htmlFor="tz" className="text-sm font-medium">
                          Timezone
                        </label>
                        <input
                          id="tz"
                          type="text"
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          placeholder="UTC"
                          value={newTz}
                          onChange={(e) => setNewTz(e.target.value)}
                        />
                      </div>
                    </>
                  ) : null}
                  {addTriggerError ? (
                    <p className="text-sm text-destructive">{addTriggerError}</p>
                  ) : null}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setAddTriggerOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={() => void handleAddTrigger()}
                    disabled={isAddingTrigger}
                  >
                    {isAddingTrigger ? "Adding..." : "Add trigger"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        ) : null}

        {/* Runs tab */}
        {activeTab === "runs" ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Recent runs</h2>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                Refresh
              </Button>
            </div>
            {runs.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                No runs yet. Trigger the routine manually or wait for a scheduled trigger.
              </div>
            ) : (
              <div className="overflow-x-auto rounded-md border border-border">
                <table className="min-w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground border-b border-border bg-muted/30">
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 font-medium">Triggered at</th>
                      <th className="px-3 py-2 font-medium">Started at</th>
                      <th className="px-3 py-2 font-medium">Duration</th>
                      <th className="px-3 py-2 font-medium">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => (
                      <tr
                        key={run.id}
                        className="align-middle border-b border-border last:border-b-0 hover:bg-accent/40"
                      >
                        <td className="px-3 py-2.5">
                          <span className={["text-xs font-medium", statusColor(run.status)].join(" ")}>
                            {run.status.replaceAll("_", " ")}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground">
                          {formatTs(run.triggeredAt)}
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground">
                          {formatTs(run.startedAt)}
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground font-mono text-xs">
                          {formatDuration(run.durationMs)}
                        </td>
                        <td className="px-3 py-2.5 text-destructive text-xs max-w-xs truncate">
                          {run.errorMessage ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
