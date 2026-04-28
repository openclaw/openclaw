import fs from "node:fs";
import path from "node:path";
import type {
  WorkObject,
  WorkObjectEvidence,
  WorkObjectStatus,
  WorkObjectWorkerEngine,
  WorkObjectWorkerRole,
  WorkObjectWorkerVerdict,
} from "./types.js";
import { runCommandWithTimeout, type SpawnResult } from "../process/exec.js";
import {
  createDefaultCodingWorkerPolicy,
  evaluateWorkObjectPolicy,
  requiresAdaMedicalDeviceRegulatory,
} from "./policy.js";
import {
  addWorkObjectWorkerRun,
  completeWorkObject,
  getWorkObject,
  patchWorkObject,
  updateWorkObjectWorkerRun,
} from "./store.js";

export type CodingFanoutCommand = {
  argv: string[];
  cwd: string;
  input?: string;
  timeoutMs: number;
};

export type CodingFanoutCommandRunner = (command: CodingFanoutCommand) => Promise<SpawnResult>;

export type CodingFanoutOptions = {
  workObjectId: string;
  workspaceDir: string;
  task: string;
  changedFiles?: string[];
  tags?: string[];
  timeoutMs?: number;
  codexModel?: string;
  claudeModel?: string;
  geminiModel?: string;
  regulatoryPackagePath?: string;
  runner?: CodingFanoutCommandRunner;
  nowMs?: () => number;
};

export type CodingFanoutResult = {
  workObject?: WorkObject;
  status: WorkObjectStatus;
  policySatisfied: boolean;
  missingRoles: WorkObjectWorkerRole[];
  failedRoles: WorkObjectWorkerRole[];
};

function compact(value: string, max = 20_000): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max)}\n... (truncated)`;
}

function combinedOutput(result: SpawnResult): string {
  return compact([result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n\n"));
}

function formatCommand(argv: string[]): string {
  return argv
    .map((arg) => (/^[a-zA-Z0-9_./:=+-]+$/.test(arg) ? arg : JSON.stringify(arg)))
    .join(" ");
}

function verdictFromOutput(
  output: string,
  fallback: WorkObjectWorkerVerdict["status"],
): WorkObjectWorkerVerdict {
  const head = output.slice(0, 2_000);
  const status = /\bFAIL\b/i.test(head)
    ? "fail"
    : /\bWARN\b/i.test(head)
      ? "warn"
      : /\bPASS\b/i.test(head)
        ? "pass"
        : fallback;
  return { status, summary: compact(output || status, 4_000) };
}

function buildCodexPrompt(task: string): string {
  return [
    "Implement the requested change in this repository/worktree.",
    "Stay inside scope. Prefer small, reviewable edits.",
    "Run the narrowest meaningful verification you can.",
    "Final response must include: files changed, tests/checks run, evidence, and blockers.",
    "",
    "Task:",
    task,
  ].join("\n");
}

function buildClaudeReviewPrompt(params: { task: string; codexOutput: string }): string {
  return [
    "You are Clawd, a Claude Code Opus reviewer. Use the strongest/deepest reasoning available.",
    "Review the implementation in this repository as an adversarial architect and code reviewer.",
    "Do not make changes unless a tiny correction is essential; prefer review findings.",
    "Start your final answer with exactly one verdict token: PASS, WARN, or FAIL.",
    "Then give evidence-backed findings, missing tests, risks, and whether final completion should be blocked.",
    "",
    "Original task:",
    params.task,
    "",
    "Codex implementer output:",
    params.codexOutput || "(no output)",
  ].join("\n");
}

function buildGeminiVerifyPrompt(params: {
  task: string;
  codexOutput: string;
  claudeOutput: string;
}): string {
  return [
    "You are the Gemini CLI verifier. Use the strongest available Gemini model configured for this CLI.",
    "Independently verify whether the repository state satisfies the task and the reviewer concerns.",
    "Start your final answer with exactly one verdict token: PASS, WARN, or FAIL.",
    "Cite concrete evidence: files inspected, tests/builds/checks, or precise blockers.",
    "",
    "Original task:",
    params.task,
    "",
    "Codex implementer output:",
    params.codexOutput || "(no output)",
    "",
    "Clawd reviewer output:",
    params.claudeOutput || "(no output)",
  ].join("\n");
}

function commandForWorker(params: {
  engine: WorkObjectWorkerEngine;
  prompt: string;
  model?: string;
}): string[] {
  if (params.engine === "codex") {
    return [
      "codex",
      "exec",
      "--full-auto",
      "--skip-git-repo-check",
      ...(params.model ? ["--model", params.model] : []),
      params.prompt,
    ];
  }
  if (params.engine === "claude-code") {
    return [
      "claude",
      "--permission-mode",
      "bypassPermissions",
      "--print",
      ...(params.model ? ["--model", params.model] : []),
      params.prompt,
    ];
  }
  if (params.engine === "gemini-cli") {
    return ["gemini", ...(params.model ? ["--model", params.model] : []), params.prompt];
  }
  throw new Error(`Unsupported fanout worker engine: ${params.engine}`);
}

async function runWorker(params: {
  workObjectId: string;
  role: WorkObjectWorkerRole;
  engine: WorkObjectWorkerEngine;
  label: string;
  model?: string;
  modelStrategy?: "explicit" | "strongest_available" | "default";
  prompt: string;
  workspaceDir: string;
  timeoutMs: number;
  runner: CodingFanoutCommandRunner;
  now: () => number;
}): Promise<{ output: string; verdict: WorkObjectWorkerVerdict; ok: boolean }> {
  const workerRunId = `${params.role}-${params.engine}-${params.now()}`;
  const argv = commandForWorker({
    engine: params.engine,
    prompt: params.prompt,
    model: params.model,
  });
  addWorkObjectWorkerRun(params.workObjectId, {
    id: workerRunId,
    role: params.role,
    engine: params.engine,
    label: params.label,
    model: params.model,
    modelStrategy: params.modelStrategy,
    status: "running",
    startedAtMs: params.now(),
    evidence: [
      {
        id: `${workerRunId}-command`,
        kind: "command",
        label: `${params.label} command`,
        value: formatCommand(argv),
        atMs: params.now(),
      },
    ],
  });

  const result = await params.runner({
    argv,
    cwd: params.workspaceDir,
    timeoutMs: params.timeoutMs,
  });
  const output = combinedOutput(result);
  const ok = result.code === 0;
  const verdict = verdictFromOutput(output, ok ? "pass" : "fail");
  updateWorkObjectWorkerRun({
    workObjectId: params.workObjectId,
    workerRunId,
    patch: {
      status: ok ? "succeeded" : "failed",
      endedAtMs: params.now(),
      output,
      verdict,
      evidence: [
        {
          kind: ok ? "text" : "command",
          label: `${params.label} output`,
          value: output || `(exit ${String(result.code)})`,
        },
      ],
    },
  });
  return { output, verdict, ok: ok && verdict.status !== "fail" };
}

function regulatoryEvidence(packagePath: string | undefined): WorkObjectEvidence[] {
  const atMs = Date.now();
  if (!packagePath) {
    return [
      {
        id: "regulatory-missing",
        kind: "text",
        label: "Ada regulatory package missing",
        value:
          "Ada medical-device work requires an IEC 62304 regulatory package before final success.",
        atMs,
      },
    ];
  }
  return [
    {
      id: "regulatory-package",
      kind: "file",
      label: "Ada regulatory package",
      path: packagePath,
      value: packagePath,
      atMs,
    },
  ];
}

function resolveRegulatoryPackagePath(
  packagePath: string | undefined,
  workspaceDir: string,
): string | undefined {
  if (!packagePath?.trim()) {
    return undefined;
  }
  return path.isAbsolute(packagePath) ? packagePath : path.resolve(workspaceDir, packagePath);
}

export async function runCodingFanout(options: CodingFanoutOptions): Promise<CodingFanoutResult> {
  const now = options.nowMs ?? Date.now;
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? 30 * 60_000));
  const runner = options.runner ?? ((command) => runCommandWithTimeout(command.argv, command));
  const regulatoryRequired = requiresAdaMedicalDeviceRegulatory({
    workspaceDir: options.workspaceDir,
    changedFiles: options.changedFiles,
    tags: options.tags,
  });
  patchWorkObject(options.workObjectId, {
    status: "running",
    workerPolicy: createDefaultCodingWorkerPolicy({
      adaMedicalDeviceRegulatoryRequired: regulatoryRequired,
    }),
    evidence: [
      {
        kind: "text",
        label: "Fan-out policy started",
        value: regulatoryRequired
          ? "Running Codex implementer, Clawd reviewer, Gemini verifier, and Ada regulatory gate."
          : "Running Codex implementer, Clawd reviewer, and Gemini verifier.",
      },
    ],
    nowMs: now(),
  });

  const codex = await runWorker({
    workObjectId: options.workObjectId,
    role: "implementer",
    engine: "codex",
    label: "Codex implementer",
    model: options.codexModel,
    modelStrategy: options.codexModel ? "explicit" : "default",
    prompt: buildCodexPrompt(options.task),
    workspaceDir: options.workspaceDir,
    timeoutMs,
    runner,
    now,
  });
  if (!codex.ok) {
    const workObject = completeWorkObject({
      id: options.workObjectId,
      status: "failed",
      summary: "Codex implementation pass failed.",
      output: codex.output,
      nowMs: now(),
    });
    return {
      workObject,
      status: "failed",
      policySatisfied: false,
      missingRoles: [],
      failedRoles: ["implementer"],
    };
  }

  const claude = await runWorker({
    workObjectId: options.workObjectId,
    role: "reviewer",
    engine: "claude-code",
    label: "Clawd / Claude Code reviewer",
    model: options.claudeModel ?? "claude-opus-4-7",
    modelStrategy: "explicit",
    prompt: buildClaudeReviewPrompt({ task: options.task, codexOutput: codex.output }),
    workspaceDir: options.workspaceDir,
    timeoutMs,
    runner,
    now,
  });
  if (!claude.ok) {
    const workObject = completeWorkObject({
      id: options.workObjectId,
      status: "needs_review",
      summary: "Clawd review blocked final completion.",
      output: claude.output,
      nowMs: now(),
    });
    return {
      workObject,
      status: "needs_review",
      policySatisfied: false,
      missingRoles: [],
      failedRoles: ["reviewer"],
    };
  }

  const gemini = await runWorker({
    workObjectId: options.workObjectId,
    role: "verifier",
    engine: "gemini-cli",
    label: "Gemini CLI verifier",
    model: options.geminiModel,
    modelStrategy: options.geminiModel ? "explicit" : "strongest_available",
    prompt: buildGeminiVerifyPrompt({
      task: options.task,
      codexOutput: codex.output,
      claudeOutput: claude.output,
    }),
    workspaceDir: options.workspaceDir,
    timeoutMs,
    runner,
    now,
  });
  if (!gemini.ok) {
    const workObject = completeWorkObject({
      id: options.workObjectId,
      status: "needs_review",
      summary: "Gemini verification blocked final completion.",
      output: gemini.output,
      nowMs: now(),
    });
    return {
      workObject,
      status: "needs_review",
      policySatisfied: false,
      missingRoles: [],
      failedRoles: ["verifier"],
    };
  }

  const packagePath = resolveRegulatoryPackagePath(
    options.regulatoryPackagePath,
    options.workspaceDir,
  );
  if (regulatoryRequired) {
    const packageExists = Boolean(packagePath && fs.existsSync(packagePath));
    addWorkObjectWorkerRun(options.workObjectId, {
      id: `regulatory-${now()}`,
      role: "judge",
      engine: "external",
      label: "Ada IEC 62304 regulatory package",
      status: packageExists ? "succeeded" : "failed",
      verdict: {
        status: packageExists ? "pass" : "fail",
        summary: packageExists
          ? "Ada regulatory package exists."
          : "Ada medical-device work requires a regulatory package before final success.",
      },
      evidence: regulatoryEvidence(packagePath),
      endedAtMs: now(),
    });
    if (!packageExists) {
      const workObject = completeWorkObject({
        id: options.workObjectId,
        status: "needs_review",
        summary: "Ada regulatory package is required before final completion.",
        output: "Run the regulatory skill and attach the IEC 62304 compliance package.",
        nowMs: now(),
      });
      return {
        workObject,
        status: "needs_review",
        policySatisfied: false,
        missingRoles: [],
        failedRoles: ["judge"],
      };
    }
  }

  const latest = getWorkObject(options.workObjectId);
  const policy = latest
    ? evaluateWorkObjectPolicy(latest)
    : { satisfied: false, missingRoles: [], failedRoles: ["judge" as WorkObjectWorkerRole] };
  const finalStatus: WorkObjectStatus = policy.satisfied ? "succeeded" : "needs_review";
  const workObject = completeWorkObject({
    id: options.workObjectId,
    status: finalStatus,
    summary: policy.satisfied
      ? "Codex implementation, Clawd review, and Gemini verification passed."
      : "Multi-worker policy did not pass.",
    output: [codex.output, claude.output, gemini.output].filter(Boolean).join("\n\n---\n\n"),
    nowMs: now(),
  });
  return {
    workObject,
    status: finalStatus,
    policySatisfied: policy.satisfied,
    missingRoles: policy.missingRoles,
    failedRoles: policy.failedRoles,
  };
}
