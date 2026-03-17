import { ChevronLeft, ChevronRight, Loader2, SkipForward, WifiOff } from "lucide-react";
import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useOnboarding } from "@/hooks/use-onboarding";
import { ONBOARDING_STEPS } from "@/lib/onboarding-utils";
import { useGatewayStore } from "@/store/gateway-store";
import { StepAgents } from "./step-agents";
import { StepChannels } from "./step-channels";
import { StepComplete } from "./step-complete";
import { StepFirstTask } from "./step-first-task";
import { StepGateway } from "./step-gateway";
import { StepProvider } from "./step-provider";

type Props = { initialStep: number };

export function OnboardingWizard({ initialStep }: Props) {
  const navigate = useNavigate();
  const { updateStep, complete, skip } = useOnboarding();
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  const [currentStep, setCurrentStep] = useState(initialStep);
  const [stepsCompleted, setStepsCompleted] = useState<number[]>([]);
  const [stepsSkipped, setStepsSkipped] = useState<number[]>([]);
  const [canAdvance, setCanAdvance] = useState(false);

  const totalSteps = ONBOARDING_STEPS.length;
  const isFirstStep = currentStep === 1;
  const isLastStep = currentStep === totalSteps;

  // Persist step changes to backend
  const persistStep = useCallback(
    async (step: number, completed: number[], skipped: number[]) => {
      try {
        await updateStep({ currentStep: step, stepsCompleted: completed, stepsSkipped: skipped });
      } catch {
        // Best-effort persistence
      }
    },
    [updateStep],
  );

  const handleNext = useCallback(async () => {
    if (!canAdvance && !isLastStep) {
      return;
    }
    const newCompleted = [...new Set([...stepsCompleted, currentStep])];
    setStepsCompleted(newCompleted);

    if (isLastStep) {
      await complete();
      void navigate("/overview", { replace: true });
      return;
    }

    const nextStep = currentStep + 1;
    setCurrentStep(nextStep);
    setCanAdvance(false);
    await persistStep(nextStep, newCompleted, stepsSkipped);
  }, [
    canAdvance,
    currentStep,
    isLastStep,
    stepsCompleted,
    stepsSkipped,
    complete,
    navigate,
    persistStep,
  ]);

  const handleBack = useCallback(() => {
    if (isFirstStep) {
      return;
    }
    const prevStep = currentStep - 1;
    setCurrentStep(prevStep);
    setCanAdvance(true); // Already visited
  }, [currentStep, isFirstStep]);

  const handleSkipStep = useCallback(async () => {
    const newSkipped = [...new Set([...stepsSkipped, currentStep])];
    setStepsSkipped(newSkipped);
    const nextStep = Math.min(currentStep + 1, totalSteps);
    setCurrentStep(nextStep);
    setCanAdvance(false);
    await persistStep(nextStep, stepsCompleted, newSkipped);
  }, [currentStep, totalSteps, stepsCompleted, stepsSkipped, persistStep]);

  const handleSkipAll = useCallback(async () => {
    await skip();
    void navigate("/overview", { replace: true });
  }, [skip, navigate]);

  // Keyboard shortcut: Ctrl+Enter to advance
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && canAdvance) {
        e.preventDefault();
        void handleNext();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [canAdvance, handleNext]);

  const stepMeta = ONBOARDING_STEPS[currentStep - 1];

  // Steps 2-4 are skippable (provider, agents, channels)
  const canSkipCurrent = currentStep >= 2 && currentStep <= 4;

  return (
    <div className="max-w-5xl mx-auto space-y-6 relative">
      {/* Gateway disconnect overlay */}
      {!isConnected && currentStep > 1 && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm rounded-lg">
          <div className="text-center space-y-3">
            <WifiOff className="h-8 w-8 mx-auto text-muted-foreground" />
            <div className="text-sm font-medium">Connection Lost</div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Reconnecting...
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Setup Wizard</h1>
          <p className="text-sm text-muted-foreground">
            Step {currentStep} of {totalSteps}: {stepMeta?.title}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={handleSkipAll} className="text-muted-foreground">
          <SkipForward className="h-4 w-4 mr-1" />
          Skip Setup
        </Button>
      </div>

      {/* Progress bar */}
      <div className="flex gap-1.5">
        {ONBOARDING_STEPS.map((s) => (
          <div
            key={s.step}
            className={`h-1.5 flex-1 rounded-full transition-colors ${
              stepsCompleted.includes(s.step)
                ? "bg-primary"
                : stepsSkipped.includes(s.step)
                  ? "bg-muted-foreground/30"
                  : s.step === currentStep
                    ? "bg-primary/50"
                    : "bg-border"
            }`}
          />
        ))}
      </div>

      {/* Step content — two-column layout */}
      <div className="min-h-[400px] grid grid-cols-1 lg:grid-cols-[1fr,300px] gap-6">
        <div>
          {currentStep === 1 && <StepGateway onValidChange={setCanAdvance} />}
          {currentStep === 2 && <StepProvider onValidChange={setCanAdvance} />}
          {currentStep === 3 && <StepAgents onValidChange={setCanAdvance} />}
          {currentStep === 4 && <StepChannels onValidChange={setCanAdvance} />}
          {currentStep === 5 && <StepFirstTask onValidChange={setCanAdvance} />}
          {currentStep === 6 && (
            <StepComplete
              stepsCompleted={stepsCompleted}
              stepsSkipped={stepsSkipped}
              onValidChange={setCanAdvance}
            />
          )}
        </div>
        {/* Right info panel — hidden on mobile, empty for step 6 */}
        <div className="hidden lg:block">
          {currentStep === 1 && <GatewayInfoPanel />}
          {currentStep === 2 && <ProviderInfoPanel />}
          {currentStep === 3 && <AgentInfoPanel />}
          {currentStep === 4 && <ChannelInfoPanel />}
          {currentStep === 5 && <FirstTaskInfoPanel />}
        </div>
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between pt-4 border-t border-border">
        <Button variant="outline" size="sm" onClick={handleBack} disabled={isFirstStep}>
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <div className="flex items-center gap-2">
          {canSkipCurrent && (
            <Button variant="ghost" size="sm" onClick={handleSkipStep}>
              Skip
            </Button>
          )}
          <Button size="sm" onClick={handleNext} disabled={!canAdvance && !isLastStep}>
            {isLastStep ? "Finish" : "Continue"}
            {!isLastStep && <ChevronRight className="h-4 w-4 ml-1" />}
          </Button>
        </div>
      </div>
    </div>
  );
}

function GatewayInfoPanel() {
  const hello = useGatewayStore((s) => s.hello);
  const isConnected = useGatewayStore((s) => s.connectionStatus === "connected");
  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <h3 className="text-sm font-semibold text-muted-foreground">Gateway Info</h3>
      {isConnected && hello ? (
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Protocol</span>
            <span>v{hello.protocol}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Methods</span>
            <span>{hello.features?.methods?.length ?? 0}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Events</span>
            <span>{hello.features?.events?.length ?? 0}</span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Waiting for connection...</p>
      )}
    </div>
  );
}

function ProviderInfoPanel() {
  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <h3 className="text-sm font-semibold text-muted-foreground">Supported Providers</h3>
      <div className="space-y-2 text-xs text-muted-foreground">
        <div>Anthropic — Claude models</div>
        <div>Google — Gemini models</div>
        <div>Ollama — Local open-source models</div>
        <div>OpenAI — GPT models</div>
        <div>Custom — Any OpenAI-compatible endpoint</div>
      </div>
      <p className="text-xs text-muted-foreground/70 pt-2 border-t border-border">
        You can add more providers later in the Config page.
      </p>
    </div>
  );
}

function AgentInfoPanel() {
  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <h3 className="text-sm font-semibold text-muted-foreground">Organization</h3>
      <div className="space-y-1 text-xs">
        <div className="font-medium">Tier 1 — Leadership</div>
        <div className="text-muted-foreground ml-3">Operator1 (COO)</div>
        <div className="font-medium mt-2">Tier 2 — Department Heads</div>
        <div className="text-muted-foreground ml-3">Neo (CTO) — Engineering</div>
        <div className="text-muted-foreground ml-3">Morpheus (CMO) — Marketing</div>
        <div className="text-muted-foreground ml-3">Trinity (CFO) — Finance</div>
        <div className="font-medium mt-2">Tier 3 — Specialists</div>
        <div className="text-muted-foreground ml-3">10 per department (30 total)</div>
      </div>
    </div>
  );
}

function ChannelInfoPanel() {
  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <h3 className="text-sm font-semibold text-muted-foreground">How Channels Work</h3>
      <div className="space-y-2 text-xs text-muted-foreground">
        <p>
          Channels connect messaging platforms to your agent team. Each channel routes messages
          through the gateway to the appropriate agent.
        </p>
        <p>
          Web Chat is always available. Add Telegram, Discord, or other channels for mobile access.
        </p>
        <p>
          All channels share the same agent system — conversations are consistent regardless of
          platform.
        </p>
      </div>
    </div>
  );
}

function FirstTaskInfoPanel() {
  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <h3 className="text-sm font-semibold text-muted-foreground">What Happens</h3>
      <div className="space-y-2 text-xs">
        <div className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[10px] font-bold">
            1
          </span>
          <span className="text-muted-foreground">Your message goes to the gateway</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[10px] font-bold">
            2
          </span>
          <span className="text-muted-foreground">Gateway routes to the selected agent</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[10px] font-bold">
            3
          </span>
          <span className="text-muted-foreground">Agent processes with the AI provider</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-primary/20 text-primary flex items-center justify-center text-[10px] font-bold">
            4
          </span>
          <span className="text-muted-foreground">Response streams back in real time</span>
        </div>
      </div>
    </div>
  );
}
