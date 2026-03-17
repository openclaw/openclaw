import { CheckCircle2, SkipForward, AlertCircle } from "lucide-react";
import { useEffect } from "react";
import { Badge } from "@/components/ui/badge";
import { ONBOARDING_STEPS } from "@/lib/onboarding-utils";

type Props = {
  stepsCompleted: number[];
  stepsSkipped: number[];
  onValidChange: (valid: boolean) => void;
};

export function StepComplete({ stepsCompleted, stepsSkipped, onValidChange }: Props) {
  // Always valid on the complete step
  useEffect(() => {
    onValidChange(true);
  }, [onValidChange]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Setup Complete</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Review your setup progress. Click Finish to start using Operator1.
        </p>
      </div>

      <div className="space-y-2">
        {ONBOARDING_STEPS.filter((s) => s.step < 6).map((step) => {
          const completed = stepsCompleted.includes(step.step);
          const skipped = stepsSkipped.includes(step.step);

          return (
            <div
              key={step.step}
              className="flex items-center gap-3 rounded-lg border border-border p-3"
            >
              {completed ? (
                <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />
              ) : skipped ? (
                <SkipForward className="h-5 w-5 text-muted-foreground shrink-0" />
              ) : (
                <AlertCircle className="h-5 w-5 text-warning shrink-0" />
              )}
              <div className="flex-1">
                <div className="text-sm font-medium">{step.title}</div>
                <div className="text-xs text-muted-foreground">{step.description}</div>
              </div>
              {completed && (
                <Badge variant="default" className="text-xs">
                  Done
                </Badge>
              )}
              {skipped && (
                <Badge variant="outline" className="text-xs">
                  Skipped
                </Badge>
              )}
            </div>
          );
        })}
      </div>

      {stepsSkipped.length > 0 && (
        <div className="rounded-md bg-muted/50 border border-border p-3">
          <p className="text-xs text-muted-foreground">
            You skipped {stepsSkipped.length} step{stepsSkipped.length !== 1 ? "s" : ""}. You can
            configure these features later from the dashboard.
          </p>
        </div>
      )}
    </div>
  );
}
