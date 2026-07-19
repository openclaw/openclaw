import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createAuthorizationInvocationContext,
  createAuthorizationPrincipal,
  normalizeAuthorizationCommandSource,
} from "../../plugins/authorization-policy-context.js";
import {
  runAuthorizationPolicies,
  type AuthorizationPolicyDenial,
} from "../../plugins/authorization-policy.js";
import type { AuthorizationCommandOwner } from "../../plugins/authorization-policy.types.js";
import type { PluginJsonValue } from "../../plugins/host-hook-json.js";
import {
  classifyTurnAuthoritySnapshot,
  rebindTurnAuthoritySnapshot,
} from "../../plugins/turn-authority.js";
/** Final authorization gate shared by built-in command dispatch paths. */
import { parseCommandArgs, resolveTextCommand } from "../commands-registry.js";
import type { MsgContext } from "../templating.js";
import type { CommandContext } from "./commands-types.js";

export type CoreCommandAuthorizationResult =
  | { matched: false }
  | { matched: true; allowed: true; commandKey: string }
  | { matched: true; allowed: false; commandKey: string; denial: AuthorizationPolicyDenial };

const ALWAYS_HANDLED_TEXT_COMMAND_PATTERN = /^\/(?:new|reset|stop)(?:\s|$)/i;

/** Uses the provider thread even when the session intentionally stays conversation-scoped. */
export function resolveCommandAuthorizationThreadId(
  ctx: Pick<MsgContext, "MessageThreadId" | "TransportThreadId">,
): string | number | undefined {
  return ctx.MessageThreadId ?? ctx.TransportThreadId;
}

/** Keeps policy checks aligned with commands the host still handles when text commands are off. */
export function shouldAuthorizeCoreCommandTurn(params: {
  allowTextCommands: boolean;
  commandBodyNormalized: string;
}): boolean {
  return (
    params.allowTextCommands ||
    ALWAYS_HANDLED_TEXT_COMMAND_PATTERN.test(params.commandBodyNormalized.trim())
  );
}

type CommandAuthorizationResult =
  | { allowed: true }
  | { allowed: false; denial: AuthorizationPolicyDenial };

function normalizeCommandValues(
  values: Record<string, unknown> | undefined,
): Record<string, PluginJsonValue> | undefined {
  if (!values) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(values);
  const keys = Reflect.ownKeys(values);
  if (prototype !== Object.prototype && prototype !== null) {
    // Preserve malformed input so the central canonical snapshot gate rejects it.
    return values as Record<string, PluginJsonValue>;
  }
  const normalized: Record<string, unknown> = {};
  for (const key of keys) {
    if (typeof key !== "string") {
      return values as Record<string, PluginJsonValue>;
    }
    const descriptor = Object.getOwnPropertyDescriptor(values, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return values as Record<string, PluginJsonValue>;
    }
    normalized[key] =
      typeof descriptor.value === "bigint" ? descriptor.value.toString() : descriptor.value;
  }
  // Other malformed values intentionally survive; runAuthorizationPolicies rejects them.
  return normalized as Record<string, PluginJsonValue>;
}

export async function authorizeCommandInvocation(params: {
  command: CommandContext;
  ctx: MsgContext;
  commandName: string;
  owner: AuthorizationCommandOwner;
  config?: OpenClawConfig;
  rawArguments?: string;
  values?: Record<string, unknown>;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  phase?: "session-mutation" | "final";
  signal?: AbortSignal;
}): Promise<CommandAuthorizationResult> {
  const rawArguments = params.rawArguments?.trim();
  const values = normalizeCommandValues(params.values);
  const classifiedAuthority = classifyTurnAuthoritySnapshot(params.ctx.TurnAuthority);
  if (classifiedAuthority.kind === "invalid") {
    return {
      allowed: false,
      denial: {
        denied: true,
        kind: "error",
        pluginId: "authorization-engine",
        policyId: "turn-authority",
        code: "turn-authority-invalid",
      },
    };
  }
  const sourceTurnAuthority =
    classifiedAuthority.kind === "issued" ? classifiedAuthority.snapshot : undefined;
  const sourceAuthorization = sourceTurnAuthority?.authorization;
  const commandTurnAuthority =
    params.agentId && params.sessionKey
      ? rebindTurnAuthoritySnapshot(sourceTurnAuthority, {
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          sessionId: params.sessionId,
          runId: params.runId ?? sourceAuthorization?.runId,
          trigger: "command",
        })
      : sourceTurnAuthority;
  const denial = await runAuthorizationPolicies({
    request: {
      operation: "command.invoke",
      phase: params.phase ?? "final",
      commandName: params.commandName,
      owner: params.owner,
      source: normalizeAuthorizationCommandSource(params.ctx.CommandSource),
      ...(rawArguments || values
        ? {
            arguments: {
              ...(rawArguments ? { raw: rawArguments } : {}),
              ...(values ? { values } : {}),
            },
          }
        : {}),
    },
    context:
      commandTurnAuthority?.authorization ??
      createAuthorizationInvocationContext({
        principal: createAuthorizationPrincipal({
          provider: params.command.channel || params.command.surface,
          accountId: params.command.accountId,
          senderId: params.command.senderId,
          senderName: params.command.senderName,
          senderUsername: params.command.senderUsername,
          senderE164: params.command.senderE164,
          senderIsOwner: params.command.senderIsOwner,
          isAuthorizedSender: params.command.isAuthorizedSender,
          roleIds: params.command.memberRoleIds,
        }),
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        runId: params.runId,
        conversationId:
          params.ctx.NativeChannelId ??
          params.ctx.OriginatingTo ??
          params.command.to ??
          params.command.from,
        parentConversationId: params.ctx.ThreadParentId,
        threadId: resolveCommandAuthorizationThreadId(params.ctx),
        trigger: "command",
      }),
    config: params.config,
    signal: params.signal,
  });
  return denial ? { allowed: false, denial } : { allowed: true };
}

export async function authorizeCoreCommandName(params: {
  command: CommandContext;
  ctx: MsgContext;
  commandName: string;
  config?: OpenClawConfig;
  rawArguments?: string;
  values?: Record<string, unknown>;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  phase?: "session-mutation" | "final";
  signal?: AbortSignal;
}): Promise<CommandAuthorizationResult> {
  return await authorizeCommandInvocation({
    ...params,
    owner: { kind: "core" },
  });
}

export async function authorizeCoreCommand(params: {
  command: CommandContext;
  ctx: MsgContext;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  phase?: "session-mutation" | "final";
  signal?: AbortSignal;
}): Promise<CoreCommandAuthorizationResult> {
  const resolved = resolveTextCommand(params.command.commandBodyNormalized);
  if (!resolved) {
    return { matched: false };
  }
  const commandKey = resolved.command.key;
  const parsedArgs = parseCommandArgs(resolved.command, resolved.args);
  const result = await authorizeCoreCommandName({
    command: params.command,
    ctx: params.ctx,
    commandName: commandKey,
    config: params.config,
    rawArguments: parsedArgs?.raw,
    values: parsedArgs?.values,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
    phase: params.phase,
    signal: params.signal,
  });
  if (!result.allowed) {
    return { matched: true, allowed: false, commandKey, denial: result.denial };
  }
  return { matched: true, allowed: true, commandKey };
}

export function resolveCommandAuthorizationDenialText(_denial: AuthorizationPolicyDenial): string {
  return "Command blocked by authorization policy.";
}
