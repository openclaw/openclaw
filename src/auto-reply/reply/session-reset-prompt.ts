import {
  analyzeBootstrapBudget,
  buildBootstrapInjectionStats,
} from "../../agents/bootstrap-budget.js";
import { resolveBootstrapContextForRun } from "../../agents/bootstrap-files.js";
import { appendCronStyleCurrentTimeLine } from "../../agents/current-time.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
  type EmbeddedContextFile,
} from "../../agents/pi-embedded-helpers.js";
import type { WorkspaceBootstrapFile } from "../../agents/workspace.js";
import type { OpenClawConfig } from "../../config/config.js";
import { hasPromptAffectingBootstrapHooks } from "./bootstrap-prompt-hooks.js";

const BARE_SESSION_RESET_PROMPT_PREFIX =
  "A new session was started via /new or /reset. Run your Session Startup sequence.";
const BARE_SESSION_RESET_PROMPT_SUFFIX =
  "Then greet the user in your configured persona, if one is provided. Be yourself - use your defined voice, mannerisms, and mood. Keep it to 1-3 sentences and ask what they want to do. If the runtime model differs from default_model in the system prompt, mention the default model. Do not mention internal steps, files, tools, or reasoning.";

export type BareSessionResetPromptMode = "generic" | "injected" | "truncated";

const BARE_SESSION_RESET_PROMPT_GUIDANCE: Record<BareSessionResetPromptMode, string> = {
  generic: "Read the required bootstrap/reference files before responding.",
  injected:
    "Use injected workspace bootstrap/reference files already in context instead of rereading them. " +
    "Only read another required bootstrap/reference file if you need one that was not injected into context.",
  truncated:
    "Use injected workspace bootstrap/reference files already in context first. " +
    "If a required bootstrap/reference file was truncated or omitted from the injected context, reread just that file before responding.",
};

function buildBareSessionResetPromptText(mode: BareSessionResetPromptMode): string {
  return [
    BARE_SESSION_RESET_PROMPT_PREFIX,
    BARE_SESSION_RESET_PROMPT_GUIDANCE[mode],
    BARE_SESSION_RESET_PROMPT_SUFFIX,
  ].join(" ");
}

export function resolveBareSessionResetPromptMode(params: {
  cfg?: OpenClawConfig;
  bootstrapFiles: WorkspaceBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
}): BareSessionResetPromptMode {
  const analysis = analyzeBootstrapBudget({
    files: buildBootstrapInjectionStats({
      bootstrapFiles: params.bootstrapFiles,
      injectedFiles: params.injectedFiles,
    }),
    bootstrapMaxChars: resolveBootstrapMaxChars(params.cfg),
    bootstrapTotalMaxChars: resolveBootstrapTotalMaxChars(params.cfg),
  });
  const hasUsableInjectedContent = analysis.files.some(
    (file) => !file.missing && file.injectedChars > 0,
  );
  if (!hasUsableInjectedContent) {
    return "generic";
  }
  return analysis.hasTruncation ? "truncated" : "injected";
}

/**
 * Build the bare session reset prompt, appending the current date/time so agents
 * know which daily memory files to read during their Session Startup sequence.
 * Without this, agents on /new or /reset guess the date from their training cutoff.
 */
export function buildBareSessionResetPrompt(cfg?: OpenClawConfig, nowMs?: number): string {
  return appendCronStyleCurrentTimeLine(
    buildBareSessionResetPromptText("generic"),
    cfg ?? {},
    nowMs ?? Date.now(),
  );
}

export async function buildBareSessionResetPromptForRun(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  nowMs?: number;
}): Promise<string> {
  try {
    if (hasPromptAffectingBootstrapHooks({ workspaceDir: params.workspaceDir, cfg: params.cfg })) {
      return buildBareSessionResetPrompt(params.cfg, params.nowMs);
    }

    const { bootstrapFiles, contextFiles } = await resolveBootstrapContextForRun({
      workspaceDir: params.workspaceDir,
      config: params.cfg,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      agentId: params.agentId,
    });
    const mode = resolveBareSessionResetPromptMode({
      cfg: params.cfg,
      bootstrapFiles,
      injectedFiles: contextFiles,
    });
    return appendCronStyleCurrentTimeLine(
      buildBareSessionResetPromptText(mode),
      params.cfg ?? {},
      params.nowMs ?? Date.now(),
    );
  } catch {
    return buildBareSessionResetPrompt(params.cfg, params.nowMs);
  }
}

/** @deprecated Use buildBareSessionResetPrompt(cfg) instead */
export const BARE_SESSION_RESET_PROMPT = buildBareSessionResetPromptText("generic");
