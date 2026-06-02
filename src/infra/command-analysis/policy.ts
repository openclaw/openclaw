import {
  analyzeArgvCommand,
  analyzeShellCommand,
  type ExecCommandAnalysis,
  type ExecCommandSegment,
} from "../exec-approvals-analysis.js";
import { detectInlineEvalInSegments } from "./risks.js";

export type CommandPolicyAnalysis =
  | {
      ok: true;
      /** Preserves whether policy parsed shell text or already-tokenized argv. */
      source: "argv" | "shell";
      analysis: ExecCommandAnalysis;
      /** Normalized execution segments that downstream policy checks can inspect. */
      segments: ExecCommandSegment[];
    }
  | {
      ok: false;
      /** Mirrors the requested command source even when parsing fails. */
      source: "argv" | "shell";
      reason?: string;
      analysis: ExecCommandAnalysis;
      /** Failed parses intentionally expose no partial policy targets. */
      segments: [];
    };

/**
 * Normalizes shell strings and argv arrays into the same policy-facing
 * segment shape so approval checks do not need source-specific parsing paths.
 */
export function analyzeCommandForPolicy(
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
): CommandPolicyAnalysis {
  const analysis =
    params.source === "shell"
      ? analyzeShellCommand({
          command: params.command,
          cwd: params.cwd,
          env: params.env,
          platform: params.platform,
        })
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

/** Runs the inline-eval detector on already-normalized policy segments. */
export function detectPolicyInlineEval(segments: readonly ExecCommandSegment[]) {
  return detectInlineEvalInSegments(segments);
}
