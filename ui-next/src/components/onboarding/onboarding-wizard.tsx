import { ChevronLeft, ChevronRight, SkipForward } from "lucide-react";
import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useOnboarding } from "@/hooks/use-onboarding";
import { ONBOARDING_STEPS } from "@/lib/onboarding-utils";
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
    <div className="max-w-4xl mx-auto space-y-6">
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

      {/* Step content */}
      <div className="min-h-[400px]">
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
