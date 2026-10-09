// Handles /learn by turning the command into a Skill Workshop authoring turn.
import { resolveCliBackendConfig } from "../../agents/cli-backends.js";
import { detectNodeClaudePlacement } from "../../agents/cli-runner/prepare-claude.js";
import { resolveConversationCapabilityProfile } from "../../agents/conversation-capability-profile.js";
import { selectAgentHarness } from "../../agents/harness/selection.js";
import { agentHarnessExposesOpenClawTools } from "../../agents/harness/tool-surface.js";
import {
  isCliRuntimeAliasForProvider,
  resolveCliRuntimeExecutionProvider,
} from "../../agents/model-runtime-aliases.js";
import { supportsModelTools } from "../../agents/model-tool-support.js";
import { resolveSandboxRuntimeStatus } from "../../agents/sandbox.js";
import { isToolAllowedByPolicyName } from "../../agents/tool-policy-match.js";
import { resolveConfiguredModelCompat } from "../../agents/tools-effective-inventory.js";
import { buildLearnPrompt, DEFAULT_LEARN_REQUEST } from "../../skills/workshop/learn-prompt.js";
import { resolveSkillWorkshopToolPolicyAvailability } from "../../skills/workshop/tool-policy-diagnostic.js";
import { applyCommandTextToParams } from "./command-context-rewrite.js";
import { commandReply, defineAuthorizedTextCommand } from "./command-gates.js";
import { matchSlashCommandToken } from "./commands-slash-parse.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";
import { resolveRuntimePolicySessionKey } from "./runtime-policy-session-key.js";

const LEARN_COMMAND_PREFIX = "/learn";
const SKILL_WORKSHOP_TOOL_NAME = "skill_workshop";
const SKILL_WORKSHOP_UNAVAILABLE_REPLY =
  "Skill workshop is not available on this agent. Use a non-sandboxed agent where the skill_workshop tool is available, or use the openclaw skills workshop CLI.";

function parseLearnRequest(raw: string): string | null {
  const request = matchSlashCommandToken(raw, LEARN_COMMAND_PREFIX);
  return request === null ? null : request || DEFAULT_LEARN_REQUEST;
}

/** /learn needs a harness that exposes OpenClaw tools and a policy that allows skill_workshop. */
function isWorkshopAvailable(params: HandleCommandsParams): boolean {
  if (
    params.opts?.disableTools ||
    params.opts?.toolsAllow?.length === 0 ||
    (params.opts?.toolsAllow !== undefined &&
      !isToolAllowedByPolicyName(SKILL_WORKSHOP_TOOL_NAME, { allow: params.opts.toolsAllow }))
  ) {
    return false;
  }

  const policySessionKey = resolveRuntimePolicySessionKey({
    agentId: params.agentId,
    cfg: params.cfg,
    ctx: params.ctx,
    sessionKey: params.sessionKey,
  });
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    classificationSessionKey: policySessionKey,
  });
  // Workshop skills live on the host under the agent dir, outside a sandboxed workspace.
  if (sandboxRuntime.sandboxed) {
    return false;
  }

  try {
    const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
    const runtimeOverride = targetSessionEntry?.agentRuntimeOverride;
    const cliProvider = isCliRuntimeAliasForProvider({
      provider: params.provider,
      runtime: runtimeOverride,
      cfg: params.cfg,
    })
      ? runtimeOverride
      : resolveCliRuntimeExecutionProvider({
          provider: params.provider,
          cfg: params.cfg,
          agentId: params.agentId,
          modelId: params.model,
          authProfileId: targetSessionEntry?.authProfileOverride,
        });
    if (cliProvider) {
      const cliBackend = resolveCliBackendConfig(cliProvider, params.cfg, {
        agentId: params.agentId,
      });
      if (!cliBackend?.bundleMcp) {
        return false;
      }
      if (
        detectNodeClaudePlacement({
          backendId: cliBackend.id,
          execHost: targetSessionEntry?.execHost,
          execNode: targetSessionEntry?.execNode,
        })
      ) {
        return false;
      }
    } else {
      const harness = selectAgentHarness({
        provider: params.provider,
        modelId: params.model,
        config: params.cfg,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      });
      if (!agentHarnessExposesOpenClawTools(harness.id)) {
        return false;
      }
    }
    const modelCompat = resolveConfiguredModelCompat({
      cfg: params.cfg,
      modelProvider: params.provider,
      modelId: params.model,
    });
    if (modelCompat && !supportsModelTools({ compat: modelCompat })) {
      return false;
    }
    const capabilityProfile = resolveConversationCapabilityProfile({
      config: params.cfg,
      agentId: sandboxRuntime.classificationAgentId,
      sessionKey: sandboxRuntime.classificationSessionKey,
      runSessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      runtimeToolAllowlist: params.opts?.toolsAllow,
      messageProvider: params.command.channel,
      senderId: params.command.senderId,
      senderName: params.ctx.SenderName,
      senderUsername: params.ctx.SenderUsername,
      senderE164: params.ctx.SenderE164,
      senderIsOwner: params.command.senderIsOwner,
      agentAccountId: params.command.accountId ?? params.ctx.AccountId,
      modelProvider: params.provider,
      modelId: params.model,
      groupId: params.sessionEntry?.groupId,
      groupChannel: params.sessionEntry?.groupChannel ?? params.ctx.GroupChannel,
      groupSpace: params.sessionEntry?.space ?? params.ctx.GroupSpace,
    });
    return resolveSkillWorkshopToolPolicyAvailability({
      config: params.cfg,
      conversationCapabilityProfile: capabilityProfile,
    }).available;
  } catch {
    return false;
  }
}

/** Command handler for /learn: a foreground turn that writes Workshop skills directly. */
export const handleLearnCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: LEARN_COMMAND_PREFIX, match: parseLearnRequest },
  (params, request) => {
    if (!isWorkshopAvailable(params)) {
      return commandReply(SKILL_WORKSHOP_UNAVAILABLE_REPLY);
    }

    applyCommandTextToParams(params, buildLearnPrompt(request));
    return { shouldContinue: true };
  },
);
