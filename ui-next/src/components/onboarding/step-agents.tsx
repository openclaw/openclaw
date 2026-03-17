import {
  Users,
  Loader2,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
} from "lucide-react";
import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useGateway } from "@/hooks/use-gateway";
import { useOnboarding } from "@/hooks/use-onboarding";
import { getAgentTierInfo, getAgentChildren, DEPARTMENT_COLORS } from "@/lib/matrix-tier-map";

type Props = { onValidChange: (valid: boolean) => void };

type AgentSummary = {
  agentId: string;
  name?: string;
  model?: string;
};

// Department heads and their departments
const DEPARTMENTS = [
  { head: "Neo", label: "Engineering", department: "engineering" },
  { head: "Morpheus", label: "Marketing", department: "marketing" },
  { head: "Trinity", label: "Finance", department: "finance" },
] as const;

export function StepAgents({ onValidChange }: Props) {
  const { sendRpc } = useGateway();
  const { validatePath } = useOnboarding();
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);

  // Department state: which departments are enabled
  const [enabledDepts, setEnabledDepts] = useState<Set<string>>(
    new Set(DEPARTMENTS.map((d) => d.department)),
  );
  // Per-agent overrides: individually disabled agents within an enabled department
  const [disabledAgents, setDisabledAgents] = useState<Set<string>>(new Set());
  // Expanded departments (to show individual agents)
  const [expandedDepts, setExpandedDepts] = useState<Set<string>>(new Set());
  // Confirmation dialog state
  const [confirmDisable, setConfirmDisable] = useState<string | null>(null);

  // Workspace path
  const [workspacePath, setWorkspacePath] = useState("~/.openclaw/workspace");
  const [pathValidation, setPathValidation] = useState<{
    valid: boolean;
    exists: boolean;
    writable: boolean;
  } | null>(null);
  const [validatingPath, setValidatingPath] = useState(false);

  // Load agents
  useEffect(() => {
    const load = async () => {
      try {
        const result = await sendRpc<{ agents: AgentSummary[] }>("agents.list", {});
        setAgents(result.agents ?? []);
      } catch {
        // No agents yet
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [sendRpc]);

  // Always valid — agents are pre-configured, toggles are informational for P2
  useEffect(() => {
    onValidChange(true);
  }, [onValidChange]);

  // Validate workspace path
  const handleValidatePath = useCallback(async () => {
    if (!workspacePath.trim()) {
      return;
    }
    setValidatingPath(true);
    try {
      const result = await validatePath(workspacePath);
      setPathValidation({
        valid: result.valid,
        exists: result.exists,
        writable: result.writable,
      });
    } catch {
      setPathValidation({ valid: false, exists: false, writable: false });
    } finally {
      setValidatingPath(false);
    }
  }, [workspacePath, validatePath]);

  // Toggle department
  const toggleDepartment = useCallback(
    (dept: string, headName: string) => {
      const isEnabled = enabledDepts.has(dept);

      if (isEnabled) {
        // Disabling: show confirmation with worker count
        const workers = getAgentChildren(headName);
        setConfirmDisable(dept);
        // If user confirms, the confirm handler will do the actual disable
        // For now just set the confirmation state
        if (workers.length === 0) {
          // No workers, just disable
          setEnabledDepts((prev) => {
            const next = new Set(prev);
            next.delete(dept);
            return next;
          });
        }
      } else {
        // Enabling: re-enable the department head only, not workers
        setEnabledDepts((prev) => new Set([...prev, dept]));
        // Don't auto-enable individually disabled workers
      }
    },
    [enabledDepts],
  );

  // Confirm disable department
  const handleConfirmDisable = useCallback((dept: string) => {
    setEnabledDepts((prev) => {
      const next = new Set(prev);
      next.delete(dept);
      return next;
    });
    setConfirmDisable(null);
  }, []);

  // Toggle individual agent
  const toggleAgent = useCallback((agentId: string) => {
    setDisabledAgents((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) {
        next.delete(agentId);
      } else {
        next.add(agentId);
      }
      return next;
    });
  }, []);

  // Toggle expanded department
  const toggleExpanded = useCallback((dept: string) => {
    setExpandedDepts((prev) => {
      const next = new Set(prev);
      if (next.has(dept)) {
        next.delete(dept);
      } else {
        next.add(dept);
      }
      return next;
    });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold">Agent Team</h2>
          <p className="text-sm text-muted-foreground mt-1">Configure your agent organization.</p>
        </div>
        <div className="rounded-lg border border-border p-6 text-center text-sm text-muted-foreground">
          <Users className="h-8 w-8 mx-auto mb-2 text-muted-foreground/50" />
          No agents configured yet. Agents will be available after setup.
        </div>
      </div>
    );
  }

  // Count active agents
  const activeCount = agents.filter((a) => {
    const tier = getAgentTierInfo(a.agentId);
    if (!enabledDepts.has(tier.department) && tier.department !== "operations") {
      return false;
    }
    return !disabledAgents.has(a.agentId);
  }).length;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Agent Team</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Toggle departments on/off and review your agent organization.{" "}
          <span className="font-medium text-foreground">{activeCount}</span> of {agents.length}{" "}
          agents active.
        </p>
      </div>

      {/* Tier 1 — always on */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-center gap-2">
          <div
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: DEPARTMENT_COLORS.operations }}
          />
          <h3 className="text-sm font-semibold">Operator1 (COO)</h3>
          <Badge variant="outline" className="text-xs">
            Tier 1
          </Badge>
          <span className="text-xs text-muted-foreground ml-auto">Always active</span>
        </div>
      </div>

      {/* Departments */}
      {DEPARTMENTS.map(({ head, label, department }) => {
        const isEnabled = enabledDepts.has(department);
        const workers = getAgentChildren(head);
        const activeWorkers = workers.filter((w) => !disabledAgents.has(w));
        const isExpanded = expandedDepts.has(department);
        const color = DEPARTMENT_COLORS[department] ?? "#888";

        return (
          <div key={department} className="rounded-lg border border-border p-4 space-y-3">
            {/* Department header */}
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">{label}</h3>
                  <Badge variant="outline" className="text-xs">
                    {head} — Tier 2
                  </Badge>
                </div>
                <span className="text-xs text-muted-foreground">
                  {isEnabled
                    ? `${activeWorkers.length} of ${workers.length} workers active`
                    : "Department disabled"}
                </span>
              </div>
              <Switch
                checked={isEnabled}
                onCheckedChange={() => toggleDepartment(department, head)}
              />
            </div>

            {/* Confirmation dialog */}
            {confirmDisable === department && (
              <div className="rounded-md bg-destructive/10 border border-destructive/30 p-3 space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <AlertTriangle className="h-4 w-4 text-destructive" />
                  <span>
                    Disabling {head} will also disable {workers.length} workers. Continue?
                  </span>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => handleConfirmDisable(department)}
                  >
                    Disable Department
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirmDisable(null)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {/* Worker list (expandable) */}
            {isEnabled && workers.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => toggleExpanded(department)}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-3 w-3" />
                  ) : (
                    <ChevronRight className="h-3 w-3" />
                  )}
                  {isExpanded ? "Hide" : "Show"} workers ({workers.length})
                </button>

                {isExpanded && (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {workers.map((worker) => {
                      const isActive = !disabledAgents.has(worker);
                      return (
                        <button
                          key={worker}
                          type="button"
                          onClick={() => toggleAgent(worker)}
                          className={`rounded-md px-3 py-2 text-sm text-left transition-colors ${
                            isActive
                              ? "bg-secondary/30 hover:bg-secondary/50"
                              : "bg-secondary/10 text-muted-foreground line-through hover:bg-secondary/20"
                          }`}
                        >
                          {worker}
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}

      {/* Workspace path */}
      <div className="rounded-lg border border-border p-4 space-y-3">
        <div className="flex items-center gap-2">
          <FolderOpen className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Workspace Path</h3>
        </div>
        <div className="flex gap-2">
          <Input
            value={workspacePath}
            onChange={(e) => {
              setWorkspacePath(e.target.value);
              setPathValidation(null);
            }}
            placeholder="~/.openclaw/workspace"
            className="flex-1"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={handleValidatePath}
            disabled={validatingPath || !workspacePath.trim()}
          >
            {validatingPath ? <Loader2 className="h-4 w-4 animate-spin" /> : "Validate"}
          </Button>
        </div>
        {pathValidation && (
          <div
            className={`flex items-center gap-2 text-xs ${pathValidation.valid ? "text-primary" : "text-destructive"}`}
          >
            {pathValidation.valid ? (
              <CheckCircle2 className="h-3.5 w-3.5" />
            ) : (
              <AlertTriangle className="h-3.5 w-3.5" />
            )}
            {pathValidation.valid
              ? pathValidation.exists
                ? "Directory exists and is writable"
                : "Parent directory is writable — will be created"
              : !pathValidation.exists
                ? "Directory not found and parent is not writable"
                : "Directory is not writable"}
          </div>
        )}
      </div>
    </div>
  );
}
