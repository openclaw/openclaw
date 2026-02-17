import crypto from "node:crypto";
import { listSubagentRunsForRequester } from "../../agents/subagent-registry.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../agents/tools/sessions-helpers.js";
import { callGateway } from "../../gateway/call.js";
import { logVerbose } from "../../globals.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { CommandHandler } from "./commands-types.js";

type WorkflowCleanupMode = "keep" | "delete";

type WorkflowStep = {
  template: string;
  labelSuffix: string;
  task: (goal: string) => string;
};

type WorkflowDefinition = {
  id: string;
  label: string;
  steps: WorkflowStep[];
};

const COMMAND = "/workflow";
const ACTIONS = new Set(["help", "list", "run", "status"]);

const WORKFLOWS: WorkflowDefinition[] = [
  {
    id: "research-code-review",
    label: "Research -> Code -> Review",
    steps: [
      {
        template: "researcher",
        labelSuffix: "research",
        task: (goal) =>
          `Investigate the goal, gather evidence, list risks/tradeoffs, and produce a concise implementation plan with citations. Goal: ${goal}`,
      },
      {
        template: "coder",
        labelSuffix: "code",
        task: (goal) =>
          `Using Step 1 findings, implement the best approach for the goal and run targeted validation. Goal: ${goal}`,
      },
      {
        template: "reviewer",
        labelSuffix: "review",
        task: (goal) =>
          `Review Step 2 result for bugs/regressions/test gaps and return prioritized findings with severity. Goal: ${goal}`,
      },
    ],
  },
  {
    id: "bug-triage",
    label: "Bug Triage Flow",
    steps: [
      {
        template: "bug-triager",
        labelSuffix: "triage",
        task: (goal) =>
          `Triage this bug report, define impact and likely root causes, and propose the fastest safe fix strategy. Goal: ${goal}`,
      },
      {
        template: "reproducer",
        labelSuffix: "repro",
        task: (goal) =>
          `Create deterministic reproduction steps and, if possible, a minimal failing test for the bug. Goal: ${goal}`,
      },
      {
        template: "coder",
        labelSuffix: "fix",
        task: (goal) =>
          `Implement the smallest correct fix using triage + repro evidence, then run focused validation. Goal: ${goal}`,
      },
      {
        template: "reviewer",
        labelSuffix: "verify",
        task: (goal) =>
          `Verify fix quality, regression risk, and test coverage; return prioritized findings. Goal: ${goal}`,
      },
    ],
  },
  {
    id: "refactor-safety",
    label: "Refactor Safety Flow",
    steps: [
      {
        template: "researcher",
        labelSuffix: "scope",
        task: (goal) =>
          `Map current behavior/contracts and identify refactor safety constraints and edge cases. Goal: ${goal}`,
      },
      {
        template: "coder",
        labelSuffix: "refactor",
        task: (goal) =>
          `Perform the refactor with minimal behavioral change and clear commit-ready diffs. Goal: ${goal}`,
      },
      {
        template: "test-builder",
        labelSuffix: "tests",
        task: (goal) =>
          `Add or improve regression tests that lock in pre-refactor behavior. Goal: ${goal}`,
      },
      {
        template: "reviewer",
        labelSuffix: "review",
        task: (goal) =>
          `Review refactor + tests for hidden regressions, missing coverage, and maintainability risks. Goal: ${goal}`,
      },
    ],
  },
  {
    id: "test-gap",
    label: "Test Gap Flow",
    steps: [
      {
        template: "researcher",
        labelSuffix: "analysis",
        task: (goal) =>
          `Analyze the target area and list the highest-risk behaviors not currently covered by tests. Goal: ${goal}`,
      },
      {
        template: "test-builder",
        labelSuffix: "tests",
        task: (goal) =>
          `Implement focused tests for the identified gaps and keep them deterministic. Goal: ${goal}`,
      },
      {
        template: "reviewer",
        labelSuffix: "verify",
        task: (goal) =>
          `Review new tests for relevance, flakiness risk, and missing edge cases. Goal: ${goal}`,
      },
    ],
  },
  {
    id: "performance-optimization",
    label: "Performance Optimization Flow",
    steps: [
      {
        template: "profiler",
        labelSuffix: "profile",
        task: (goal) =>
          `Profile the target path, identify bottlenecks, and provide baseline metrics. Goal: ${goal}`,
      },
      {
        template: "coder",
        labelSuffix: "optimize",
        task: (goal) =>
          `Implement the most impactful low-risk optimizations and run benchmark checks. Goal: ${goal}`,
      },
      {
        template: "reviewer",
        labelSuffix: "review",
        task: (goal) =>
          `Review optimization changes for correctness tradeoffs, regressions, and measurement quality. Goal: ${goal}`,
      },
    ],
  },
  {
    id: "security-patch",
    label: "Security Patch Flow",
    steps: [
      {
        template: "security-researcher",
        labelSuffix: "security",
        task: (goal) =>
          `Perform threat-focused analysis, identify exploitable paths, and prioritize remediation. Goal: ${goal}`,
      },
      {
        template: "coder",
        labelSuffix: "patch",
        task: (goal) =>
          `Implement the highest-priority security remediation with minimal blast radius and targeted validation. Goal: ${goal}`,
      },
      {
        template: "reviewer",
        labelSuffix: "review",
        task: (goal) =>
          `Review the patch for security completeness, regressions, and remaining residual risk. Goal: ${goal}`,
      },
    ],
  },
];

function findWorkflow(raw: string | undefined) {
  const normalized = raw?.trim().toLowerCase() ?? "";
  return WORKFLOWS.find((entry) => entry.id === normalized);
}

function resolveRequesterSessionKey(params: Parameters<CommandHandler>[0]): string | undefined {
  const raw = params.sessionKey?.trim() || params.ctx.CommandTargetSessionKey?.trim();
  if (!raw) {
    return undefined;
  }
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  return resolveInternalSessionKey({ key: raw, alias, mainKey });
}

function parseTimeoutSeconds(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, parsed);
}

function buildHelp() {
  return [
    "Workflow",
    "Usage:",
    "- /workflow list",
    "- /workflow run <workflow-id> <goal>",
    "- /workflow run <workflow-id> [--label <prefix>] [--timeout <seconds>] [--cleanup keep|delete] <goal>",
    "- /workflow status",
    "",
    "Examples:",
    '- /workflow run bug-triage "Investigate flaky test in auth-login.spec.ts"',
    '- /workflow run research-code-review --label mesh --timeout 600 "Refactor session patch merge logic"',
  ].join("\n");
}

function buildWorkflowPrompt(params: {
  workflow: WorkflowDefinition;
  goal: string;
  label?: string;
  runTimeoutSeconds?: number | null;
  cleanup?: WorkflowCleanupMode;
}) {
  const goal = params.goal.trim();
  const workflow = params.workflow;
  if (!goal) {
    return "";
  }
  const suffixParts: string[] = [];
  if (typeof params.runTimeoutSeconds === "number") {
    suffixParts.push(`runTimeoutSeconds: ${params.runTimeoutSeconds}`);
  }
  if (params.cleanup === "delete") {
    suffixParts.push('cleanup: "delete"');
  }
  const suffix = suffixParts.length > 0 ? ` plus ${suffixParts.join(", ")}` : "";
  const labelPrefix = params.label?.trim() ? `${params.label?.trim()}-` : `${workflow.id}-`;
  const lines = [
    `Run the "${workflow.label}" Agentic Engineering workflow by calling \`sessions_spawn\` exactly ${workflow.steps.length} times in order.`,
    "Wait for each run to complete before starting the next one, and carry outputs forward.",
    "",
    `Goal: ${goal}`,
    "",
  ];

  workflow.steps.forEach((step, index) => {
    const stepNumber = index + 1;
    lines.push(`Step ${stepNumber} template: ${step.template}`);
    lines.push(`Step ${stepNumber} task: ${step.task(goal)}`);
    lines.push(
      `Step ${stepNumber} args extras: label: "${labelPrefix}${step.labelSuffix}"${suffix}`,
    );
    lines.push("");
  });

  lines.push("After all steps complete, reply with:");
  lines.push("1) runId + childSessionKey for each step");
  lines.push("2) final recommendation in 3-6 bullets");
  return lines.join("\n");
}

export const handleWorkflowCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (!normalized.startsWith(COMMAND)) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring ${COMMAND} from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  const rest = normalized.slice(COMMAND.length).trim();
  const tokens = rest.split(/\s+/).filter(Boolean);
  const action = (tokens.shift() ?? "help").toLowerCase();
  if (!ACTIONS.has(action)) {
    return { shouldContinue: false, reply: { text: buildHelp() } };
  }
  const requesterSessionKey = resolveRequesterSessionKey(params);
  if (!requesterSessionKey) {
    return { shouldContinue: false, reply: { text: "⚠️ Missing session key." } };
  }

  if (action === "help") {
    return { shouldContinue: false, reply: { text: buildHelp() } };
  }
  if (action === "list") {
    const lines = ["Available workflows:"];
    for (const workflow of WORKFLOWS) {
      lines.push(`- ${workflow.id}: ${workflow.label} (${workflow.steps.length} steps)`);
    }
    lines.push("");
    lines.push('Run one with: /workflow run <workflow-id> "your goal"');
    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }
  if (action === "status") {
    const runs = listSubagentRunsForRequester(requesterSessionKey);
    const active = runs.filter((entry) => !entry.endedAt).length;
    const done = runs.length - active;
    return {
      shouldContinue: false,
      reply: {
        text: [
          "Workflow status (this session):",
          `- active subagent runs: ${active}`,
          `- completed subagent runs: ${done}`,
          "",
          "Use /subagents list for per-run details.",
        ].join("\n"),
      },
    };
  }

  const workflowId = tokens.shift();
  const workflow = findWorkflow(workflowId);
  if (!workflow) {
    return {
      shouldContinue: false,
      reply: { text: `⚠️ Unknown workflow "${workflowId ?? ""}". Use /workflow list.` },
    };
  }

  let label: string | undefined;
  let runTimeoutSeconds: number | null = null;
  let cleanup: WorkflowCleanupMode = "keep";
  const goalTokens: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--label") {
      label = tokens[i + 1];
      i += 1;
      continue;
    }
    if (token.startsWith("--label=")) {
      label = token.slice("--label=".length);
      continue;
    }
    if (token === "--timeout") {
      runTimeoutSeconds = parseTimeoutSeconds(tokens[i + 1]);
      i += 1;
      continue;
    }
    if (token.startsWith("--timeout=")) {
      runTimeoutSeconds = parseTimeoutSeconds(token.slice("--timeout=".length));
      continue;
    }
    if (token === "--cleanup") {
      const next = tokens[i + 1];
      cleanup = next === "delete" ? "delete" : "keep";
      i += 1;
      continue;
    }
    if (token.startsWith("--cleanup=")) {
      cleanup = token.slice("--cleanup=".length) === "delete" ? "delete" : "keep";
      continue;
    }
    goalTokens.push(token);
  }
  const goal = goalTokens.join(" ").trim();
  if (!goal) {
    return {
      shouldContinue: false,
      reply: {
        text: `Usage: /workflow run ${workflow.id} <goal>\nExample: /workflow run ${workflow.id} "Fix flaky CI retries in mesh gateway tests"`,
      },
    };
  }

  const prompt = buildWorkflowPrompt({
    workflow,
    goal,
    label,
    runTimeoutSeconds,
    cleanup,
  });
  const idempotencyKey = crypto.randomUUID();
  const result = await callGateway<{ runId?: string }>({
    method: "agent",
    params: {
      message: prompt,
      sessionKey: requesterSessionKey,
      idempotencyKey,
      deliver: false,
      timeout: 0,
      channel: INTERNAL_MESSAGE_CHANNEL,
    },
    timeoutMs: 10_000,
  });
  const runId = typeof result?.runId === "string" ? result.runId : undefined;
  return {
    shouldContinue: false,
    reply: {
      text: [
        `✅ Dispatched workflow "${workflow.label}".`,
        runId ? `Run: ${runId}` : null,
        "Track progress with /subagents list",
      ]
        .filter(Boolean)
        .join("\n"),
    },
  };
};
