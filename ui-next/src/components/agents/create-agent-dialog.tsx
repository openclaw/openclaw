import { ChevronLeft, ChevronRight, Wand2, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { useState, useCallback, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { useCreateAgentStore } from "@/store/create-agent-store";
import { useGatewayStore } from "@/store/gateway-store";

// ── Types ────────────────────────────────────────────────────────────────────

interface WizardState {
  department: string;
  parentAgent: string;
  agentId: string;
  name: string;
  role: string;
  tier: number;
  description: string;
  preferredModel: string;
  toolsAllow: string;
  toolsDeny: string;
  manifest: string;
  promptContent: string;
  validationError: string;
  installed: boolean;
  installError: string;
}

interface ParentOption {
  id: string;
  name: string;
  department: string;
  tier: number;
}

const STEPS = ["Basics", "Describe", "Review", "Install"] as const;

const DEPARTMENTS = [
  "engineering",
  "finance",
  "marketing",
  "operations",
  "hr",
  "legal",
  "product",
  "sales",
  "customer-success",
  "security",
];

const INITIAL_STATE: WizardState = {
  department: "",
  parentAgent: "",
  agentId: "",
  name: "",
  role: "",
  tier: 2,
  description: "",
  preferredModel: "",
  toolsAllow: "",
  toolsDeny: "",
  manifest: "",
  promptContent: "",
  validationError: "",
  installed: false,
  installError: "",
};

// ── Step indicator ───────────────────────────────────────────────────────────

function StepIndicator({ current, steps }: { current: number; steps: readonly string[] }) {
  return (
    <div className="flex items-center gap-2">
      {steps.map((label, i) => (
        <div key={label} className="flex items-center gap-2">
          <div
            className={cn(
              "flex items-center justify-center size-7 rounded-full text-xs font-medium border",
              i < current && "bg-green-600 text-white border-green-600",
              i === current && "bg-foreground text-background border-foreground",
              i > current && "bg-muted text-muted-foreground border-muted",
            )}
          >
            {i < current ? <CheckCircle2 className="size-3.5" /> : i + 1}
          </div>
          <span
            className={cn(
              "text-xs hidden sm:inline",
              i === current ? "font-medium" : "text-muted-foreground",
            )}
          >
            {label}
          </span>
          {i < steps.length - 1 && <div className="w-6 h-px bg-border" />}
        </div>
      ))}
    </div>
  );
}

// ── Step 1: Basics ──────────────────────────────────────────────────────────

function StepBasics({
  state,
  parents,
  onChange,
  existingIds,
}: {
  state: WizardState;
  parents: ParentOption[];
  onChange: (partial: Partial<WizardState>) => void;
  existingIds: Set<string>;
}) {
  const filteredParents = parents.filter(
    (p) => !state.department || p.department === state.department,
  );

  const idFromName = (name: string) =>
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

  const idError =
    state.agentId && existingIds.has(state.agentId)
      ? "Agent ID already exists"
      : state.agentId && !/^[a-z0-9-]+$/.test(state.agentId)
        ? "Must be lowercase alphanumeric with hyphens"
        : "";

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium">Department *</label>
        <select
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm mt-1"
          value={state.department}
          onChange={(e) => onChange({ department: e.target.value })}
        >
          <option value="">Select department...</option>
          {DEPARTMENTS.map((d) => (
            <option key={d} value={d}>
              {d.charAt(0).toUpperCase() + d.slice(1).replace(/-/g, " ")}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label className="text-sm font-medium">Parent Agent</label>
        <p className="text-xs text-muted-foreground mb-1">
          Select a department head to create a specialist, or leave empty for a new department head
        </p>
        <select
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
          value={state.parentAgent}
          onChange={(e) => {
            const parent = parents.find((p) => p.id === e.target.value);
            onChange({
              parentAgent: e.target.value,
              tier: e.target.value ? 3 : 2,
              department: parent?.department ?? state.department,
            });
          }}
        >
          <option value="">None (Department Head — Tier 2)</option>
          {filteredParents.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.department})
            </option>
          ))}
        </select>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-sm font-medium">Agent Name *</label>
          <Input
            value={state.name}
            onChange={(e) =>
              onChange({
                name: e.target.value,
                agentId:
                  state.agentId === idFromName(state.name) || !state.agentId
                    ? idFromName(e.target.value)
                    : state.agentId,
              })
            }
            placeholder="Security Engineer"
            className="mt-1"
          />
        </div>

        <div>
          <label className="text-sm font-medium">Agent ID *</label>
          <Input
            value={state.agentId}
            onChange={(e) => onChange({ agentId: e.target.value })}
            placeholder="security-engineer"
            className={cn("mt-1", idError && "border-destructive")}
          />
          {idError && <p className="text-xs text-destructive mt-1">{idError}</p>}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex-1">
          <label className="text-sm font-medium">Role Title *</label>
          <Input
            value={state.role}
            onChange={(e) => onChange({ role: e.target.value })}
            placeholder="Security Engineer"
            className="mt-1"
          />
        </div>
        <div className="pt-5">
          <span
            className={cn(
              "font-medium px-2 py-0.5 rounded-full border text-xs",
              state.tier === 2
                ? "bg-blue-500/10 text-blue-600 border-blue-500/20"
                : "bg-zinc-500/10 text-zinc-600 border-zinc-500/20",
            )}
          >
            T{state.tier} {state.tier === 2 ? "Dept Head" : "Specialist"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Step 2: Describe ────────────────────────────────────────────────────────

function StepDescribe({
  state,
  onChange,
}: {
  state: WizardState;
  onChange: (partial: Partial<WizardState>) => void;
}) {
  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium">What should this agent do? *</label>
        <p className="text-xs text-muted-foreground mb-2">
          Describe the agent's responsibilities. AI will generate the manifest and prompt files.
        </p>
        <textarea
          className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm min-h-[120px] resize-y"
          value={state.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="A security engineer who reviews code for vulnerabilities, runs SAST/DAST tools, manages security advisories..."
        />
      </div>

      <details className="group">
        <summary className="text-sm font-medium cursor-pointer text-muted-foreground hover:text-foreground">
          Advanced options
        </summary>
        <div className="space-y-3 mt-3 pl-1">
          <div>
            <label className="text-sm font-medium">Preferred Model</label>
            <Input
              value={state.preferredModel}
              onChange={(e) => onChange({ preferredModel: e.target.value })}
              placeholder="claude-opus-4-6 (default: inherit from parent)"
              className="mt-1"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">Tools to Allow</label>
              <Input
                value={state.toolsAllow}
                onChange={(e) => onChange({ toolsAllow: e.target.value })}
                placeholder="read, write, exec"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Tools to Deny</label>
              <Input
                value={state.toolsDeny}
                onChange={(e) => onChange({ toolsDeny: e.target.value })}
                placeholder="browser"
                className="mt-1"
              />
            </div>
          </div>
        </div>
      </details>
    </div>
  );
}

// ── Step 3: Review ──────────────────────────────────────────────────────────

function StepReview({
  state,
  onChange,
  onRegenerate,
  generating,
}: {
  state: WizardState;
  onChange: (partial: Partial<WizardState>) => void;
  onRegenerate: () => void;
  generating: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Review and edit the generated files before installing.
        </p>
        <Button variant="outline" size="sm" onClick={onRegenerate} disabled={generating}>
          {generating ? (
            <Loader2 className="size-3.5 animate-spin mr-1" />
          ) : (
            <Wand2 className="size-3.5 mr-1" />
          )}
          Regenerate
        </Button>
      </div>

      {state.validationError && (
        <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 rounded-md p-2">
          <AlertCircle className="size-4 shrink-0" />
          {state.validationError}
        </div>
      )}

      <div className="grid gap-3 grid-cols-2">
        <div>
          <label className="text-xs font-medium mb-1 block">agent.yaml</label>
          <textarea
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs font-mono min-h-[280px] resize-y"
            value={state.manifest}
            onChange={(e) => onChange({ manifest: e.target.value, validationError: "" })}
          />
        </div>
        <div>
          <label className="text-xs font-medium mb-1 block">AGENT.md</label>
          <textarea
            className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs font-mono min-h-[280px] resize-y"
            value={state.promptContent}
            onChange={(e) => onChange({ promptContent: e.target.value })}
          />
        </div>
      </div>
    </div>
  );
}

// ── Step 4: Install ─────────────────────────────────────────────────────────

function StepInstall({ state }: { state: WizardState }) {
  if (state.installError) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-destructive/30 p-8">
        <div className="text-center space-y-2">
          <AlertCircle className="mx-auto size-8 text-destructive" />
          <h3 className="font-semibold">Installation Failed</h3>
          <p className="text-sm text-destructive max-w-md">{state.installError}</p>
        </div>
      </div>
    );
  }

  if (state.installed) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-green-600/30 p-8">
        <div className="text-center space-y-2">
          <CheckCircle2 className="mx-auto size-8 text-green-600" />
          <h3 className="font-semibold">Agent Created Successfully</h3>
          <p className="text-sm text-muted-foreground">
            <strong>{state.name}</strong> ({state.agentId}) has been installed as a{" "}
            {state.tier === 2 ? "department head" : "specialist"} in the {state.department}{" "}
            department.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center rounded-lg border border-dashed p-8">
      <div className="text-center space-y-3">
        <h3 className="font-semibold">Ready to Install</h3>
        <p className="text-sm text-muted-foreground">
          This will create <strong>{state.agentId}</strong> in the agents directory.
        </p>
        <div className="text-left inline-block text-sm space-y-1">
          <div>
            <span className="text-muted-foreground">Name:</span> {state.name}
          </div>
          <div>
            <span className="text-muted-foreground">Role:</span> {state.role}
          </div>
          <div>
            <span className="text-muted-foreground">Tier:</span> {state.tier} (
            {state.tier === 2 ? "Dept Head" : "Specialist"})
          </div>
          <div>
            <span className="text-muted-foreground">Department:</span> {state.department}
          </div>
          {state.parentAgent && (
            <div>
              <span className="text-muted-foreground">Parent:</span> {state.parentAgent}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Local template fallback ─────────────────────────────────────────────────

function generateLocalTemplate(state: WizardState): { manifest: string; promptContent: string } {
  const tools = [];
  if (state.toolsAllow) {
    tools.push(
      `  allow:\n${state.toolsAllow
        .split(",")
        .map((t) => `    - ${t.trim()}`)
        .join("\n")}`,
    );
  }
  if (state.toolsDeny) {
    tools.push(
      `  deny:\n${state.toolsDeny
        .split(",")
        .map((t) => `    - ${t.trim()}`)
        .join("\n")}`,
    );
  }

  const manifest = [
    `id: ${state.agentId}`,
    `name: ${state.name}`,
    `tier: ${state.tier}`,
    `role: ${state.role}`,
    `department: ${state.department}`,
    `description: ${state.description.split("\n")[0]}`,
    `version: 1.0.0`,
    "",
    ...(state.parentAgent ? [`requires: ${state.parentAgent}`] : []),
    "",
    `model:`,
    `  provider: anthropic`,
    `  primary: ${state.preferredModel || "claude-sonnet-4-6"}`,
    "",
    ...(tools.length > 0 ? [`tools:`, ...tools, ""] : []),
    `capabilities:`,
    `  - task_execution`,
    "",
    `routing_hints:`,
    `  keywords:`,
    `    - ${state.department}`,
    `  priority: normal`,
    "",
    `limits:`,
    `  timeout_seconds: 300`,
    `  cost_limit_usd: 0.50`,
    "",
    `author:`,
    `  name: User`,
    "",
    `keywords:`,
    `  - ${state.department}`,
    `category: ${state.tier === 2 ? "department-head" : "specialist"}`,
  ].join("\n");

  const promptContent = [
    `# ${state.name}`,
    "",
    `You are **${state.name}**, the ${state.role} in the ${state.department} department.`,
    "",
    `## Responsibilities`,
    "",
    state.description,
    "",
    `## Guidelines`,
    "",
    `- Focus on your area of expertise: ${state.department}`,
    `- Collaborate with other agents when tasks cross department boundaries`,
    `- Report progress and blockers clearly`,
    ...(state.parentAgent
      ? [`- Escalate decisions outside your scope to your department head (${state.parentAgent})`]
      : []),
  ].join("\n");

  return { manifest, promptContent };
}

// ── Main dialog ──────────────────────────────────────────────────────────────

export function CreateAgentDialog() {
  const { sendRpc } = useGateway();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  const { open, params, closeCreateAgent } = useCreateAgentStore();

  const [step, setStep] = useState(0);
  const [state, setState] = useState<WizardState>(INITIAL_STATE);
  const [generating, setGenerating] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [parents, setParents] = useState<ParentOption[]>([]);
  const [existingIds, setExistingIds] = useState<Set<string>>(new Set());
  const [cloneLoaded, setCloneLoaded] = useState(false);

  const update = useCallback((partial: Partial<WizardState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  // Reset wizard when dialog opens with new params
  useEffect(() => {
    if (open) {
      setStep(0);
      setState({
        ...INITIAL_STATE,
        parentAgent: params.parentId ?? "",
        department: params.department ?? "",
        tier: params.parentId ? 3 : 2,
      });
      setGenerating(false);
      setInstalling(false);
      setCloneLoaded(false);
    }
  }, [open, params]);

  // Load parent options + clone source
  useEffect(() => {
    if (!open || !isConnected) {
      return;
    }
    const load = async () => {
      try {
        const res = await sendRpc("agents.marketplace.installed", {});
        if (res && Array.isArray(res.agents)) {
          const agents = res.agents as Array<{
            id: string;
            name: string;
            department: string;
            tier: number;
            role: string;
            description?: string;
            requires?: string | null;
          }>;
          setParents(
            agents
              .filter((a) => a.tier <= 2)
              .map((a) => ({ id: a.id, name: a.name, department: a.department, tier: a.tier })),
          );
          setExistingIds(new Set(agents.map((a) => a.id)));

          if (params.cloneId && !cloneLoaded) {
            const source = agents.find((a) => a.id === params.cloneId);
            if (source) {
              setState((prev) => ({
                ...prev,
                name: `${source.name} (Copy)`,
                agentId: `${source.id}-copy`,
                role: source.role,
                department: source.department,
                tier: source.tier,
                parentAgent: source.requires ?? "",
                description: source.description ?? "",
              }));
              setCloneLoaded(true);
            }
          }
        }
      } catch {
        // RPC error
      }
    };
    void load();
  }, [open, isConnected, sendRpc, params.cloneId, cloneLoaded]);

  const canAdvance = useMemo(() => {
    switch (step) {
      case 0:
        return (
          state.department &&
          state.agentId &&
          state.name &&
          state.role &&
          !existingIds.has(state.agentId) &&
          /^[a-z0-9-]+$/.test(state.agentId)
        );
      case 1:
        return state.description.trim().length > 10;
      case 2:
        return state.manifest.trim().length > 0 && !state.validationError;
      case 3:
        return state.installed;
      default:
        return false;
    }
  }, [step, state, existingIds]);

  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    try {
      const res = await sendRpc("agents.marketplace.generate", {
        agentId: state.agentId,
        name: state.name,
        role: state.role,
        tier: state.tier,
        department: state.department,
        parentAgent: state.parentAgent || null,
        description: state.description,
        preferredModel: state.preferredModel || null,
        toolsAllow: state.toolsAllow ? state.toolsAllow.split(",").map((s) => s.trim()) : null,
        toolsDeny: state.toolsDeny ? state.toolsDeny.split(",").map((s) => s.trim()) : null,
      });
      if (res?.manifest) {
        update({
          manifest: res.manifest as string,
          promptContent: (res.promptContent as string) ?? "",
          validationError: "",
        });
      }
    } catch {
      const template = generateLocalTemplate(state);
      update({
        manifest: template.manifest,
        promptContent: template.promptContent,
        validationError: "",
      });
    } finally {
      setGenerating(false);
    }
  }, [sendRpc, state, update]);

  const handleNext = useCallback(async () => {
    if (step === 1) {
      setStep(2);
      await handleGenerate();
      return;
    }
    if (step === 2) {
      setStep(3);
      setInstalling(true);
      try {
        const res = await sendRpc("agents.marketplace.create", {
          agentId: state.agentId,
          manifest: state.manifest,
          promptContent: state.promptContent,
        });
        if (res?.ok) {
          update({ installed: true, installError: "" });
        } else {
          update({ installError: "Installation failed" });
        }
      } catch (err) {
        update({ installError: err instanceof Error ? err.message : "Installation failed" });
      } finally {
        setInstalling(false);
      }
      return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }, [step, handleGenerate, sendRpc, state, update]);

  const handleClose = useCallback(() => {
    closeCreateAgent();
  }, [closeCreateAgent]);

  const title = params.cloneId
    ? `Clone Agent: ${params.cloneId}`
    : params.parentId
      ? "Create Specialist"
      : "Create Agent";

  const description = params.cloneId
    ? "Cloning an existing agent — review and customize the prefilled fields"
    : "AI-powered wizard to create a new agent";

  // Use wider dialog for the Review step (side-by-side textareas)
  const contentWidth = step === 2 ? "sm:max-w-3xl" : "sm:max-w-xl";

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          handleClose();
        }
      }}
    >
      <DialogContent className={cn(contentWidth, "max-h-[85vh] flex flex-col")}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <StepIndicator current={step} steps={STEPS} />

        <div className="flex-1 overflow-auto py-2">
          {step === 0 && (
            <StepBasics
              state={state}
              parents={parents}
              onChange={update}
              existingIds={existingIds}
            />
          )}
          {step === 1 && <StepDescribe state={state} onChange={update} />}
          {step === 2 && (
            <StepReview
              state={state}
              onChange={update}
              onRegenerate={handleGenerate}
              generating={generating}
            />
          )}
          {step === 3 && <StepInstall state={state} />}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              if (step === 0 || state.installed) {
                handleClose();
              } else {
                setStep((s) => s - 1);
              }
            }}
          >
            <ChevronLeft className="size-4 mr-1" />
            {step === 0 || state.installed ? "Close" : "Back"}
          </Button>

          <div className="flex items-center gap-2">
            {!state.installed && step < STEPS.length - 1 && (
              <Button
                size="sm"
                onClick={handleNext}
                disabled={!canAdvance || generating || installing}
              >
                {generating || installing ? (
                  <Loader2 className="size-4 animate-spin mr-1" />
                ) : step === 2 ? (
                  <Wand2 className="size-4 mr-1" />
                ) : (
                  <ChevronRight className="size-4 mr-1" />
                )}
                {step === 1 ? "Generate with AI" : step === 2 ? "Create Agent" : "Next"}
              </Button>
            )}

            {state.installed && (
              <Button size="sm" onClick={handleClose}>
                Done
                <CheckCircle2 className="size-4 ml-1" />
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
