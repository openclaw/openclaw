import os from "node:os";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { resolveBootstrapContextForRun } from "../agents/bootstrap-files.js";
import {
  listChannelSupportedActions,
  resolveChannelMessageToolHints,
} from "../agents/channel-tools.js";
import { resolveOpenClawDocsPath } from "../agents/docs-path.js";
import { buildModelAliasLines } from "../agents/model-alias-lines.js";
import { resolveDefaultModelForAgent, resolveThinkingDefault } from "../agents/model-selection.js";
import { resolveOwnerDisplaySetting } from "../agents/owner-display.js";
import { buildEmbeddedSystemPrompt } from "../agents/pi-embedded-runner/system-prompt.js";
import { createOpenClawCodingTools } from "../agents/pi-tools.js";
import { detectRuntimeShell } from "../agents/shell-utils.js";
import {
  resolveSkillsPromptForRun,
  loadWorkspaceSkillEntries,
} from "../agents/skills/workspace.js";
import { buildSystemPromptParams } from "../agents/system-prompt-params.js";
import { resolveHeartbeatPrompt } from "../auto-reply/heartbeat.js";
import { resolveChannelCapabilities } from "../config/channel-capabilities.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { resolveSignalReactionLevel } from "../signal/reaction-level.js";
import { resolveTelegramInlineButtonsScope } from "../telegram/inline-buttons.js";
import { resolveTelegramReactionLevel } from "../telegram/reaction-level.js";
import { buildTtsSystemPromptHint } from "../tts/tts.js";
import { isReasoningTagProvider } from "../utils/provider-utils.js";
import { requireValidConfig } from "./agents.command-shared.js";

export async function agentsViewSystemPromptCommand(
  opts: { agentId?: string; model?: string; channel?: string },
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const agentId = normalizeAgentId(opts.agentId ?? resolveDefaultAgentId(cfg));
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const agentDir = resolveAgentDir(cfg, agentId);
  const _agentConfig = resolveAgentConfig(cfg, agentId);

  const tools = createOpenClawCodingTools({
    agentId,
    agentDir,
    workspaceDir,
    config: cfg,
  });

  const { contextFiles, bootstrapFiles } = await resolveBootstrapContextForRun({
    workspaceDir,
    config: cfg,
    agentId,
    warn: (msg) => runtime.error(msg),
  });

  const skillsPrompt = resolveSkillsPromptForRun({
    entries: loadWorkspaceSkillEntries(workspaceDir, { config: cfg }),
    config: cfg,
    workspaceDir,
  });

  const machineName = await getMachineDisplayName();
  const defaultModelRef = resolveDefaultModelForAgent({ cfg, agentId });
  const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
  const modelLabel = opts.model ?? defaultModelLabel;
  const provider = modelLabel.split("/")[0];

  let runtimeCapabilities = opts.channel
    ? (resolveChannelCapabilities({ cfg, channel: opts.channel }) ?? [])
    : undefined;
  if (opts.channel === "telegram") {
    const inlineButtonsScope = resolveTelegramInlineButtonsScope({ cfg });
    if (inlineButtonsScope !== "off") {
      if (!runtimeCapabilities) {
        runtimeCapabilities = [];
      }
      if (
        !runtimeCapabilities.some((cap) => String(cap).trim().toLowerCase() === "inlinebuttons")
      ) {
        runtimeCapabilities.push("inlineButtons");
      }
    }
  }
  const channelActions = opts.channel
    ? listChannelSupportedActions({ cfg, channel: opts.channel })
    : undefined;
  const messageToolHints = opts.channel
    ? resolveChannelMessageToolHints({ cfg, channel: opts.channel })
    : undefined;

  const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
    config: cfg,
    agentId,
    workspaceDir,
    cwd: process.cwd(),
    runtime: {
      host: machineName,
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      node: process.version,
      model: modelLabel,
      defaultModel: defaultModelLabel,
      shell: detectRuntimeShell(),
      channel: opts.channel,
      capabilities: runtimeCapabilities,
      channelActions,
    },
  });

  const docsPath = await resolveOpenClawDocsPath({
    workspaceDir,
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url,
  });

  const ownerDisplay = resolveOwnerDisplaySetting(cfg);
  const ttsHint = buildTtsSystemPromptHint(cfg);

  const bootstrapFileNames = bootstrapFiles.map((f) => f.name);
  const workspaceNotes =
    bootstrapFileNames.length > 0
      ? [`Loaded context files: ${bootstrapFileNames.join(", ")}`]
      : undefined;

  const reactionGuidance =
    opts.channel === "telegram"
      ? (() => {
          const resolved = resolveTelegramReactionLevel({ cfg });
          return resolved.agentReactionGuidance
            ? { level: resolved.agentReactionGuidance, channel: "Telegram" }
            : undefined;
        })()
      : opts.channel === "signal"
        ? (() => {
            const resolved = resolveSignalReactionLevel({ cfg });
            return resolved.agentReactionGuidance
              ? { level: resolved.agentReactionGuidance, channel: "Signal" }
              : undefined;
          })()
        : undefined;

  const isDefaultAgent = agentId === normalizeAgentId(resolveDefaultAgentId(cfg));
  const heartbeatPrompt = isDefaultAgent
    ? resolveHeartbeatPrompt(cfg.agents?.defaults?.heartbeat?.prompt)
    : undefined;

  const defaultThinkLevel = resolveThinkingDefault({
    cfg,
    provider,
    model: modelLabel.split("/").slice(1).join("/"),
  });

  const prompt = buildEmbeddedSystemPrompt({
    workspaceDir,
    defaultThinkLevel,
    reasoningTagHint: isReasoningTagProvider(provider),
    heartbeatPrompt,
    skillsPrompt,
    docsPath: docsPath ?? undefined,
    ttsHint,
    workspaceNotes,
    promptMode: "full",
    acpEnabled: cfg.acp?.enabled !== false,
    runtimeInfo,
    tools,
    modelAliasLines: buildModelAliasLines(cfg),
    userTimezone,
    userTime,
    userTimeFormat,
    contextFiles,
    messageToolHints,
    reactionGuidance,
    memoryCitationsMode: cfg.memory?.citations,
    ownerDisplay: ownerDisplay.ownerDisplay,
    ownerDisplaySecret: ownerDisplay.ownerDisplaySecret,
  });

  // Print token estimate and the prompt
  const estimatedTokens = Math.round(prompt.length / 4);
  runtime.error(
    `[agents view-system-prompt] agent=${agentId} chars=${prompt.length} tokens≈${estimatedTokens} context_files=${contextFiles.length} tools=${tools.length}`,
  );
  runtime.log(prompt);
}
