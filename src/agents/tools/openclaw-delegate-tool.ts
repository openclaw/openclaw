/** Regular-agent client for the OpenClaw system agent. */
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { SYSTEM_AGENT_ID } from "../../system-agent/agent-id.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { resolveExecDefaults } from "../exec-defaults.js";
import type { OpenClawToolsOptions } from "../openclaw-tools.types.js";
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

type OpenClawDelegateResult = {
  sessionId: string;
  reply: string;
  action?: string;
};

function stableDelegationSessionId(sessionKey: string | undefined, agentId: string): string {
  return sessionKey?.trim()
    ? `delegate-${sha256Hex(`${agentId}\0${sessionKey.trim()}`).slice(0, 32)}`
    : `delegate-${randomUUID()}`;
}

export function createOpenClawDelegateToolsForRun(
  options: Pick<
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
  > & { sessionAgentId: string },
): AnyAgentTool[] {
  if (options.sandboxed || options.sessionAgentId === SYSTEM_AGENT_ID) {
    return [];
  }
  const sessionKey = options.runSessionKey ?? options.agentSessionKey;
  const defaultSessionId = stableDelegationSessionId(sessionKey, options.sessionAgentId);
  const execPolicy = resolveExecDefaults({
    cfg: options.config,
    agentId: options.sessionAgentId,
    sessionKey: options.agentSessionKey ?? sessionKey,
    sessionEntry: options.execSession,
    execOverrides: options.execOverrides,
  });
  const fullPermission =
    options.fsPolicy?.workspaceOnly !== true &&
    execPolicy.effectiveHost !== "sandbox" &&
    execPolicy.security === "full" &&
    execPolicy.ask === "off";
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
      "Setup flows use masked entry, which keeps keys out of model context; if the user already gave a key or token in chat, pass it along and OpenClaw stores it without echoing it. " +
      (fullPermission
        ? "Full Access applies permitted changes without asking for approval."
        : `Changes wait for the user to approve ${approvalLocation} and return the final outcome.`),
    parameters: OpenClawDelegateSchema,
    outputSchema: OpenClawDelegateOutputSchema,
    execute: async (_toolCallId, args, signal) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const message = readToolStringParam(params, "message", { required: true });
      const sessionId = readToolStringParam(params, "sessionId") ?? defaultSessionId;
      // Bind permissions and this call's cancellation privately: a stopped tool
      // must retire its proposal even while the requesting run remains live.
      const caller = sessionKey
        ? {
            agentId: options.sessionAgentId,
            sessionKey,
            fullPermission,
            approvalSignals: signal ? [signal] : [],
          }
        : undefined;
      const result = await withGatewayToolCallerIdentity(caller, () =>
        callInProcessGatewayTool<OpenClawDelegateResult>("openclaw.chat", {
          sessionId,
          message,
          delegation: {
            agentId: options.sessionAgentId,
            ...(sessionKey ? { sessionKey } : {}),
            ...(options.agentChannel ? { turnSourceChannel: options.agentChannel } : {}),
            ...(turnSourceTo ? { turnSourceTo } : {}),
            ...(options.agentAccountId ? { turnSourceAccountId: options.agentAccountId } : {}),
            ...(turnSourceThreadId !== undefined ? { turnSourceThreadId } : {}),
          },
        }),
      );
      return jsonResult({
        reply: result.reply,
        ...(result.action && result.action !== "none" ? { action: result.action } : {}),
      });
    },
  };
  return [tool];
}
