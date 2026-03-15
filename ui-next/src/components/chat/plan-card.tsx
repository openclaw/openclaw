import { ChevronDown, ChevronRight, CheckCircle2, Circle, Loader2 } from "lucide-react";
import { useState, useMemo } from "react";
import { cn } from "@/lib/utils";

export type PlanStep = {
  text: string;
  done: boolean;
};

// Match both markdown task lists (- [ ] / - [x]) and Unicode checkbox variants (☐ / ☑ / ✅ / ✓)
const TASK_LIST_RE = /^[-*]\s+(?:\[([ xX])\]|([☐☑✅✓]))\s+(.+)$/gmu;

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
  // Allow the checklist to start within the first ~500 chars (room for a heading + intro paragraph)
  const preamble = text.slice(0, firstMatch.index);
  // Strip whitespace and short headings — a plan preamble may include a brief intro
  const substantiveChars = preamble.replace(/^#+\s+.*$/gm, "").replace(/\s+/g, "").length;
  return substantiveChars < 250;
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
  // Extract only the FIRST contiguous block of checklist items.
  // Stop at the first non-checklist, non-blank line after the block starts.
  // This prevents feature lists and secondary checklists in the body from
  // being absorbed into the plan card.
  const lines = text.split("\n");
  const steps: PlanStep[] = [];
  const seen = new Map<string, number>();
  let blockStarted = false;
  let blockEndLine = -1;
  let blockStartLine = -1;

  for (let i = 0; i < lines.length; i++) {
    TASK_LIST_RE.lastIndex = 0;
    const match = TASK_LIST_RE.exec(lines[i]);
    if (match) {
      if (!blockStarted) {
        blockStarted = true;
        blockStartLine = i;
      }
      const stepText = (match[3] ?? "").trim();
      const done = match[1] !== undefined ? match[1] !== " " : match[2] !== "☐";
      const existingIdx = seen.get(stepText);
      if (existingIdx !== undefined) {
        steps[existingIdx].done = done;
      } else {
        seen.set(stepText, steps.length);
        steps.push({ text: stepText, done });
      }
      blockEndLine = i;
    } else if (blockStarted && lines[i].trim() !== "") {
      // Non-checklist, non-blank line after block started — stop
      break;
    }
  }

  if (steps.length === 0) {
    return { steps: [], rest: text };
  }
  // Remove only the first contiguous checklist block from the text.
  const beforeBlock = lines.slice(0, blockStartLine).join("\n");
  const afterBlock = lines.slice(blockEndLine + 1).join("\n");
  let rest = `${beforeBlock}\n${afterBlock}`;

  // Strip headings that label the plan block (must be on their own line)
  rest = rest.replace(/^#{1,4}\s+(?:(?:Updated\s+)?Plan(?:ning)?)\s*$/gim, "");

  // Strip orphaned horizontal rules left around the removed plan block.
  // First collapse any sequence of blank-lines-and-rules into one rule.
  rest = rest.replace(/(?:(?:^|\n)\s*---\s*(?:\n|$)\s*){2,}/g, "\n\n---\n\n");
  // Remove leading/trailing --- (plan was at start or end of message)
  rest = rest.replace(/^\s*---\s*\n/, "");
  rest = rest.replace(/\n\s*---\s*$/, "");

  rest = rest.replace(/\n{3,}/g, "\n\n").trim();
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
