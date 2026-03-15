import { ChevronDown, ChevronRight, CheckCircle2, Circle, Loader2 } from "lucide-react";
import { useState, useMemo } from "react";
import { cn } from "@/lib/utils";

export type PlanStep = {
  text: string;
  done: boolean;
};

const TASK_LIST_RE = /^[-*]\s+\[([ xX])\]\s+(.+)$/gm;

/**
 * Check whether the checklist looks intentional (a plan) vs incidental
 * (checklists embedded in memory/prose). A plan starts with the checklist
 * near the top of the message — possibly after a short heading or label.
 * Incidental checklists (from memory recalls, quoted content) appear after
 * substantial prose and should not trigger the PlanCard.
 */
function looksLikeIntentionalPlan(text: string): boolean {
  TASK_LIST_RE.lastIndex = 0;
  const firstMatch = TASK_LIST_RE.exec(text);
  if (!firstMatch) {
    return false;
  }
  // Allow the checklist to start within the first ~300 chars (room for a heading + blank line)
  const preamble = text.slice(0, firstMatch.index);
  // Strip whitespace and short headings — a plan preamble is brief
  const substantiveChars = preamble.replace(/^#+\s+.*$/gm, "").replace(/\s+/g, "").length;
  return substantiveChars < 120;
}

/**
 * Extract markdown task list items (`- [ ]` / `- [x]`) from text.
 * Returns the steps and the text with task list lines removed.
 *
 * Only extracts when the checklist looks like an intentional plan (near the
 * top of the message). Checklists buried in prose/memory content are ignored
 * to avoid false PlanCard triggers.
 *
 * Deduplicates by step text, keeping the last (most recent) done state.
 * This handles streaming agents that re-emit the full plan as steps complete.
 */
export function extractPlanSteps(text: string): { steps: PlanStep[]; rest: string } {
  if (!looksLikeIntentionalPlan(text)) {
    return { steps: [], rest: text };
  }
  TASK_LIST_RE.lastIndex = 0; // reset global regex state before use
  const steps: PlanStep[] = [];
  const seen = new Map<string, number>(); // step text -> index in steps[]
  let match: RegExpExecArray | null;
  while ((match = TASK_LIST_RE.exec(text)) !== null) {
    const stepText = match[2].trim();
    const done = match[1] !== " ";
    const existingIdx = seen.get(stepText);
    if (existingIdx !== undefined) {
      // Update to the latest done state (agent re-emitted the plan with progress)
      steps[existingIdx].done = done;
    } else {
      seen.set(stepText, steps.length);
      steps.push({ text: stepText, done });
    }
  }
  if (steps.length === 0) {
    return { steps: [], rest: text };
  }
  // Remove task list lines from the text so they don't render twice
  TASK_LIST_RE.lastIndex = 0;
  const rest = text
    .replace(TASK_LIST_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { steps, rest };
}

export function PlanCard({ steps, className }: { steps: PlanStep[]; className?: string }) {
  const [collapsed, setCollapsed] = useState(false);

  const doneCount = useMemo(() => steps.filter((s) => s.done).length, [steps]);
  const total = steps.length;
  const allDone = doneCount === total;
  const progress = total > 0 ? (doneCount / total) * 100 : 0;

  // Find the first incomplete step (currently active)
  const activeIndex = steps.findIndex((s) => !s.done);

  return (
    <div
      className={cn(
        "rounded-lg border bg-card/60 backdrop-blur-sm overflow-hidden",
        allDone ? "border-chart-2/30" : "border-primary/20",
        className,
      )}
    >
      {/* Header */}
      <button
        onClick={() => setCollapsed((p) => !p)}
        className="flex items-center gap-2 w-full px-3 py-2 text-xs font-medium hover:bg-muted/40 transition-colors"
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
        <span className={allDone ? "text-chart-2" : "text-foreground"}>Plan</span>
        <span className="text-muted-foreground font-mono tabular-nums ml-auto">
          {doneCount}/{total}
        </span>
      </button>

      {/* Progress bar */}
      <div className="h-0.5 bg-muted/40">
        <div
          className={cn(
            "h-full transition-all duration-500 ease-out",
            allDone ? "bg-chart-2" : "bg-primary/60",
          )}
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Steps */}
      {!collapsed && (
        <div className="px-3 py-1.5 space-y-0.5">
          {steps.map((step, i) => {
            const isActive = i === activeIndex;
            return (
              <div
                key={i}
                className={cn(
                  "flex items-start gap-2 py-1 text-xs rounded-md px-1 -mx-1",
                  isActive && "bg-primary/5",
                )}
              >
                {step.done ? (
                  <CheckCircle2 className="h-3.5 w-3.5 text-chart-2 shrink-0 mt-0.5" />
                ) : isActive ? (
                  <Loader2 className="h-3.5 w-3.5 text-primary animate-spin shrink-0 mt-0.5" />
                ) : (
                  <Circle className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0 mt-0.5" />
                )}
                <span
                  className={cn(
                    "leading-relaxed",
                    step.done && "text-muted-foreground line-through",
                    isActive && "text-foreground font-medium",
                    !step.done && !isActive && "text-muted-foreground",
                  )}
                >
                  {step.text}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
