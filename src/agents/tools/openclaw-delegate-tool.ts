/** Regular-agent client for the OpenClaw system agent. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Type, type Static } from "typebox";
import {
  createRuntimeConfigReader,
  selectLiveRuntimeConfig,
} from "../../config/runtime-snapshot.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { runOutsidePluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { appendConfigPathSegment } from "../../shared/dot-path.js";
import { SYSTEM_AGENT_ID } from "../../system-agent/agent-id.js";
import { DelegatedChangeApprovalRequiredError } from "../../system-agent/delegated-change-policy.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { resolveAgentConfig } from "../agent-scope.js";
import type { ResolvedExecDefaults } from "../exec-defaults.js";
import { resolveExecDefaultsLegacy } from "../exec-defaults.legacy.js";
import { withPreparedExecDefaults } from "../exec-defaults.preparation.js";
import { hasUnrestrictedGatewayExecution } from "../execution-authority.js";
import type { OpenClawToolsOptions } from "../openclaw-tools.types.js";
import { runOutsidePreparedModelRuntimePluginGenerationScope } from "../prepared-model-runtime-generation-scope.js";
import type { PreparedToolConstruction } from "../tool-construction-preparation.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../tool-fs-policy.js";
import { jsonResult, readToolStringParam, type AnyAgentTool } from "./common.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callInProcessGatewayTool } from "./in-process-gateway.js";

const OpenClawDelegateSchema = Type.Object({
  message: Type.String({ description: "What system must do." }),
  sessionId: Type.Optional(Type.String({ description: "Continue prior OpenClaw talk." })),
});

const OpenClawDelegateOutputSchema = Type.Object(
  {
    reply: Type.String(),
    action: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

type OpenClawDelegateResult = Static<typeof OpenClawDelegateOutputSchema>;

function stableDelegationSessionId(sessionKey: string | undefined, agentId: string): string {
  return sessionKey?.trim()
    ? `delegate-${sha256Hex(`${agentId}\0${sessionKey.trim()}`).slice(0, 32)}`
    : `delegate-${randomUUID()}`;
}

type DelegateToolOptions = Pick<
  OpenClawToolsOptions,
  | "sandboxed"
  | "runSessionKey"
  | "agentSessionKey"
  | "agentChannel"
  | "currentMessagingTarget"
  | "currentChannelId"
  | "agentTo"
  | "agentAccountId"
  | "currentThreadTs"
  | "agentThreadId"
  | "config"
  | "execSession"
  | "execOverrides"
  | "fsPolicy"
  | "sessionPermissionPolicy"
  | "delegationExecAuthority"
  | "assertInvocationCurrent"
  | "abortSignal"
> & { sessionAgentId: string };

function execDefaultsParams(options: DelegateToolOptions) {
  return {
    cfg: options.config,
    agentId: options.sessionAgentId,
    sessionKey: options.agentSessionKey ?? options.runSessionKey,
    sessionEntry: options.execSession,
    execOverrides: options.execOverrides,
  };
}

/** Consume the policy inside its captured store and classification lifetime. */
export async function createOpenClawDelegateToolsForRunAsync(
  options: DelegateToolOptions,
  preparation: PreparedToolConstruction,
): Promise<AnyAgentTool[]> {
  preparation.assertCurrent();
  if (options.sandboxed || options.sessionAgentId === SYSTEM_AGENT_ID) {
    return [];
  }
  return withPreparedExecDefaults(
    execDefaultsParams(options),
    preparation,
    async (defaults, prepareCurrentRead) => {
      let readCurrent: () => ResolvedExecDefaults;
      try {
        readCurrent = await prepareCurrentRead();
      } catch {
        // Optional automatic authority must not disable exact human approval.
        readCurrent = () => {
          throw new Error("Current execution authority is unavailable; approval is required");
        };
      }
      preparation.assertCurrent();
      return createOpenClawDelegateToolsForRun(options, defaults, readCurrent);
    },
  );
}

/** Synchronous construction is retained for the deprecated harness SDK factory. */
export function createOpenClawDelegateToolsForRun(
  options: DelegateToolOptions,
  preparedExecDefaults?: ResolvedExecDefaults,
  readExecDefaults?: () => ResolvedExecDefaults,
): AnyAgentTool[] {
  if (options.sandboxed || options.sessionAgentId === SYSTEM_AGENT_ID) {
    return [];
  }
  const sessionKey = options.runSessionKey ?? options.agentSessionKey;
  const defaultSessionId = stableDelegationSessionId(sessionKey, options.sessionAgentId);
  const execPolicy = preparedExecDefaults ?? resolveExecDefaultsLegacy(execDefaultsParams(options));
  const readConfig = options.config
    ? createRuntimeConfigReader(options.config)
    : () => selectLiveRuntimeConfig();
  const capturedConfig = readConfig();
  const assertAutoApproveChangesCurrent = () => {
    options.abortSignal?.throwIfAborted();
    options.assertInvocationCurrent?.();
    const config = readConfig();
    const agent = config && resolveAgentConfig(config, options.sessionAgentId);
    const capturedAgent =
      capturedConfig && resolveAgentConfig(capturedConfig, options.sessionAgentId);
    const permissionMode =
      options.sessionPermissionPolicy?.mode ?? options.execSession?.permissionMode;
    const agentPath = appendConfigPathSegment("agents.entries", options.sessionAgentId);
    let restriction: string | undefined;
    if (permissionMode !== undefined && permissionMode !== "full") {
      restriction = `This run uses permission mode ${JSON.stringify(permissionMode)}. Review the originating session or its parent in operator settings.`;
    } else if (
      permissionMode !== "full" &&
      resolveEffectiveToolFsWorkspaceOnly({ cfg: config, agentId: options.sessionAgentId })
    ) {
      const source =
        agent?.tools?.fs?.workspaceOnly !== undefined
          ? `${agentPath}.tools.fs.workspaceOnly`
          : "tools.fs.workspaceOnly";
      restriction = `${source} limits this run to workspace files. Review that setting through operator configuration.`;
    } else if (options.fsPolicy?.workspaceOnly === true) {
      restriction =
        "This run is limited to workspace files. The original source of this restriction is not established here; review the originating session or parent run.";
    } else if (
      !isDeepStrictEqual(
        config?.agents?.defaults?.sandbox,
        capturedConfig?.agents?.defaults?.sandbox,
      )
    ) {
      restriction =
        "agents.defaults.sandbox changed after this run was admitted. Review the current sandbox policy through operator configuration.";
    } else if (!isDeepStrictEqual(agent?.sandbox, capturedAgent?.sandbox)) {
      restriction = `${agentPath}.sandbox changed after this run was admitted. Review the current sandbox policy through operator configuration.`;
    }
    if (restriction) {
      throw new DelegatedChangeApprovalRequiredError(
        `Automatic OpenClaw changes are unavailable. ${restriction} Setting tools.openclaw.autoApproveChanges to true cannot override containment or inherited limits. Request exact approval for an otherwise permitted change. After an operator changes the source restrictions, start a new run. See https://docs.openclaw.ai/gateway/permission-modes#delegated-setup-and-repair.`,
      );
    }
    const setting =
      agent?.tools?.openclaw?.autoApproveChanges ?? config?.tools?.openclaw?.autoApproveChanges;
    if (setting === false) {
      throw new DelegatedChangeApprovalRequiredError(
        "OpenClaw changes require human approval because the effective autoApproveChanges policy is false, including in Full Access. Allow once authorizes this change only. Change tools.openclaw.autoApproveChanges or this agent's override through operator settings to authorize future delegated changes.",
      );
    }
    if (setting === true) {
      return;
    }
    // Explicit admin-authorized Full Access is an independent delegation grant.
    // Per-turn tightening still retires that grant; exec settings alone are not one.
    if (permissionMode === "full" && execPolicy.security === "full" && execPolicy.ask === "off") {
      return;
    }
    // Exec retains this admitted turn's configured surface and model ceilings.
    // Recheck its live host floors without retiring a write on its own config publication.
    if (
      !hasUnrestrictedGatewayExecution({
        execAuthority: options.delegationExecAuthority?.(),
        execPolicy: readExecDefaults?.() ?? resolveExecDefaultsLegacy(execDefaultsParams(options)),
        workspaceOnly: options.fsPolicy?.workspaceOnly,
        sandboxed: options.sandboxed,
      })
    ) {
      throw new DelegatedChangeApprovalRequiredError(
        "Automatic OpenClaw changes require current unrestricted Gateway execution or an explicit delegation grant. This Default run's effective authority is restricted or has not been established. Allow once authorizes this change only. For automatic delegated changes, choose OpenClaw Full Access or set tools.openclaw.autoApproveChanges (or this agent's override) to true through operator settings.",
      );
    }
  };
  const turnSourceTo =
    options.currentMessagingTarget ?? options.currentChannelId ?? options.agentTo;
  const turnSourceThreadId = options.currentThreadTs ?? options.agentThreadId;
  // Only messaging channels receive approval prompts; Webchat and terminal runs
  // decide in the Control UI or the OpenClaw apps.
  const approvalLocation = isDeliverableMessageChannel(
    normalizeMessageChannel(options.agentChannel) ?? "",
  )
    ? "in this chat (approval buttons or `/approve`)"
    : "in the Control UI or OpenClaw apps";
  const tool: AnyAgentTool = {
    name: "openclaw",
    label: "OpenClaw",
    // Keep human approval in one model tool call; a yielded cell can outlive its turn.
    catalogMode: "direct-only",
    description:
      "Delegate system setup or repair to a separate model turn. " +
      "Prefer your available tools for routine status and session/workspace checks. " +
      "Gateway restart, config, channels, plugins, agents, models/providers, API keys. " +
      "Supports multiple named custom/local model endpoints; provider IDs can be user-defined, while api selects the protocol. " +
      "Setup flows use masked entry, which keeps keys out of model context; if the user already gave a key or token in chat, pass it along and OpenClaw stores it without echoing it. " +
      `Changes wait for the user to approve ${approvalLocation} unless current Full Access or a standing delegation grant permits application without asking for approval. Returns the final outcome.`,
    parameters: OpenClawDelegateSchema,
    outputSchema: OpenClawDelegateOutputSchema,
    execute: async (_toolCallId, args, signal) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const message = readToolStringParam(params, "message", { required: true });
      const sessionId = readToolStringParam(params, "sessionId") ?? defaultSessionId;
      let fullPermission = false;
      try {
        assertAutoApproveChangesCurrent();
        fullPermission = true;
      } catch {
        // Missing automatic authority leaves the exact human-approval path available.
      }
      // Bind permissions and this call's cancellation privately: a stopped tool
      // must retire its proposal even while the requesting run remains live.
      const caller = sessionKey
        ? {
            agentId: options.sessionAgentId,
            sessionKey,
            fullPermission,
            assertAutoApproveChangesCurrent,
            approvalSignals: signal ? [signal] : [],
          }
        : undefined;
      // The helper admits its own runtime; caller authority remains in its separate scope.
      const result = await withGatewayToolCallerIdentity(caller, () =>
        runOutsidePreparedModelRuntimePluginGenerationScope(() =>
          runOutsidePluginRuntimeGenerationScope(() =>
            callInProcessGatewayTool<OpenClawDelegateResult>(
              "openclaw.chat",
              {
                sessionId,
                message,
                delegation: {
                  agentId: options.sessionAgentId,
                  ...(sessionKey ? { sessionKey } : {}),
                  ...(options.agentChannel ? { turnSourceChannel: options.agentChannel } : {}),
                  ...(turnSourceTo ? { turnSourceTo } : {}),
                  ...(options.agentAccountId
                    ? { turnSourceAccountId: options.agentAccountId }
                    : {}),
                  ...(turnSourceThreadId !== undefined ? { turnSourceThreadId } : {}),
                },
              },
              { signal },
            ),
          ),
        ),
      );
      return jsonResult({
        reply: result.reply,
        ...(result.action && result.action !== "none" ? { action: result.action } : {}),
      });
    },
  };
  return [tool];
}
