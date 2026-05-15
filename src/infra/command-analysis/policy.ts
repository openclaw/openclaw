import {
  analyzeArgvCommand,
  analyzeShellCommand,
  isWindowsPlatform,
  type ExecCommandAnalysis,
  type ExecCommandSegment,
} from "../exec-approvals-analysis.js";
import { detectInlineEvalInSegments } from "./risks.js";

export type CommandPolicyAnalysis =
  | {
      ok: true;
      source: "argv" | "shell";
      analysis: ExecCommandAnalysis;
      segments: ExecCommandSegment[];
    }
  | {
      ok: false;
      source: "argv" | "shell";
      reason?: string;
      analysis: ExecCommandAnalysis;
      segments: [];
    };

export async function analyzeCommandForPolicy(
  params:
    | {
        source: "shell";
        command: string;
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        platform?: string | null;
      }
    | {
        source: "argv";
        argv: string[];
        cwd?: string;
        env?: NodeJS.ProcessEnv;
      },
): Promise<CommandPolicyAnalysis> {
  const analysis =
    params.source === "shell"
      ? await analyzeShellCommandForPolicy(params)
      : analyzeArgvCommand({ argv: params.argv, cwd: params.cwd, env: params.env });
  if (!analysis.ok) {
    return {
      ok: false,
      source: params.source,
      reason: analysis.reason,
      analysis,
      segments: [],
    };
  }
  return {
    ok: true,
    source: params.source,
    analysis,
    segments: analysis.segments,
  };
}

async function analyzeShellCommandForPolicy(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): Promise<ExecCommandAnalysis> {
  if (isWindowsPlatform(params.platform)) {
    return analyzeShellCommand({
      command: params.command,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
    });
  }
  const { createExecCommandAnalysisFromAuthorizationPlan, planCommandForAuthorization } =
    await import("../command-authorization/index.js");
  const plan = await planCommandForAuthorization(
    { dialect: "posix-shell", command: params.command },
    {
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
    },
  );
  const analysis = createExecCommandAnalysisFromAuthorizationPlan({
    plan,
    cwd: params.cwd,
    env: params.env,
  });
  return analysis ?? { ok: false, reason: "unable to parse shell command", segments: [] };
}

export function detectPolicyInlineEval(segments: readonly ExecCommandSegment[]) {
  return detectInlineEvalInSegments(segments);
}
