import {
  FolderKanban,
  FolderOpen,
  ExternalLink,
  Search,
  RefreshCw,
  Loader2,
  Trash2,
  Plus,
  Pencil,
  Star,
  Settings2,
  Check,
  X,
} from "lucide-react";
import { useState, useEffect, useCallback, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/custom/data/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { useGatewayStore } from "@/store/gateway-store";

// ── Types ────────────────────────────────────────────────────────────

type ProjectEntry = {
  id: string;
  name: string;
  path: string;
  type: string;
  tech: string;
  status: string;
  isDefault: boolean;
  keywords: string[];
};

type ProjectFormData = {
  id: string;
  name: string;
  path: string;
  type: string;
  tech: string;
  status: string;
  isDefault: boolean;
  keywords: string;
};

type ScopeFilter = "all" | "active" | "archived" | "internal" | "external";

type ActionMessage = { type: "error" | "success"; text: string };

const EMPTY_FORM: ProjectFormData = {
  id: "",
  name: "",
  path: "",
  type: "",
  tech: "",
  status: "active",
  isDefault: false,
  keywords: "",
};

// ── Helpers ──────────────────────────────────────────────────────────

/** Determine if a project is internal (path inside rootPath) or external. */
function isInternalProject(projectPath: string, rootPath: string): boolean {
  if (!rootPath) {
    return false;
  }
  const normalized = projectPath.endsWith("/") ? projectPath : projectPath + "/";
  const normalizedRoot = rootPath.endsWith("/") ? rootPath : rootPath + "/";
  return normalized.startsWith(normalizedRoot) || projectPath === rootPath;
}

function statusColor(status: string) {
  switch (status) {
    case "active":
      return "bg-green-500/15 text-green-400 border-green-500/30";
    case "archived":
      return "bg-yellow-500/15 text-yellow-400 border-yellow-500/30";
    case "paused":
      return "bg-orange-500/15 text-orange-400 border-orange-500/30";
    case "mvp":
      return "bg-purple-500/15 text-purple-400 border-purple-500/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        statusColor(status),
      )}
    >
      <span
        className={cn("size-1.5 rounded-full", {
          "bg-green-400": status === "active",
          "bg-yellow-400": status === "archived",
          "bg-orange-400": status === "paused",
          "bg-purple-400": status === "mvp",
          "bg-muted-foreground": !["active", "archived", "paused", "mvp"].includes(status),
        })}
      />
      {status}
    </span>
  );
}

function ScopeBadge({ isInternal }: { isInternal: boolean }) {
  return isInternal ? (
    <span className="inline-flex items-center gap-1 rounded-full border border-blue-500/30 bg-blue-500/15 px-2 py-0.5 text-xs font-medium text-blue-400">
      <FolderOpen className="size-3" />
      internal
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full border border-cyan-500/30 bg-cyan-500/15 px-2 py-0.5 text-xs font-medium text-cyan-400">
      <ExternalLink className="size-3" />
      external
    </span>
  );
}

function formToEntry(form: ProjectFormData): Record<string, unknown> {
  return {
    id: form.id.trim(),
    name: form.name.trim() || form.id.trim(),
    path: form.path.trim(),
    type: form.type.trim(),
    tech: form.tech.trim(),
    status: form.status,
    isDefault: form.isDefault,
    keywords: form.keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
  };
}

function entryToForm(entry: ProjectEntry): ProjectFormData {
  return {
    id: entry.id,
    name: entry.name,
    path: entry.path,
    type: entry.type,
    tech: entry.tech,
    status: entry.status,
    isDefault: entry.isDefault,
    keywords: entry.keywords.join(", "),
  };
}

// ── Form Dialog ──────────────────────────────────────────────────────

function ProjectFormDialog({
  open,
  onOpenChange,
  form,
  setForm,
  onSubmit,
  isEdit,
  submitting,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  form: ProjectFormData;
  setForm: (f: ProjectFormData) => void;
  onSubmit: () => void;
  isEdit: boolean;
  submitting: boolean;
}) {
  const update = (patch: Partial<ProjectFormData>) => setForm({ ...form, ...patch });
  const canSubmit = form.id.trim() && form.path.trim() && !submitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Project" : "Add Project"}</DialogTitle>
          <DialogDescription>
            {isEdit ? "Update project details." : "Register a new project workspace."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 py-2">
          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Project ID</label>
            <Input
              value={form.id}
              onChange={(e) => update({ id: e.target.value })}
              placeholder="my-project"
              disabled={isEdit}
              className={isEdit ? "opacity-60" : ""}
            />
          </div>

          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Display Name</label>
            <Input
              value={form.name}
              onChange={(e) => update({ name: e.target.value })}
              placeholder="My Project"
            />
          </div>

          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Path</label>
            <Input
              value={form.path}
              onChange={(e) => update({ path: e.target.value })}
              placeholder="/Users/you/dev/my-project"
              className="font-mono text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Projects inside the root path are automatically marked as internal.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">Type</label>
              <Input
                value={form.type}
                onChange={(e) => update({ type: e.target.value })}
                placeholder="web app"
              />
            </div>
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">Tech Stack</label>
              <Input
                value={form.tech}
                onChange={(e) => update({ tech: e.target.value })}
                placeholder="TypeScript, React"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Status</label>
            <div className="flex gap-1">
              {["active", "paused", "mvp"].map((s) => (
                <Button
                  key={s}
                  type="button"
                  size="sm"
                  variant={form.status === s ? "default" : "outline"}
                  onClick={() => update({ status: s })}
                  className="capitalize"
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <label className="text-sm font-medium">Default Project</label>
            <Switch checked={form.isDefault} onCheckedChange={(v) => update({ isDefault: v })} />
          </div>

          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Keywords</label>
            <Input
              value={form.keywords}
              onChange={(e) => update({ keywords: e.target.value })}
              placeholder="keyword1, keyword2"
            />
            <p className="text-xs text-muted-foreground">
              Comma-separated terms for project matching.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
            {isEdit ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Archive Confirmation Dialog ──────────────────────────────────────

function ArchiveDialog({
  open,
  onOpenChange,
  projectName,
  onConfirm,
  submitting,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  projectName: string;
  onConfirm: () => void;
  submitting: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Archive Project</DialogTitle>
          <DialogDescription>
            Are you sure you want to archive <strong>{projectName}</strong>? It will be hidden from
            the active list but can be found under the Archived filter.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={submitting}>
            {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
            Archive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Page ────────────────────────────────────────────────────────

export function ProjectsPage() {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");

  // Data
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [rootPath, setRootPath] = useState("");
  const [loading, setLoading] = useState(false);

  // Root path editing
  const [editingRootPath, setEditingRootPath] = useState(false);
  const [rootPathDraft, setRootPathDraft] = useState("");
  const [rootPathSaving, setRootPathSaving] = useState(false);

  // UI state
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [actionMessage, setActionMessage] = useState<ActionMessage | null>(null);

  // Add dialog
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<ProjectFormData>(EMPTY_FORM);
  const [addSubmitting, setAddSubmitting] = useState(false);

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<ProjectFormData>(EMPTY_FORM);
  const [editSubmitting, setEditSubmitting] = useState(false);

  // Archive dialog
  const [archiveTarget, setArchiveTarget] = useState<ProjectEntry | null>(null);
  const [archiveSubmitting, setArchiveSubmitting] = useState(false);

  // ── Data Fetching ────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await sendRpc<{ projects: ProjectEntry[]; rootPath?: string }>("projects.list");
      setProjects(res.projects ?? []);
      setRootPath(res.rootPath ?? "");
      setActionMessage(null);
    } catch (err) {
      setActionMessage({
        type: "error",
        text: `Failed to load projects: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setLoading(false);
    }
  }, [sendRpc]);

  useEffect(() => {
    if (isConnected) {
      void loadData();
    }
  }, [isConnected, loadData]);

  // ── Root Path ────────────────────────────────────────────────────

  const handleSaveRootPath = async () => {
    setRootPathSaving(true);
    try {
      await sendRpc("projects.setRootPath", { rootPath: rootPathDraft.trim() });
      setRootPath(rootPathDraft.trim());
      setEditingRootPath(false);
      setActionMessage({ type: "success", text: "Root path updated." });
    } catch (err) {
      setActionMessage({
        type: "error",
        text: `Failed to set root path: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setRootPathSaving(false);
    }
  };

  // ── Filtering ────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    let list = projects;
    if (scopeFilter !== "all") {
      list = list.filter((p) => {
        const internal = isInternalProject(p.path, rootPath);
        if (scopeFilter === "internal") {
          return internal;
        }
        if (scopeFilter === "external") {
          return !internal;
        }
        if (scopeFilter === "archived") {
          return p.status === "archived";
        }
        // "active" = non-archived
        return p.status !== "archived";
      });
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.id.toLowerCase().includes(q) ||
          p.path.toLowerCase().includes(q) ||
          p.tech.toLowerCase().includes(q),
      );
    }
    return list;
  }, [projects, scopeFilter, search, rootPath]);

  // ── Counts ───────────────────────────────────────────────────────

  const counts = useMemo(() => {
    const c = { all: projects.length, active: 0, archived: 0, internal: 0, external: 0 };
    for (const p of projects) {
      if (p.status === "archived") {
        c.archived++;
      } else {
        c.active++;
      }
      if (isInternalProject(p.path, rootPath)) {
        c.internal++;
      } else {
        c.external++;
      }
    }
    return c;
  }, [projects, rootPath]);

  // ── CRUD Handlers ────────────────────────────────────────────────

  const handleAdd = async () => {
    setAddSubmitting(true);
    try {
      await sendRpc("projects.add", formToEntry(addForm));
      setAddOpen(false);
      setAddForm(EMPTY_FORM);
      setActionMessage({ type: "success", text: "Project added." });
      await loadData();
    } catch (err) {
      setActionMessage({
        type: "error",
        text: `Add failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setAddSubmitting(false);
    }
  };

  const openEdit = (row: ProjectEntry) => {
    setEditForm(entryToForm(row));
    setEditOpen(true);
  };

  const handleEdit = async () => {
    setEditSubmitting(true);
    try {
      const data = formToEntry(editForm);
      await sendRpc("projects.update", data);
      setEditOpen(false);
      setActionMessage({ type: "success", text: "Project updated." });
      await loadData();
    } catch (err) {
      setActionMessage({
        type: "error",
        text: `Update failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setEditSubmitting(false);
    }
  };

  const handleArchive = async () => {
    if (!archiveTarget) {
      return;
    }
    setArchiveSubmitting(true);
    try {
      await sendRpc("projects.archive", { id: archiveTarget.id });
      setArchiveTarget(null);
      setActionMessage({ type: "success", text: "Project archived." });
      await loadData();
    } catch (err) {
      setActionMessage({
        type: "error",
        text: `Archive failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setArchiveSubmitting(false);
    }
  };

  // ── Table Columns ────────────────────────────────────────────────

  const columns: Column<ProjectEntry>[] = [
    {
      key: "name",
      header: "Name",
      sortable: true,
      render: (row) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{row.name}</div>
          <div className="truncate text-xs text-muted-foreground">{row.id}</div>
        </div>
      ),
    },
    {
      key: "path",
      header: "Path",
      sortable: true,
      className: "hidden lg:table-cell",
      render: (row) => (
        <span className="truncate font-mono text-xs text-muted-foreground" title={row.path}>
          {row.path}
        </span>
      ),
    },
    {
      key: "scope",
      header: "Scope",
      sortable: true,
      render: (row) => <ScopeBadge isInternal={isInternalProject(row.path, rootPath)} />,
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: "isDefault",
      header: "Default",
      className: "hidden sm:table-cell",
      render: (row) =>
        row.isDefault ? (
          <Star className="size-4 fill-yellow-400 text-yellow-400" />
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "actions",
      header: "",
      render: (row) => {
        const isScanned = row.type === "internal";
        return (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={isScanned}
              title={isScanned ? "Auto-scanned projects cannot be edited" : "Edit"}
              onClick={(e) => {
                e.stopPropagation();
                openEdit(row);
              }}
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-destructive hover:text-destructive"
              disabled={isScanned || row.status === "archived"}
              title={
                isScanned
                  ? "Auto-scanned projects cannot be archived"
                  : row.status === "archived"
                    ? "Already archived"
                    : "Archive"
              }
              onClick={(e) => {
                e.stopPropagation();
                setArchiveTarget(row);
              }}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        );
      },
    },
  ];

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FolderKanban className="size-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Projects</h2>
          <span className="text-sm text-muted-foreground">({filtered.length})</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void loadData()} disabled={loading}>
            <RefreshCw className={cn("mr-1 size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setAddForm(EMPTY_FORM);
              setAddOpen(true);
            }}
          >
            <Plus className="mr-1 size-3.5" />
            Add Project
          </Button>
        </div>
      </div>

      {/* Root path config */}
      <div className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm">
        <Settings2 className="size-4 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">Root path:</span>
        {editingRootPath ? (
          <>
            <Input
              value={rootPathDraft}
              onChange={(e) => setRootPathDraft(e.target.value)}
              placeholder="/Users/you/dev"
              className="h-7 max-w-sm font-mono text-xs"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void handleSaveRootPath();
                }
                if (e.key === "Escape") {
                  setEditingRootPath(false);
                }
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => void handleSaveRootPath()}
              disabled={rootPathSaving}
            >
              {rootPathSaving ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => setEditingRootPath(false)}
            >
              <X className="size-3.5" />
            </Button>
          </>
        ) : (
          <>
            <span className="truncate font-mono text-xs" title={rootPath}>
              {rootPath || <span className="italic text-muted-foreground">not set</span>}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              title="Edit root path"
              onClick={() => {
                setRootPathDraft(rootPath);
                setEditingRootPath(true);
              }}
            >
              <Pencil className="size-3" />
            </Button>
          </>
        )}
        {!editingRootPath && rootPath && (
          <span className="ml-auto text-xs text-muted-foreground">
            Projects inside this path are internal, outside are external.
          </span>
        )}
      </div>

      {/* Scope filter tabs */}
      <div className="flex flex-wrap items-center gap-1">
        {(["all", "active", "archived", "internal", "external"] as const).map((f) => (
          <Button
            key={f}
            variant={scopeFilter === f ? "default" : "outline"}
            size="sm"
            onClick={() => setScopeFilter(f)}
            className="capitalize"
          >
            {f}
            <span className="ml-1 text-xs opacity-70">({counts[f]})</span>
          </Button>
        ))}
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search projects..."
          className="pl-8"
        />
      </div>

      {/* Action message */}
      {actionMessage && (
        <div
          className={cn(
            "rounded-md border px-3 py-2 text-sm",
            actionMessage.type === "error"
              ? "border-red-500/30 bg-red-500/10 text-red-400"
              : "border-green-500/30 bg-green-500/10 text-green-400",
          )}
        >
          {actionMessage.text}
        </div>
      )}

      {/* Table */}
      {loading && projects.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <DataTable<ProjectEntry>
          columns={columns}
          data={filtered}
          keyField="id"
          emptyMessage="No projects found."
          pageSize={20}
          compact
        />
      )}

      {/* Add Dialog */}
      <ProjectFormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        form={addForm}
        setForm={setAddForm}
        onSubmit={() => void handleAdd()}
        isEdit={false}
        submitting={addSubmitting}
      />

      {/* Edit Dialog */}
      <ProjectFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        form={editForm}
        setForm={setEditForm}
        onSubmit={() => void handleEdit()}
        isEdit
        submitting={editSubmitting}
      />

      {/* Archive Dialog */}
      <ArchiveDialog
        open={archiveTarget !== null}
        onOpenChange={(v) => {
          if (!v) {
            setArchiveTarget(null);
          }
        }}
        projectName={archiveTarget?.name ?? ""}
        onConfirm={() => void handleArchive()}
        submitting={archiveSubmitting}
      />
    </div>
  );
}
