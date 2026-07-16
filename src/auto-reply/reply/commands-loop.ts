/**
 * Handles /loop autonomous agent loop command and result formatting.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { markCommandSessionMetadataChanged } from "./command-session-metadata.js";
import type {
  CommandHandlerResult,
} from "./commands-types.js";
import type { LoopPhase, LoopSubtask } from "../../loop/loop-types.js";
import { LOOP_PHASE_LABELS } from "../../loop/loop-types.js";

const LOOP_COMMAND_PREFIX = "/loop";

/** Parses /loop command arguments, extracting task and optional flags. */
export function parseLoopCommand(raw: string): {
  task: string;
  maxIterations: number;
  tokenBudget?: number;
} | null {
  const trimmed = raw.trim();
  const commandEnd = trimmed.search(/\s/);
  const commandToken = commandEnd === -1 ? trimmed : trimmed.slice(0, commandEnd);
  if (normalizeOptionalLowercaseString(commandToken) !== LOOP_COMMAND_PREFIX) {
    return null;
  }
  const argText = commandEnd === -1 ? "" : trimmed.slice(commandEnd).trim();
  if (!argText) {
    return null;
  }

  let task = argText;
  let maxIterations = 10;
  let tokenBudget: number | undefined;

  // Parse --max-iterations and --budget flags
  const flagPattern = /--(max-iterations|budget)\s+(\S+)/g;
  const flagArgs: Array<{ key: string; raw: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = flagPattern.exec(argText)) !== null) {
    flagArgs.push({ key: match[1]!, raw: match[2]! });
  }

  for (const { key, raw } of flagArgs) {
    if (key === "max-iterations") {
      const parsed = parseInt(raw, 10);
      if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 100) {
        maxIterations = parsed;
      }
    }
    if (key === "budget") {
      const parsed = parseInt(raw, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        tokenBudget = parsed;
      }
    }
  }

  // Remove flag segments from the task text
  task = task.replace(/--(max-iterations|budget)\s+\S+/g, "").trim();

  if (!task) {
    return null;
  }

  return { task, maxIterations, tokenBudget };
}

function loopReply(text: string): CommandHandlerResult {
  return {
    shouldContinue: false,
    reply: { text },
  };
}


// ── Phase prompt builders ──────────────────────────────────────────

/** Builds the Phase 1 (Analyze) prompt. */
export function buildAnalyzePrompt(task: string): string {
  return (
    `# /loop: Phase 1 of 5 — ${LOOP_PHASE_LABELS.analyze}\n` +
    `## Task\n${task}\n\n` +
    "## Instructions\n" +
    "You are in the first phase of an autonomous loop. Thoroughly analyze what needs to be done:\n\n" +
    "1. **Examine the codebase** — read relevant files, understand the current structure\n" +
    "2. **Identify**:\n" +
    "   - What needs to change or be created\n" +
    "   - Existing patterns and conventions to follow\n" +
    "   - Dependencies, potential conflicts, and affected areas\n" +
    "   - Test files that will need updating\n" +
    "   - Any blockers or risks\n" +
    "3. **Provide a comprehensive analysis** — be specific, reference files and line numbers\n\n" +
    "## Completion\n" +
    "When your analysis is complete, call **loop_update** with:\n" +
    '- action: "phase_complete"\n' +
    '- phase: "analyze"\n' +
    '- summary: "[Your analysis summary — concisely state findings]"'
  );
}

/** Builds the Phase 2 (Plan) prompt with analysis context. */
export function buildPlanPrompt(task: string, analysisSummary: string): string {
  return (
    `# /loop: Phase 2 of 5 — ${LOOP_PHASE_LABELS.plan}\n` +
    `## Task\n${task}\n\n` +
    "## Analysis Summary\n" +
    (analysisSummary || "(No analysis available — proceed directly to planning.)") +
    "\n\n" +
    "## Instructions\n" +
    "Based on the analysis, create a detailed implementation plan.\n\n" +
    "Break the work into discrete subtasks. **Each subtask must include**:\n" +
    '- **id**: Unique identifier (e.g. "subtask-1")\n' +
    '- **name**: Short, descriptive name (e.g. "Create login page")\n' +
    "- **description**: What needs to be done\n" +
    "- **acceptanceCriteria**: Concrete conditions that prove completion\n" +
    '- **dependencies**: Array of subtask IDs this depends on, or empty array "[]"\n' +
    "- **parallelizable**: Whether it can run in parallel with other tasks\n\n" +
    "Try to keep subtasks focused and actionable. 3-8 subtasks is a good range.\n\n" +
    "## Completion\n" +
    "When your plan is ready, call **loop_update** with:\n" +
    '- action: "phase_complete"\n' +
    '- phase: "plan"\n' +
    '- summary: "[Plan overview — what the key milestones are]"' +
    '\n- subtasks: [array of subtask objects with id, name, description, acceptanceCriteria, dependencies, parallelizable]'
  );
}

/**
 * Extracts subtasks from the plan phase response.
 * The TUI controller reads subtasks directly from module state
 * after the plan phase completes. This function is kept for
 * backward compatibility.
 */
export function extractSubtasksFromAgentResponse(): LoopSubtask[] {
  return [];
}

// ── Serial subtask mini-loop prompts ───────────────────────────────
//
// Serial subtasks go through a tight per-task cycle:
//   Execute → Verify → (if fail) Fix → Re-verify → (next task)
//
// Parallel subtasks are dispatched together via sessions_spawn.

/** Builds the execute prompt for a single serial subtask. */
export function buildSerialExecutePrompt(
  subtask: LoopSubtask,
  overallTask?: string,
): string {
  return (
    `# /loop: Execution - ${subtask.name}\n` +
    (overallTask ? `## Overall Task\n${overallTask}\n\n` : "") +
    `## Acceptance Criteria\n` +
    subtask.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n") +
    "\n\n## Instructions\n" +
    `Execute the subtask "${subtask.name}".\n\n` +
    `${subtask.description}\n\n` +
    "1. Read and edit files as needed\n" +
    "2. Ensure changes meet ALL acceptance criteria above\n" +
    "3. **Run relevant tests** — execute `pnpm test <path>` or `pnpm tsgo` for affected files.\n" +
    "   If tests fail, fix until they pass.\n" +
    "4. Review `git diff` to confirm only intended changes were made.\n\n" +
    "After execution, call **loop_update** with:\n" +
    '- action: "phase_complete"\n' +
    '- phase: "execute"\n' +
    `- subtaskId: "${subtask.id}"\n` +
    '- summary: "[What was done, key changes made, how criteria were met]"'
  );
}

/** Builds the verify prompt for a single serial subtask. */
export function buildSerialVerifyPrompt(subtask: LoopSubtask): string {
  return (
    `# /loop: Verification - ${subtask.name}\n` +
    "## Role\n" +
    "You are a **verifier**. Your job is to inspect the implementation against each acceptance criterion.\n\n" +
    "## Acceptance Criteria\n" +
    subtask.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n") +
    "\n\n## Instructions\n" +
    `Verify the subtask "${subtask.name}".\n\n` +
    "**You MUST collect and report concrete evidence for every criterion. Opinion alone is not sufficient.**\n\n" +
    "### Required evidence checklist (do all that apply):\n" +
    "1. **File evidence** — For each file created or modified, read its content and confirm changes match expectations.\n" +
    "2. **Git diff** — Run `git diff` to review the exact changes. Include relevant excerpts in your summary.\n" +
    "3. **Syntax/type check** — Run `pnpm tsgo` (or equivalent type checker) on affected files. Report the command output.\n" +
    "4. **Test execution** — Run relevant tests via `pnpm test <path>`. Report the command, output, and pass/fail.\n" +
    "5. **Criterion-by-criterion** — For each acceptance criterion, state whether it passes and show the code or test output that proves it.\n" +
    "6. **Edge cases** — Check error handling, security issues, and regressions. Be specific about what was inspected.\n\n" +
    "### Decision rules\n" +
    "- If EVERY criterion is met and no blocking issues exist, set **passed: true**.\n" +
    "- If ANY criterion is not met or blocking issues exist, set **passed: false** and list each failure with evidence.\n" +
    "- If evidence cannot be collected (e.g. tests cannot run), state why and whether the gap is acceptable.\n\n" +
    "## Completion\n" +
    "Call **loop_update** with:\n" +
    '- action: "phase_complete"\n' +
    '- phase: "verify"\n' +
    `- subtaskId: "${subtask.id}"\n` +
    "- passed: true (all criteria met) or false (issues found)\n" +
    '- summary: "[Detailed findings — include command outputs, file paths checked, pass/fail per criterion]"'
  );
}

/**
 * Builds the verify prompt for a spawned sub-agent session.
 *
 * Unlike buildSerialVerifyPrompt (which asks the agent to call loop_update),
 * this version outputs structured verdict markers at the end of the response
 * so the TUI handler can parse the result without requiring tool calls.
 */
export function buildSpawnedVerifyPrompt(subtask: LoopSubtask): string {
  return (
    `# /loop: Verification - ${subtask.name}\n` +
    "## Role\n" +
    "You are an **independent verifier** in a fresh session. You have never seen this code before.\n" +
    "Your job is to inspect the implementation against each acceptance criterion.\n\n" +
    "## Acceptance Criteria\n" +
    subtask.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n") +
    "\n\n## Instructions\n" +
    `Verify the subtask "${subtask.name}".\n\n` +
    "**You MUST collect and report concrete evidence for every criterion. Opinion alone is not sufficient.**\n\n" +
    "### Required evidence checklist (do all that apply):\n" +
    "1. **File evidence** — For each file created or modified, read its content and confirm changes match expectations.\n" +
    "2. **Git diff** — Run `git diff` to review the exact changes. Include relevant excerpts in your summary.\n" +
    "3. **Syntax/type check** — Run `pnpm tsgo` (or equivalent type checker) on affected files. Report the command output.\n" +
    "4. **Test execution** — Run relevant tests via `pnpm test <path>`. Report the command, output, and pass/fail.\n" +
    "5. **Criterion-by-criterion** — For each acceptance criterion, state whether it passes and show the code or test output that proves it.\n" +
    "6. **Edge cases** — Check error handling, security issues, and regressions. Be specific about what was inspected.\n\n" +
    "### Decision rules\n" +
    "- If EVERY criterion is met and no blocking issues exist, set **passed: true**.\n" +
    "- If ANY criterion is not met or blocking issues exist, set **passed: false** and list each failure with evidence.\n" +
    "- If evidence cannot be collected (e.g. tests cannot run), state why and whether the gap is acceptable.\n\n" +
    "## Response Format\n" +
    "At the **end** of your response, include the following verdict markers exactly:\n" +
    "```\n" +
    "---VERDICT---\n" +
    "passed: true\n" +
    "---SUMMARY---\n" +
    "[One-line summary of findings]\n" +
    "```\n" +
    "(Replace `true` with `false` if any criterion fails.)\n" +
    "The structured markers are required — the system will parse them to record the result."
  );
}

/** Builds the fix/re-execute prompt for a subtask that failed verification. */
export function buildSerialFixPrompt(
  subtask: LoopSubtask,
  verifyIssues: string,
): string {
  return (
    `# /loop: Fix - ${subtask.name} (Verification Failed)\n` +
    "## Issues Found\n" +
    verifyIssues +
    "\n\n## Acceptance Criteria\n" +
    subtask.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n") +
    "\n\n## Instructions\n" +
    `Fix the issues above for subtask "${subtask.name}".\n\n` +
    "1. Address each issue listed above\n" +
    "2. Ensure all acceptance criteria are still met\n" +
    "3. Run `pnpm test <path>` or `pnpm tsgo` to confirm the fix passes tests\n" +
    "4. Review `git diff` to confirm only intended changes were made\n\n" +
    "After fixing, call **loop_update** with:\n" +
    '- action: "phase_complete"\n' +
    '- phase: "execute"\n' +
    `- subtaskId: "${subtask.id}"\n` +
    '- summary: "[What was fixed and how]"'
  );
}

/** Builds the dispatch prompt for parallel subtasks. */
export function buildParallelDispatchPrompt(
  subtasks: LoopSubtask[],
  overallTask?: string,
): string {
  const taskList = subtasks
    .map(
      (s, i) =>
        `### Subtask ${i + 1}: ${s.name}\n` +
        `ID: \`${s.id}\`\n` +
        `${s.description}\n` +
        "Acceptance Criteria:\n" +
        s.acceptanceCriteria.map((c, j) => `  ${j + 1}. ${c}`).join("\n"),
    )
    .join("\n\n");

  return (
    `# /loop: Parallel Dispatch - ${subtasks.length} Parallel Subtasks\n` +
    (overallTask ? `## Overall Task\n${overallTask}\n\n` : "") +
    "## Subtasks\n" +
    taskList +
    "\n\n## Instructions\n" +
    `Dispatch these ${subtasks.length} parallel subtasks using **sessions_spawn**.\n` +
    "Each subtask should run in its own sub-agent session.\n\n" +
    "For each **sessions_spawn** call:\n" +
    '- mode: "run"\n' +
    "- task: the subtask's description and acceptance criteria\n" +
    "- cleanup: \"delete\" (auto-cleanup after completion)\n\n" +
    "Track progress by calling **loop_update** for each subtask:\n" +
    '- action: "subtask_status"\n' +
    '- subtaskId: "[the subtask id]"\n' +
    '- subtaskStatus: "in-progress" | "complete" | "failed"\n' +
    '- result: "[what the sub-agent accomplished]"' +
    "\n\n## Completion\n" +
    "When ALL parallel subtasks are complete, call **loop_update** with:\n" +
    '- action: "phase_complete"\n' +
    '- phase: "execute"\n' +
    '- summary: "[Summary of all parallel task results]"'
  );
}

/** Builds the Phase 5 (Report) prompt with all subtask results. */
export function buildReportPrompt(
  task: string,
  subtasks?: LoopSubtask[],
): string {
  const subtaskLines = (subtasks ?? [])
    .map(
      (s) =>
        `- **${s.name}** (${s.status})` +
        (s.verdict
          ? s.verdict.passed
            ? " ✅ Verified"
            : " ❌ Failed verification"
          : "") +
        (s.result ? `\n  Result: ${s.result.slice(0, 200)}` : ""),
    )
    .join("\n");

  return (
    `# /loop: Phase 5 of 5 — ${LOOP_PHASE_LABELS.report}\n` +
    `## Task\n${task}\n\n` +
    "## Subtask Results\n" +
    subtaskLines +
    "\n\n## Instructions\n" +
    "Generate a comprehensive final report summarizing:\n\n" +
    "1. **What was accomplished** — overview of all changes\n" +
    "2. **Key files changed or created** — with brief descriptions\n" +
    "3. **Architecture decisions** — why certain approaches were chosen\n" +
    "4. **Remaining issues** — known limitations, follow-up work, edge cases\n" +
    "5. **Verification summary** — what passed, what needs attention\n\n" +
    "Write a thorough, well-structured report.\n\n" +
    "## Completion\n" +
    "When the report is ready, call **loop_update** with:\n" +
    '- action: "phase_complete"\n' +
    '- phase: "report"\n' +
    '- summary: "[Full comprehensive report text]"'
  );
}

// ── Spawned verify helpers ────────────────────────────────────────────

/** Parses the verdict from a spawned verifier agent response text. */
export function parseSpawnedVerdict(
  text: string,
): { passed: boolean; summary: string } | null {
  const verdictMatch = text.match(/---VERDICT---\s*\n\s*passed:\s*(true|false)/i);
  if (!verdictMatch) return null;
  const passed = verdictMatch[1]!.toLowerCase() === "true";
  const summaryMatch = text.match(/---SUMMARY---\s*\n([\s\S]*?)(?:\n```|$)/);
  const summary = summaryMatch ? summaryMatch[1]!.trim() : "";
  return { passed, summary };
}

// ── Phase info helper ──────────────────────────────────────────────

const PHASE_INDEX_MAP: Record<string, number> = {
  analyze: 0,
  plan: 1,
  execute: 2,
  verify: 3,
  report: 4,
};

export function getPhaseIndex(phase: LoopPhase): number {
  return PHASE_INDEX_MAP[phase] ?? -1;
}

/** Formats a loop result report for display. */
export function formatLoopResultReport(result: {
  success: boolean;
  reason: string;
  iterations: number;
  tokenUsage: number;
  task: string;
  summary: string;
}): string {
  const statusEmoji = result.success ? "✅" : "⏹️";
  const lines = [
    `${statusEmoji} Loop ${result.success ? "completed" : "stopped"}`,
    `  Task: ${result.task}`,
    `  Iterations: ${result.iterations}`,
    `  Token usage: ~${result.tokenUsage.toLocaleString()}`,
    `  Reason: ${result.reason}`,
  ];
  if (result.summary) {
    lines.push(`  Summary: ${result.summary.slice(0, 300)}`);
  }
  return lines.join("\n");
}
