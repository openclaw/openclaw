import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope-config.js";
import { createOpenClawCodingToolsAsync } from "../../agents/agent-tools.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../../agents/bootstrap-files.js";
import { resolveEmbeddedFullAccessState } from "../../agents/embedded-agent-runner/sandbox-info.js";
import { resolveRuntimeSkillsPrompt } from "../../agents/embedded-agent-runner/skills-prompt.js";
import { resolveNodeExecEligibilityAsync } from "../../agents/exec-defaults.js";
import { resolveAgentPromptSurfaceForSessionKey } from "../../agents/prompt-surface.js";
import { resolveAgentRuntimePrompt } from "../../agents/runtime-prompt.js";
import {
  ensureSandboxWorkspaceForSession,
  resolveSandboxRuntimeStatus,
} from "../../agents/sandbox.js";
import { buildConfiguredAgentSystemPrompt } from "../../agents/system-prompt-config.js";
import { normalizeChatType } from "../../channels/chat-type.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { listRegisteredPluginAgentPromptGuidance } from "../../plugins/command-registry-state.js";
import { resolveSessionSkillExecutionWorkspace } from "../../skills/loading/workspace-skill-roots.js";
import { getRemoteSkillEligibility } from "../../skills/runtime/remote.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../../skills/runtime/session-snapshot.js";
import type { SkillEligibilityContext, SkillSnapshot } from "../../skills/types.js";
import { prepareTtsPreferences } from "../../tts/tts-preferences.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";

const log = createSubsystemLogger("auto-reply/commands-system-prompt");

async function resolveCommandSkillsPrompt(params: {
  agentId: string;
  config: HandleCommandsParams["cfg"];
  eligibility: SkillEligibilityContext;
  sandboxAgentId: string;
  sandboxed: boolean;
  sessionKey: string | undefined;
  workspaceDir: string; // Preserve the caller's sandbox task root.
  executionWorkspaceDir?: string;
  executionWorkspaceFileHost?: "gateway";
  skillsSnapshot?: SkillSnapshot;
}): Promise<string> {
  const { snapshot: skillsSnapshot } = await resolveReusableWorkspaceSkillSnapshot({
    workspaceDir: resolveAgentWorkspaceDir(params.config, params.agentId),
    executionWorkspaceDir: params.executionWorkspaceDir,
    executionWorkspaceFileHost: params.executionWorkspaceFileHost,
    config: params.config,
    agentId: params.agentId,
    resolveEligibility: () => params.eligibility,
    existingSnapshot: params.skillsSnapshot,
    skillFilter: params.skillsSnapshot?.skillFilter,
    skillOverrides: params.skillsSnapshot?.skillOverrides,
    watch: false,
  });
  if (params.sandboxed) {
    // Sandboxed prompt inspection must not fall back to host skill snapshots:
    // those paths can be unreadable inside the container.
    const sandboxWorkspace = await ensureSandboxWorkspaceForSession({
      skillsSnapshot,
      config: params.config,
      agentId: params.sandboxAgentId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
    });
    if (!sandboxWorkspace) {
      return "";
    }
    if (sandboxWorkspace.containerWorkdir) {
      const { prompt } = await resolveRuntimeSkillsPrompt({
        sandbox: {
          enabled: true,
          containerWorkdir: sandboxWorkspace.containerWorkdir,
          skillsEligibility: sandboxWorkspace.skillsEligibility,
          skillsWorkspaceDir: sandboxWorkspace.skillsWorkspaceDir || undefined,
          skillUsagePaths: sandboxWorkspace.skillUsagePaths,
          workspaceAccess: sandboxWorkspace.workspaceAccess,
        },
        skillsAnchorWorkspace: sandboxWorkspace.workspaceDir,
        skillsSnapshot,
        config: params.config,
        agentId: params.agentId,
      });
      return prompt;
    }
    // Existing third-party backends may not expose the optional workdir
    // resolver yet. Preserve their previous host-snapshot inspection path.
  }

  return skillsSnapshot.prompt;
}

export async function resolveCommandsSystemPromptBundle(params: HandleCommandsParams) {
  const workspaceDir = params.workspaceDir;
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  const sessionAgentId = params.agentId;
  const { bootstrapFiles, contextFiles: injectedFiles } = await resolveBootstrapContextForRun({
    workspaceDir,
    config: params.cfg,
    sessionKey: params.sessionKey,
    sessionId: targetSessionEntry?.sessionId,
    chatType: targetSessionEntry?.chatType,
    agentId: sessionAgentId,
    warn: makeBootstrapWarn({
      sessionLabel: params.sessionKey,
      workspaceDir,
      warn: (message) => log.warn(message),
    }),
  });
  const toolPolicySessionKey = resolveRuntimePolicySessionKey({
    agentId: sessionAgentId,
    cfg: params.cfg,
    ctx: params.ctx,
    sessionKey: params.sessionKey,
  });
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
    classificationSessionKey: toolPolicySessionKey,
  });
  const nodeSkills = await resolveNodeExecEligibilityAsync({
    agentId: sessionAgentId,
    cfg: params.cfg,
    sessionEntry: targetSessionEntry,
    sessionKey: params.sessionKey,
  });
  const skillsPrompt = await resolveCommandSkillsPrompt({
    agentId: sessionAgentId,
    config: params.cfg,
    eligibility: {
      nodeSkills,
      remote: getRemoteSkillEligibility({ advertiseExecNode: nodeSkills.canExec }),
    },
    sandboxAgentId: sandboxRuntime.classificationAgentId,
    sandboxed: sandboxRuntime.sandboxed,
    sessionKey: toolPolicySessionKey,
    workspaceDir,
    ...resolveSessionSkillExecutionWorkspace(
      targetSessionEntry?.worktree?.canonicalWorkspaceDir,
      workspaceDir,
    ),
    skillsSnapshot: targetSessionEntry?.skillsSnapshot,
  });
  const tools = await createOpenClawCodingToolsAsync({
    config: params.cfg,
    agentId: sessionAgentId,
    workspaceDir,
    sessionKey: toolPolicySessionKey,
    allowGatewaySubagentBinding: true,
    messageProvider: params.command.channel,
    groupId: targetSessionEntry?.groupId ?? undefined,
    groupChannel: targetSessionEntry?.groupChannel ?? undefined,
    groupSpace: targetSessionEntry?.space ?? undefined,
    spawnedBy: targetSessionEntry?.spawnedBy ?? undefined,
    senderId: params.command.senderId,
    senderName: params.ctx.SenderName,
    senderUsername: params.ctx.SenderUsername,
    senderE164: params.ctx.SenderE164,
    modelProvider: params.provider,
    modelId: params.model,
  });
  const toolNames = tools.map((t) => t.name);
  const promptSurface = resolveAgentPromptSurfaceForSessionKey(params.sessionKey);
  const accountId = params.command.accountId ?? params.ctx.AccountId;
  const { runtimeInfo, reactionGuidance, messageToolHints } = await resolveAgentRuntimePrompt({
    config: params.cfg,
    agentId: sessionAgentId,
    workspaceDir,
    cwd: process.cwd(),
    sessionKey: params.sessionKey,
    sessionId: targetSessionEntry?.sessionId,
    model: `${params.provider}/${params.model}`,
    channel: params.command.channel,
    accountId,
    chatType: normalizeChatType(params.ctx.ChatType ?? targetSessionEntry?.chatType),
  });
  const fullAccessState = resolveEmbeddedFullAccessState({
    execElevated: {
      enabled: params.elevated.enabled,
      allowed: params.elevated.allowed,
      defaultLevel: params.resolvedElevatedLevel ?? "off",
    },
  });
  const sandboxInfo = sandboxRuntime.sandboxed
    ? {
        enabled: true,
        workspaceDir,
        workspaceAccess: "rw" as const,
        elevated: {
          allowed: params.elevated.allowed,
          defaultLevel: params.resolvedElevatedLevel ?? "off",
          fullAccessAvailable: fullAccessState.available,
          ...(fullAccessState.blockedReason
            ? { fullAccessBlockedReason: fullAccessState.blockedReason }
            : {}),
        },
      }
    : { enabled: false };
  const { getPreparedModelCatalogOwnerSnapshot } =
    await import("../../agents/prepared-model-catalog.js");
  const preparedModelRuntime = getPreparedModelCatalogOwnerSnapshot({
    config: params.cfg,
    agentId: sessionAgentId,
    workspaceDir,
  });
  const systemPrompt = buildConfiguredAgentSystemPrompt({
    preparedTtsPreferences: params.opts?.preparedTtsPreferences ?? (await prepareTtsPreferences()),
    config: params.cfg,
    preparedModelRuntime,
    agentId: sessionAgentId,
    workspaceDir,
    reasoningLevel: params.resolvedReasoningLevel,
    extraSystemPrompt: undefined,
    ownerNumbers: undefined,
    reasoningTagHint: false,
    toolNames,
    contextFiles: injectedFiles,
    skillsPrompt,
    acpEnabled: isAcpRuntimeSpawnAvailable({
      config: params.cfg,
      sandboxed: sandboxRuntime.sandboxed,
    }),
    promptSurface,
    nativeCommandGuidanceLines: listRegisteredPluginAgentPromptGuidance({
      surface: promptSurface,
    }),
    reactionGuidance,
    messageToolHints,
    runtimeInfo,
    sandboxInfo,
  });

  return { systemPrompt, tools, skillsPrompt, bootstrapFiles, injectedFiles, sandboxRuntime };
}
