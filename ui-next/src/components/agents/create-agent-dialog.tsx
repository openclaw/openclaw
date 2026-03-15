import { ChevronLeft, ChevronRight, Wand2, Loader2, CheckCircle2 } from "lucide-react";
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
import { useGateway } from "@/hooks/use-gateway";
import { cn } from "@/lib/utils";
import { useCreateAgentStore } from "@/store/create-agent-store";
import { useGatewayStore } from "@/store/gateway-store";
import {
  type WizardState,
  type ParentOption,
  type PersonaInfo,
  STEPS_WITH_PERSONA,
  STEPS_NO_PERSONA,
  INITIAL_STATE,
  idFromName,
  generateLocalTemplate,
  StepIndicator,
  StepPersona,
  StepBasics,
  StepDescribe,
  StepReview,
  StepInstall,
} from "./create-agent-steps";

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

  const steps = state.persona ? STEPS_WITH_PERSONA : STEPS_NO_PERSONA;
  const stepLabel = steps[step] ?? "Persona";

  const update = useCallback((partial: Partial<WizardState>) => {
    setState((prev) => ({ ...prev, ...partial }));
  }, []);

  // Reset wizard when dialog opens
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
        const res = await sendRpc<{ agents?: unknown[] }>("agents.marketplace.installed", {});
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

  // Persona selection: pre-fill basics from the chosen persona
  const handlePersonaSelect = useCallback((persona: PersonaInfo) => {
    setState((prev) => ({
      ...prev,
      persona,
      name: persona.name,
      agentId: idFromName(persona.name),
      role: persona.name,
      department: persona.category,
      description: persona.description,
    }));
  }, []);

  const handlePersonaSkip = useCallback(() => {
    setState((prev) => ({ ...prev, persona: null }));
    setStep(1);
  }, []);

  const canAdvance = useMemo(() => {
    switch (stepLabel) {
      case "Persona":
        return !!state.persona;
      case "Basics":
        return (
          !!state.department &&
          !!state.agentId &&
          !!state.name &&
          !!state.role &&
          !existingIds.has(state.agentId) &&
          /^[a-z0-9-]+$/.test(state.agentId)
        );
      case "Describe":
        return state.description.trim().length > 10;
      case "Review":
        return (
          (state.persona
            ? state.promptContent.trim().length > 0
            : state.manifest.trim().length > 0) && !state.validationError
        );
      case "Install":
        return state.installed;
      default:
        return false;
    }
  }, [stepLabel, state, existingIds]);

  // Generate via AI or expand persona
  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    try {
      if (state.persona) {
        const res = await sendRpc<{
          agentMd?: string;
          workspaceFiles?: Array<{ name: string; content: string; size: number }>;
        }>("personas.expand", {
          slug: state.persona.slug,
          agentId: state.agentId,
          agentName: state.name,
        });
        const agentMd = res?.agentMd ?? "";
        // Extract YAML frontmatter from the full AGENT.md content.
        // The manifest RPC expects pure YAML, not the full markdown.
        const fmMatch = agentMd.match(/^---\s*\n([\s\S]*?)\n---/);
        const yamlManifest = fmMatch ? fmMatch[1] : "";
        update({
          manifest: yamlManifest,
          promptContent: agentMd,
          workspaceFiles: res?.workspaceFiles ?? [],
          validationError: "",
        });
      } else {
        const res = await sendRpc<{ manifest?: string; promptContent?: string }>(
          "agents.marketplace.generate",
          {
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
          },
        );
        if (res?.manifest) {
          update({
            manifest: res.manifest,
            promptContent: (res.promptContent as string) ?? "",
            validationError: "",
          });
        }
      }
    } catch {
      if (!state.persona) {
        const template = generateLocalTemplate(state);
        update({
          manifest: template.manifest,
          promptContent: template.promptContent,
          validationError: "",
        });
      }
    } finally {
      setGenerating(false);
    }
  }, [sendRpc, state, update]);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    try {
      const res = await sendRpc<{ ok?: boolean }>("agents.marketplace.create", {
        agentId: state.agentId,
        manifest: state.manifest || undefined,
        promptContent: state.promptContent,
        persona: state.persona?.slug ?? undefined,
        workspaceFiles: state.workspaceFiles.length > 0 ? state.workspaceFiles : undefined,
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
  }, [sendRpc, state, update]);

  const handleNext = useCallback(async () => {
    const nextLabel = steps[step + 1];
    if (nextLabel === "Review") {
      setStep(step + 1);
      await handleGenerate();
      return;
    }
    if (nextLabel === "Install") {
      setStep(step + 1);
      await handleInstall();
      return;
    }
    setStep((s) => Math.min(s + 1, steps.length - 1));
  }, [step, steps, handleGenerate, handleInstall]);

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

  // Wider dialog for Review step with side-by-side textareas (no-persona path)
  const isReviewWide = stepLabel === "Review" && !state.persona;
  const contentWidth = isReviewWide ? "sm:max-w-3xl" : "sm:max-w-xl";

  const nextButtonLabel =
    stepLabel === "Persona"
      ? "Next"
      : stepLabel === "Describe"
        ? "Generate with AI"
        : stepLabel === "Basics" && state.persona
          ? "Preview"
          : stepLabel === "Review"
            ? "Create Agent"
            : "Next";

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

        <StepIndicator current={step} steps={steps} />

        <div className="flex-1 overflow-auto py-2">
          {stepLabel === "Persona" && (
            <StepPersona
              selected={state.persona}
              onSelect={handlePersonaSelect}
              onSkip={handlePersonaSkip}
              sendRpc={sendRpc}
            />
          )}
          {stepLabel === "Basics" && (
            <StepBasics
              state={state}
              parents={parents}
              onChange={update}
              existingIds={existingIds}
            />
          )}
          {stepLabel === "Describe" && <StepDescribe state={state} onChange={update} />}
          {stepLabel === "Review" && (
            <StepReview
              state={state}
              onChange={update}
              onRegenerate={handleGenerate}
              generating={generating}
            />
          )}
          {stepLabel === "Install" && <StepInstall state={state} />}
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
            {!state.installed && step < steps.length - 1 && (
              <Button
                size="sm"
                onClick={handleNext}
                disabled={!canAdvance || generating || installing}
              >
                {generating || installing ? (
                  <Loader2 className="size-4 animate-spin mr-1" />
                ) : stepLabel === "Review" ? (
                  <Wand2 className="size-4 mr-1" />
                ) : (
                  <ChevronRight className="size-4 mr-1" />
                )}
                {nextButtonLabel}
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
