import type { AgentTool } from "@mariozechner/pi-agent-core";
import { resolveSessionAgentIds } from "../../agents/agent-scope.js";
import { resolveBootstrapContextForRun } from "../../agents/bootstrap-files.js";
import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import type { EmbeddedContextFile } from "../../agents/pi-embedded-helpers.js";
import { createOpenClawCodingTools } from "../../agents/pi-tools.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import { buildWorkspaceSkillSnapshot } from "../../agents/skills.js";
import { getSkillsSnapshotVersion } from "../../agents/skills/refresh.js";
import { buildSystemPromptParams } from "../../agents/system-prompt-params.js";
import { buildAgentSystemPrompt } from "../../agents/system-prompt.js";
import { buildToolSummaryMap } from "../../agents/tool-summaries.js";
import type { WorkspaceBootstrapFile } from "../../agents/workspace.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { buildTtsSystemPromptHint } from "../../tts/tts.js";
import type { HandleCommandsParams } from "./commands-types.js";

export type CommandsSystemPromptBundle = {
  systemPrompt: string;
  tools: AgentTool[];
  skillsPrompt: string;
  bootstrapFiles: WorkspaceBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
  sandboxRuntime: ReturnType<typeof resolveSandboxRuntimeStatus>;
};

export async function resolveCommandsSystemPromptBundle(
  params: HandleCommandsParams,
): Promise<CommandsSystemPromptBundle> {
  const workspaceDir = params.workspaceDir;
  const { bootstrapFiles, contextFiles: injectedFiles } = await resolveBootstrapContextForRun({
    workspaceDir,
    config: params.cfg,
    sessionKey: params.sessionKey,
    sessionId: params.sessionEntry?.sessionId,
  });
  const skillsSnapshot = (() => {
    try {
      return buildWorkspaceSkillSnapshot(workspaceDir, {
        config: params.cfg,
        eligibility: { remote: getRemoteSkillEligibility() },
        snapshotVersion: getSkillsSnapshotVersion(workspaceDir),
      });
    } catch {
      return { prompt: "", skills: [], resolvedSkills: [] };
    }
  })();
  const skillsPrompt = skillsSnapshot.prompt ?? "";
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.ctx.SessionKey ?? params.sessionKey,
  });
  const tools = (() => {
    try {
      return createOpenClawCodingTools({
        config: params.cfg,
        agentId: params.agentId,
        workspaceDir,
        sessionKey: params.sessionKey,
        messageProvider: params.command.channel,
        groupId: params.sessionEntry?.groupId ?? undefined,
        groupChannel: params.sessionEntry?.groupChannel ?? undefined,
        groupSpace: params.sessionEntry?.space ?? undefined,
        spawnedBy: params.sessionEntry?.spawnedBy ?? undefined,
        senderIsOwner: params.command.senderIsOwner,
        modelProvider: params.provider,
        modelId: params.model,
      });
    } catch {
      return [];
    }
  })();
  const toolSummaries = buildToolSummaryMap(tools);
  const toolNames = tools.map((t) => t.name);
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.cfg,
    agentId: params.agentId,
  });
  const defaultModelRef = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: sessionAgentId,
  });
  const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
  const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
    config: params.cfg,
    agentId: sessionAgentId,
    workspaceDir,
    cwd: process.cwd(),
    runtime: {
      host: "unknown",
      os: "unknown",
      arch: "unknown",
      node: process.version,
      model: `${params.provider}/${params.model}`,
      defaultModel: defaultModelLabel,
    },
  });
  const sandboxInfo = sandboxRuntime.sandboxed
    ? {
        enabled: true,
        workspaceDir,
        workspaceAccess: "rw" as const,
        elevated: {
          allowed: params.elevated.allowed,
          defaultLevel: (params.resolvedElevatedLevel ?? "off") as "on" | "off" | "ask" | "full",
        },
      }
    : { enabled: false };
  const ttsHint = params.cfg ? buildTtsSystemPromptHint(params.cfg) : undefined;

  const systemPrompt = buildAgentSystemPrompt({
    workspaceDir,
    defaultThinkLevel: params.resolvedThinkLevel,
    reasoningLevel: params.resolvedReasoningLevel,
    extraSystemPrompt: undefined,
    ownerNumbers: undefined,
    reasoningTagHint: false,
    toolNames,
    toolSummaries,
    modelAliasLines: [],
    userTimezone,
    userTime,
    userTimeFormat,
    contextFiles: injectedFiles,
    skillsPrompt,
    heartbeatPrompt: undefined,
    ttsHint,
    acpEnabled: params.cfg?.acp?.enabled !== false,
    runtimeInfo,
    sandboxInfo,
    memoryCitationsMode: params.cfg?.memory?.citations,
  });

  return { systemPrompt, tools, skillsPrompt, bootstrapFiles, injectedFiles, sandboxRuntime };
}
