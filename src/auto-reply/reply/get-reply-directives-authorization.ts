/** Canonicalizes and authorizes core commands represented as reply directives. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { AuthorizationPolicyDenial } from "../../plugins/authorization-policy.js";
import { resolveTextCommand } from "../commands-registry.js";
import type { MsgContext } from "../templating.js";
import {
  authorizeCoreCommand,
  authorizeCoreCommandName,
  shouldAuthorizeCoreCommandTurn,
} from "./commands-authorization.js";
import type { CommandContext } from "./commands-types.js";
import type { PreparedModelDirectiveEffect } from "./directive-handling.model-selection.js";
import type { InlineDirectives } from "./directive-handling.parse.js";

export type DirectiveAuthorizationRequest = {
  commandName: string;
  rawArguments?: string;
  values?: Record<string, unknown>;
};

function joinDirectiveArguments(parts: Array<string | undefined>): string | undefined {
  return normalizeOptionalString(
    parts
      .map((part) => normalizeOptionalString(part))
      .filter(Boolean)
      .join(" "),
  );
}

function compactDirectiveValues(
  values: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const entries = Object.entries(values).flatMap(([key, value]) => {
    const normalized = typeof value === "string" ? normalizeOptionalString(value) : value;
    return normalized === undefined || normalized === null ? [] : [[key, normalized] as const];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function resolveDirectiveAuthorizationRequests(
  directives: InlineDirectives,
  options?: { modelEffect?: PreparedModelDirectiveEffect },
): DirectiveAuthorizationRequest[] {
  const requests: DirectiveAuthorizationRequest[] = [];
  const add = (params: {
    present: boolean;
    commandName: string;
    rawArguments?: string;
    values?: Record<string, unknown>;
  }) => {
    if (!params.present) {
      return;
    }
    const rawArguments = normalizeOptionalString(params.rawArguments);
    const values = compactDirectiveValues(params.values ?? {});
    requests.push({
      commandName: params.commandName,
      ...(rawArguments ? { rawArguments } : {}),
      ...(values ? { values } : {}),
    });
  };
  add({
    present: directives.hasThinkDirective,
    commandName: "think",
    rawArguments: directives.rawThinkLevel,
    values: { level: directives.thinkLevel ?? directives.rawThinkLevel },
  });
  add({
    present: directives.hasVerboseDirective,
    commandName: "verbose",
    rawArguments: directives.rawVerboseLevel,
    values: { mode: directives.verboseLevel ?? directives.rawVerboseLevel },
  });
  add({
    present: directives.hasTraceDirective,
    commandName: "trace",
    rawArguments: directives.rawTraceLevel,
    values: { mode: directives.traceLevel ?? directives.rawTraceLevel },
  });
  add({
    present: directives.hasFastDirective,
    commandName: "fast",
    rawArguments: directives.rawFastMode,
    values: { mode: directives.fastMode ?? directives.rawFastMode },
  });
  add({
    present: directives.hasReasoningDirective,
    commandName: "reasoning",
    rawArguments: directives.rawReasoningLevel,
    values: { mode: directives.reasoningLevel ?? directives.rawReasoningLevel },
  });
  add({
    present: directives.hasElevatedDirective,
    commandName: "elevated",
    rawArguments: directives.rawElevatedLevel,
    values: { mode: directives.elevatedLevel ?? directives.rawElevatedLevel },
  });
  const execValues = {
    host: directives.execHost,
    security: directives.execSecurity,
    ask: directives.execAsk,
    node: directives.execNode,
  };
  add({
    present: directives.hasExecDirective,
    commandName: "exec",
    rawArguments: joinDirectiveArguments([
      directives.rawExecHost ? `host=${directives.rawExecHost}` : undefined,
      directives.rawExecSecurity ? `security=${directives.rawExecSecurity}` : undefined,
      directives.rawExecAsk ? `ask=${directives.rawExecAsk}` : undefined,
      directives.rawExecNode ? `node=${directives.rawExecNode}` : undefined,
    ]),
    values: execValues,
  });
  add({ present: directives.hasStatusDirective, commandName: "status" });
  const model = normalizeOptionalString(directives.rawModelDirective);
  const profile = normalizeOptionalString(directives.rawModelProfile);
  const runtime = normalizeOptionalString(directives.rawModelRuntime);
  const modelRef = model ? `${model}${profile ? `@${profile}` : ""}` : undefined;
  const modelEffect = options?.modelEffect;
  add({
    present: directives.hasModelDirective,
    commandName: "model",
    rawArguments: joinDirectiveArguments([modelRef, runtime ? `--runtime ${runtime}` : undefined]),
    values:
      modelEffect?.kind === "selection"
        ? {
            provider: modelEffect.modelSelection.provider,
            model: modelEffect.modelSelection.model,
            profile: modelEffect.profileOverride,
            runtime: modelEffect.runtime,
          }
        : undefined,
  });
  const queueMode = directives.queueReset ? "reset" : directives.queueMode;
  const queueValues = {
    mode: queueMode,
    debounce: directives.debounceMs,
    cap: directives.cap,
    drop: directives.dropPolicy,
  };
  add({
    present: directives.hasQueueDirective,
    commandName: "queue",
    rawArguments: joinDirectiveArguments([
      directives.queueReset ? "reset" : directives.rawQueueMode,
      directives.rawDebounce ? `debounce:${directives.rawDebounce}` : undefined,
      directives.rawCap ? `cap:${directives.rawCap}` : undefined,
      directives.rawDrop ? `drop:${directives.rawDrop}` : undefined,
    ]),
    values: queueValues,
  });
  return requests;
}

type ReplyDirectiveAuthorizationParams = {
  command: CommandContext;
  ctx: MsgContext;
  directives: InlineDirectives;
  config: OpenClawConfig;
  allowTextCommands: boolean;
  agentId: string;
  sessionKey: string;
  sessionId?: string;
  signal?: AbortSignal;
};

async function authorizeDirectiveRequest(
  params: ReplyDirectiveAuthorizationParams,
  request: DirectiveAuthorizationRequest,
): Promise<AuthorizationPolicyDenial | undefined> {
  const authorization = await authorizeCoreCommandName({
    command: params.command,
    ctx: params.ctx,
    commandName: request.commandName,
    config: params.config,
    rawArguments: request.rawArguments,
    values: request.values,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    signal: params.signal,
  });
  return authorization.allowed ? undefined : authorization.denial;
}

/** Authorizes every parsed directive except `/model`, whose concrete effect resolves later. */
export async function authorizeReplyDirectiveCommandsBeforeModelResolution(
  params: ReplyDirectiveAuthorizationParams,
): Promise<AuthorizationPolicyDenial | undefined> {
  const requests = resolveDirectiveAuthorizationRequests(params.directives);
  const leadingCommandName = resolveTextCommand(params.command.commandBodyNormalized)?.command.key;
  const leadingCommandIsParsedDirective =
    leadingCommandName !== undefined &&
    requests.some((request) => request.commandName === leadingCommandName);
  if (
    params.command.isAuthorizedSender &&
    !leadingCommandIsParsedDirective &&
    shouldAuthorizeCoreCommandTurn({
      allowTextCommands: params.allowTextCommands,
      commandBodyNormalized: params.command.commandBodyNormalized,
    })
  ) {
    const authorization = await authorizeCoreCommand({
      command: params.command,
      ctx: params.ctx,
      config: params.config,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      signal: params.signal,
    });
    if (authorization.matched && !authorization.allowed) {
      return authorization.denial;
    }
  }
  if (!params.command.isAuthorizedSender) {
    return undefined;
  }
  for (const request of requests) {
    if (request.commandName === "model") {
      continue;
    }
    const denial = await authorizeDirectiveRequest(params, request);
    if (denial) {
      return denial;
    }
  }
  return undefined;
}

/** Authorizes `/model` using the concrete effect prepared for the mutation path. */
export async function authorizeResolvedReplyModelDirective(
  params: ReplyDirectiveAuthorizationParams & { modelEffect: PreparedModelDirectiveEffect },
): Promise<AuthorizationPolicyDenial | undefined> {
  if (!params.command.isAuthorizedSender || !params.directives.hasModelDirective) {
    return undefined;
  }
  const request = resolveDirectiveAuthorizationRequests(params.directives, {
    modelEffect: params.modelEffect,
  }).find((candidate) => candidate.commandName === "model");
  return request ? await authorizeDirectiveRequest(params, request) : undefined;
}
