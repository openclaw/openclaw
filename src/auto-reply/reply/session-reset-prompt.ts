import { resolveBootstrapMode, type BootstrapMode } from "../../agents/bootstrap-mode.js";
import {
  buildFullBootstrapPromptLines,
  buildLimitedBootstrapPromptLines,
} from "../../agents/bootstrap-prompt.js";
import { appendCronStyleCurrentTimeLine } from "../../agents/current-time.js";
import { resolveEffectiveToolInventory } from "../../agents/tools-effective-inventory.js";
import { isWorkspaceBootstrapPending } from "../../agents/workspace.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

const BARE_SESSION_RESET_PROMPT_BASE =
  'A new session was started via /new or /reset. Execute your Session Startup sequence now - read the required files before responding to the user. If BOOTSTRAP.md exists in the provided Project Context, read it and follow its instructions first. Do not use a generic assistant greeting, onboarding line, or cold opener. Re-enter the room like the configured persona already belongs there. Use the current channel, chat type, group subject, relationship, and provided project context to choose the tone: casual groups can use a short social re-entry line, direct chats can be warm and normal, professional rooms should stay composed, and sensitive rooms should stay gentle. Keep it to 1-3 short sentences. If there is no user task attached, invite the next message in a natural human way instead of asking a scripted "what can I help with" question. Do not mention current or default model identity unless the user asked. Do not mention internal steps, files, tools, or reasoning.';

const BARE_SESSION_RESET_PROMPT_BOOTSTRAP_PENDING = [
  "A new session was started via /new or /reset while bootstrap is still pending for this workspace.",
  ...buildFullBootstrapPromptLines({
    readLine:
      "Please read BOOTSTRAP.md from the workspace now and follow it before replying normally.",
    firstReplyLine:
      "Your first user-visible reply must follow BOOTSTRAP.md, not a generic greeting.",
  }),
  "Do not mention current or default model identity unless the user asked.",
  "Do not mention internal steps, files, tools, or reasoning.",
].join(" ");

const BARE_SESSION_RESET_PROMPT_BOOTSTRAP_LIMITED = [
  "A new session was started via /new or /reset while bootstrap is still pending for this workspace, but this run cannot safely complete the full BOOTSTRAP.md workflow here.",
  ...buildLimitedBootstrapPromptLines({
    introLine:
      "Bootstrap is still pending for this workspace, but this run cannot safely complete the full BOOTSTRAP.md workflow here.",
    nextStepLine:
      "Typical next steps include switching to a primary interactive run with normal workspace access or having the user complete the canonical BOOTSTRAP.md deletion afterward.",
  }).slice(1),
  "Do not mention current or default model identity unless the user asked.",
  "Do not mention internal steps, files, tools, or reasoning.",
].join(" ");

export function resolveBareResetBootstrapFileAccess(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  workspaceDir?: string;
  modelProvider?: string;
  modelId?: string;
}): boolean {
  if (!params.cfg) {
    return false;
  }
  const inventory = resolveEffectiveToolInventory({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  return inventory.groups.some((group) => group.tools.some((tool) => tool.id === "read"));
}

export async function resolveBareSessionResetPromptState(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  nowMs?: number;
  isPrimaryRun?: boolean;
  isCanonicalWorkspace?: boolean;
  hasBootstrapFileAccess?: boolean | (() => boolean);
}): Promise<{
  bootstrapMode: BootstrapMode;
  prompt: string;
  shouldPrependStartupContext: boolean;
}> {
  const bootstrapPending = params.workspaceDir
    ? await isWorkspaceBootstrapPending(params.workspaceDir)
    : false;
  const hasBootstrapFileAccess = bootstrapPending
    ? typeof params.hasBootstrapFileAccess === "function"
      ? params.hasBootstrapFileAccess()
      : (params.hasBootstrapFileAccess ?? true)
    : true;
  const bootstrapMode = resolveBootstrapMode({
    bootstrapPending,
    runKind: "default",
    isInteractiveUserFacing: true,
    isPrimaryRun: params.isPrimaryRun ?? true,
    isCanonicalWorkspace: params.isCanonicalWorkspace ?? true,
    hasBootstrapFileAccess,
  });
  return {
    bootstrapMode,
    prompt: buildBareSessionResetPrompt(params.cfg, params.nowMs, bootstrapMode),
    shouldPrependStartupContext: bootstrapMode === "none",
  };
}

/**
 * Build the bare session reset prompt, appending the current date/time so agents
 * know which daily memory files to read during their Session Startup sequence.
 * Without this, agents on /new or /reset guess the date from their training cutoff.
 */
export function buildBareSessionResetPrompt(
  cfg?: OpenClawConfig,
  nowMs?: number,
  bootstrapMode?: BootstrapMode,
): string {
  return appendCronStyleCurrentTimeLine(
    bootstrapMode === "full"
      ? BARE_SESSION_RESET_PROMPT_BOOTSTRAP_PENDING
      : bootstrapMode === "limited"
        ? BARE_SESSION_RESET_PROMPT_BOOTSTRAP_LIMITED
        : BARE_SESSION_RESET_PROMPT_BASE,
    cfg ?? {},
    nowMs ?? Date.now(),
  );
}

/** @deprecated Use buildBareSessionResetPrompt(cfg) instead */
export const BARE_SESSION_RESET_PROMPT = BARE_SESSION_RESET_PROMPT_BASE;
