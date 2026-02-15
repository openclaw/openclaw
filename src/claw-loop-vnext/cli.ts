import { promises as fs } from "node:fs";
import path from "node:path";
import { getCurrentPhase, loadGoalFile, saveGoalFile } from "./goal.js";
import { sendCurrentPhasePrompt } from "./orchestrator.js";
import { CodexExecSdkTransport } from "./transport/codex-exec-sdk.js";
import { TmuxFallbackTransport } from "./transport/tmux-fallback.js";

export type CliRunResult = {
  exitCode: number;
};

type Action =
  | "start"
  | "check"
  | "status"
  | "prompt"
  | "direct"
  | "answer"
  | "remind"
  | "correct"
  | "approve"
  | "list";

type ParsedArgs = {
  action: Action;
  goalFile?: string;
  message?: string;
  goalsDir: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  let action: Action = "check";
  let goalFile: string | undefined;
  let message: string | undefined;
  const goalsDir = process.env.GOALS_DIR ?? path.join(process.env.HOME ?? ".", "clawd", "goals");

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (
      arg === "start" ||
      arg === "check" ||
      arg === "status" ||
      arg === "prompt" ||
      arg === "direct" ||
      arg === "answer" ||
      arg === "remind" ||
      arg === "correct" ||
      arg === "approve" ||
      arg === "list"
    ) {
      action = arg;
      continue;
    }

    if (arg === "--goal") {
      goalFile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--goal=")) {
      goalFile = arg.slice("--goal=".length);
      continue;
    }
    if (arg === "--msg" || arg === "--message") {
      message = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--msg=") || arg.startsWith("--message=")) {
      const idx = arg.indexOf("=");
      message = arg.slice(idx + 1);
      continue;
    }
    if (!arg.startsWith("-")) {
      message = message ? `${message} ${arg}` : arg;
    }
  }

  return { action, goalFile, message, goalsDir };
}

async function listGoals(goalsDir: string): Promise<void> {
  const files = await fs.readdir(goalsDir, { withFileTypes: true }).catch(() => []);
  const goalFiles = files
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(goalsDir, entry.name));

  if (goalFiles.length === 0) {
    // eslint-disable-next-line no-console
    console.log("No goals found.");
    return;
  }

  for (const file of goalFiles) {
    const goal = await loadGoalFile(file).catch(() => null);
    if (!goal) {
      continue;
    }
    const current = getCurrentPhase(goal);
    // eslint-disable-next-line no-console
    console.log(
      `${path.basename(file)} | ${goal.status} | ${current ? `${current.id}:${current.name}` : "done"} | awaitingApproval=${goal.awaitingApproval ?? "no"}`,
    );
  }
}

async function ensureGoalPath(goalFile: string | undefined): Promise<string> {
  if (!goalFile) {
    throw new Error("--goal is required");
  }
  await fs.access(goalFile);
  return goalFile;
}

function buildDirective(label: string, message?: string): string {
  return `${label}\n\n${message?.trim() || "Continue with the current phase."}\n\nOutput PHASE_COMPLETE when done.`;
}

export async function runClawLoopVNext(argv: string[]): Promise<CliRunResult> {
  const parsed = parseArgs(argv);

  if (parsed.action === "list") {
    await listGoals(parsed.goalsDir);
    return { exitCode: 0 };
  }

  if (parsed.action === "check") {
    await listGoals(parsed.goalsDir);
    return { exitCode: 0 };
  }

  const goalFile = await ensureGoalPath(parsed.goalFile);
  const goal = await loadGoalFile(goalFile);

  if (parsed.action === "status") {
    const current = getCurrentPhase(goal);
    // eslint-disable-next-line no-console
    console.log(`Goal: ${goal.title}`);
    // eslint-disable-next-line no-console
    console.log(`Status: ${goal.status}`);
    // eslint-disable-next-line no-console
    console.log(`Current phase: ${current ? `${current.id} - ${current.name}` : "none"}`);
    // eslint-disable-next-line no-console
    console.log(`Awaiting approval: ${goal.awaitingApproval ?? "no"}`);
    return { exitCode: 0 };
  }

  if (parsed.action === "approve") {
    const next = { ...goal, awaitingApproval: undefined, status: "in_progress" as const };
    await saveGoalFile(goalFile, next);
    const mode = next.orchestration?.mode ?? "sdk-first";
    const result = await sendCurrentPhasePrompt(
      {
        goalsDir: parsed.goalsDir,
        primaryTransport: new CodexExecSdkTransport(),
        fallbackTransport:
          mode === "sdk-first" || mode === "bridge" ? new TmuxFallbackTransport() : undefined,
      },
      goalFile,
    );
    // eslint-disable-next-line no-console
    console.log(
      `approval recorded, delivery=${result.delivered} transport=${result.transport} ack=${result.ackId ?? "none"}`,
    );
    return { exitCode: result.delivered ? 0 : 1 };
  }

  if (goal.awaitingApproval && parsed.action === "prompt") {
    // eslint-disable-next-line no-console
    console.log(`Checkpoint pending for ${goal.awaitingApproval}. Run approve first.`);
    return { exitCode: 2 };
  }

  if (parsed.action === "start" || parsed.action === "prompt") {
    const next = { ...goal, status: "in_progress" as const };
    await saveGoalFile(goalFile, next);
  }

  const mode = goal.orchestration?.mode ?? "sdk-first";
  const result = await sendCurrentPhasePrompt(
    {
      goalsDir: parsed.goalsDir,
      primaryTransport: new CodexExecSdkTransport(),
      fallbackTransport:
        mode === "sdk-first" || mode === "bridge" ? new TmuxFallbackTransport() : undefined,
    },
    goalFile,
    parsed.action === "direct"
      ? buildDirective("# Orchestrator Directive", parsed.message)
      : parsed.action === "answer"
        ? buildDirective("# Orchestrator Answer", parsed.message)
        : parsed.action === "remind"
          ? buildDirective("# Orchestrator Reminder", parsed.message)
          : parsed.action === "correct"
            ? buildDirective("# Orchestrator Correction", parsed.message)
            : undefined,
  );

  // eslint-disable-next-line no-console
  console.log(
    `delivery=${result.delivered} transport=${result.transport} ack=${result.ackId ?? "none"}`,
  );
  for (const signal of result.signals) {
    // eslint-disable-next-line no-console
    console.log(`signal=${signal.type}`);
  }

  return { exitCode: result.delivered ? 0 : 1 };
}
