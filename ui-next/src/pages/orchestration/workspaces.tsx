import { Layers, Plus, Pencil, RefreshCw, Loader2 } from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/custom/data/data-table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { useGatewayStore } from "@/store/gateway-store";

// ── Types ─────────────────────────────────────────────────────────────

type Workspace = {
  id: string;
  name: string;
  description: string;
  status: string;
  brandColor: string;
  taskPrefix: string;
  createdAt: number;
  updatedAt: number;
};

type WorkspaceForm = {
  name: string;
  description: string;
  brandColor: string;
  taskPrefix: string;
};

const EMPTY_FORM: WorkspaceForm = {
  name: "",
  description: "",
  brandColor: "",
  taskPrefix: "",
};

// ── Helpers ───────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const isActive = status === "active";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        isActive
          ? "border-green-500/30 bg-green-500/15 text-green-400"
          : "border-border bg-muted text-muted-foreground",
      )}
    >
      <span
        className={cn("size-1.5 rounded-full", isActive ? "bg-green-400" : "bg-muted-foreground")}
      />
      {status}
    </span>
  );
}

// ── Dialog ────────────────────────────────────────────────────────────

function WorkspaceDialog({
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
  form: WorkspaceForm;
  setForm: (f: WorkspaceForm) => void;
  onSubmit: () => void;
  isEdit: boolean;
  submitting: boolean;
}) {
  const update = (patch: Partial<WorkspaceForm>) => setForm({ ...form, ...patch });
  const canSubmit = form.name.trim().length > 0 && !submitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Workspace" : "Create Workspace"}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Name *</label>
            <Input
              value={form.name}
              onChange={(e) => update({ name: e.target.value })}
              placeholder="My Workspace"
            />
          </div>
          <div className="grid gap-1.5">
            <label className="text-sm font-medium">Description</label>
            <Input
              value={form.description}
              onChange={(e) => update({ description: e.target.value })}
              placeholder="Optional description"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">Brand Color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={form.brandColor || "#6366f1"}
                  onChange={(e) => update({ brandColor: e.target.value })}
                  className="h-8 w-10 cursor-pointer rounded border border-input"
                />
                <Input
                  value={form.brandColor}
                  onChange={(e) => update({ brandColor: e.target.value })}
                  placeholder="#6366f1"
                  className="font-mono text-xs"
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <label className="text-sm font-medium">Task Prefix</label>
              <Input
                value={form.taskPrefix}
                onChange={(e) => update({ taskPrefix: e.target.value.slice(0, 5).toUpperCase() })}
                placeholder="PROJ"
                maxLength={5}
                className="font-mono"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            {submitting && <Loader2 className="mr-2 size-4 animate-spin" />}
            {isEdit ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────

export function WorkspacesPage() {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<WorkspaceForm>(EMPTY_FORM);
  const [createSubmitting, setCreateSubmitting] = useState(false);

  const [editTarget, setEditTarget] = useState<Workspace | null>(null);
  const [editForm, setEditForm] = useState<WorkspaceForm>(EMPTY_FORM);
  const [editSubmitting, setEditSubmitting] = useState(false);

  const loadWorkspaces = useCallback(() => {
    setLoading(true);
    setError(null);
    sendRpc<{ workspaces: Workspace[] }>("workspaces.list")
      .then((res) => setWorkspaces(res.workspaces ?? []))
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [sendRpc]);

  useEffect(() => {
    if (isConnected) {
      loadWorkspaces();
    }
  }, [isConnected, loadWorkspaces]);

  const handleCreate = () => {
    setCreateSubmitting(true);
    sendRpc("workspaces.create", {
      name: createForm.name.trim(),
      description: createForm.description.trim() || undefined,
      brandColor: createForm.brandColor.trim() || undefined,
      taskPrefix: createForm.taskPrefix.trim() || undefined,
    })
      .then(() => {
        setCreateOpen(false);
        setCreateForm(EMPTY_FORM);
        loadWorkspaces();
      })
      .catch((err) => setError(String(err)))
      .finally(() => setCreateSubmitting(false));
  };

  const openEdit = (ws: Workspace) => {
    setEditTarget(ws);
    setEditForm({
      name: ws.name,
      description: ws.description ?? "",
      brandColor: ws.brandColor ?? "",
      taskPrefix: ws.taskPrefix ?? "",
    });
  };

  const handleEdit = () => {
    if (!editTarget) {
      return;
    }
    setEditSubmitting(true);
    sendRpc("workspaces.update", {
      id: editTarget.id,
      name: editForm.name.trim(),
      description: editForm.description.trim() || undefined,
      brandColor: editForm.brandColor.trim() || undefined,
    })
      .then(() => {
        setEditTarget(null);
        loadWorkspaces();
      })
      .catch((err) => setError(String(err)))
      .finally(() => setEditSubmitting(false));
  };

  const handleToggleStatus = (ws: Workspace) => {
    const newStatus = ws.status === "active" ? "archived" : "active";
    sendRpc("workspaces.update", { id: ws.id, status: newStatus })
      .then(() => loadWorkspaces())
      .catch((err) => setError(String(err)));
  };

  const columns: Column<Workspace>[] = [
    {
      key: "name",
      header: "Name",
      sortable: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          {row.brandColor && (
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: row.brandColor }}
            />
          )}
          <span className="font-medium">{row.name}</span>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      sortable: true,
      render: (row) => <StatusBadge status={row.status} />,
    },
    {
      key: "taskPrefix",
      header: "Task Prefix",
      render: (row) =>
        row.taskPrefix ? (
          <span className="font-mono text-xs text-muted-foreground">{row.taskPrefix}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "createdAt",
      header: "Created",
      sortable: true,
      render: (row) => (
        <span className="text-xs text-muted-foreground">
          {new Date(row.createdAt * 1000).toLocaleString()}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      render: (row) => (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title="Edit"
            onClick={(e) => {
              e.stopPropagation();
              openEdit(row);
            }}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={(e) => {
              e.stopPropagation();
              handleToggleStatus(row);
            }}
          >
            {row.status === "active" ? "Archive" : "Restore"}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Layers className="size-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Workspaces</h2>
          <span className="text-sm text-muted-foreground">({workspaces.length})</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={loadWorkspaces} disabled={loading}>
            <RefreshCw className={cn("mr-1 size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setCreateForm(EMPTY_FORM);
              setCreateOpen(true);
            }}
          >
            <Plus className="mr-1 size-3.5" />
            Create Workspace
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading && workspaces.length === 0 ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <DataTable<Workspace>
          columns={columns}
          data={workspaces}
          keyField="id"
          emptyMessage="No workspaces found."
          pageSize={20}
          compact
        />
      )}

      <WorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        form={createForm}
        setForm={setCreateForm}
        onSubmit={handleCreate}
        isEdit={false}
        submitting={createSubmitting}
      />

      <WorkspaceDialog
        open={editTarget !== null}
        onOpenChange={(v) => {
          if (!v) {
            setEditTarget(null);
          }
        }}
        form={editForm}
        setForm={setEditForm}
        onSubmit={handleEdit}
        isEdit
        submitting={editSubmitting}
      />
    </div>
  );
}
