// Ambient trusted caller context for model-mediated Gateway tool calls.
import { AsyncLocalStorage } from "node:async_hooks";
import type { TurnAuthoritySnapshot } from "../../plugins/authorization-policy.types.js";
import { copyPluginToolMeta } from "../../plugins/tools.js";
import {
  isIssuedTurnAuthoritySnapshot,
  rebindTurnAuthoritySnapshot,
  resolveTurnAuthorityAuthorization,
} from "../../plugins/turn-authority.js";
import {
  isUnscopedSessionKeySentinel,
  normalizeAgentId,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../../routing/session-key.js";
import { copyBeforeToolCallHookMarker } from "../before-tool-call-metadata.js";
import { copyChannelAgentToolMeta } from "../channel-tools.js";
import { copyToolTerminalPresentation } from "../tool-terminal-presentation.js";
import type { AnyAgentTool } from "./common.js";

export type GatewayToolCallerIdentity = {
  agentId: string;
  sessionKey: string;
  /** Immutable host authority for the admitted turn. Never sourced from tool arguments. */
  turnAuthority?: TurnAuthoritySnapshot;
  // Trusted run context, carried separately from model-authored tool arguments.
  turnSourceChannel?: string;
  turnSourceTo?: string;
  turnSourceAccountId?: string;
  turnSourceThreadId?: string | number;
};

type GatewayToolCallerBinding = Omit<GatewayToolCallerIdentity, "agentId" | "sessionKey"> & {
  agentId?: string;
  sessionKey?: string;
};

type GatewayToolCallerSource = {
  agentSessionKey?: string;
  runSessionKey?: string;
  turnAuthority?: TurnAuthoritySnapshot;
  agentChannel?: string;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  agentTo?: string;
  agentAccountId?: string;
  currentThreadTs?: string;
  agentThreadId?: string | number;
};

const gatewayToolCallerStorage = new AsyncLocalStorage<GatewayToolCallerIdentity>();

function runWithoutGatewayToolCallerIdentity<T>(run: () => T): T {
  return gatewayToolCallerStorage.exit(run);
}

function throwInvalidTurnAuthorityBinding(): never {
  const error = new Error("turn-authority-invalid");
  error.name = "TurnAuthorityValidationError";
  throw error;
}

function resolveCanonicalCallerSessionKey(params: {
  agentId: string;
  sessionKey: string;
}): string | undefined {
  const rawSessionKey = params.sessionKey.trim();
  if (isUnscopedSessionKeySentinel(rawSessionKey)) {
    // Global/unknown stores keep their literal key; authenticated agentId
    // carries the owner identity separately.
    return rawSessionKey.toLowerCase();
  }
  const sessionKey = toAgentStoreSessionKey({
    agentId: params.agentId,
    requestKey: rawSessionKey,
  });
  return parseAgentSessionKey(sessionKey)?.agentId === params.agentId ? sessionKey : undefined;
}

function resolveBoundTurnAuthority(identity: {
  agentId: string;
  sessionKey: string;
  turnAuthority?: TurnAuthoritySnapshot;
}): TurnAuthoritySnapshot | undefined {
  const turnAuthority = identity.turnAuthority;
  if (!isIssuedTurnAuthoritySnapshot(turnAuthority)) {
    return undefined;
  }
  const authorityAgentIdRaw = turnAuthority.authorization.agentId?.trim();
  const authoritySessionKeyRaw = turnAuthority.authorization.sessionKey?.trim();
  if (!authorityAgentIdRaw || !authoritySessionKeyRaw) {
    return undefined;
  }
  const agentId = normalizeAgentId(identity.agentId);
  const authorityAgentId = normalizeAgentId(authorityAgentIdRaw);
  if (authorityAgentId !== agentId) {
    return undefined;
  }
  const sessionKey = resolveCanonicalCallerSessionKey({
    agentId,
    sessionKey: identity.sessionKey,
  });
  const authoritySessionKey = resolveCanonicalCallerSessionKey({
    agentId: authorityAgentId,
    sessionKey: authoritySessionKeyRaw,
  });
  if (!sessionKey || authoritySessionKey !== sessionKey) {
    return undefined;
  }
  if (
    turnAuthority.authorization.agentId === agentId &&
    turnAuthority.authorization.sessionKey === sessionKey
  ) {
    return turnAuthority;
  }
  return rebindTurnAuthoritySnapshot(turnAuthority, {
    agentId,
    sessionKey,
    sessionId: turnAuthority.authorization.sessionId,
    runId: turnAuthority.authorization.runId,
    trigger: turnAuthority.authorization.trigger,
  });
}

export function getGatewayToolCallerIdentity(): GatewayToolCallerIdentity | undefined {
  return gatewayToolCallerStorage.getStore();
}

export async function withGatewayToolCallerIdentity<T>(
  identity: GatewayToolCallerIdentity | undefined,
  run: () => Promise<T> | T,
): Promise<T> {
  return await runWithGatewayToolCallerIdentity(identity, run);
}

function runWithGatewayToolCallerIdentity<T>(
  identity: GatewayToolCallerBinding | undefined,
  run: () => T,
): T {
  // A supplied rejected snapshot must stop before preparation or execution.
  // Merely clearing ambient identity would reopen legacy authorization paths.
  if (identity?.turnAuthority !== undefined) {
    resolveTurnAuthorityAuthorization(identity.turnAuthority);
  }
  if (!identity?.agentId?.trim() || !identity.sessionKey?.trim()) {
    if (identity?.turnAuthority !== undefined) {
      throwInvalidTurnAuthorityBinding();
    }
    return runWithoutGatewayToolCallerIdentity(run);
  }
  const agentId = normalizeAgentId(identity.agentId);
  const sessionKey = resolveCanonicalCallerSessionKey({
    agentId,
    sessionKey: identity.sessionKey,
  });
  if (!sessionKey) {
    if (identity.turnAuthority !== undefined) {
      throwInvalidTurnAuthorityBinding();
    }
    return runWithoutGatewayToolCallerIdentity(run);
  }
  const turnAuthority = resolveBoundTurnAuthority({
    agentId,
    sessionKey,
    turnAuthority: identity.turnAuthority,
  });
  if (identity.turnAuthority !== undefined && !turnAuthority) {
    throwInvalidTurnAuthorityBinding();
  }
  return gatewayToolCallerStorage.run(
    {
      agentId,
      sessionKey,
      ...(turnAuthority ? { turnAuthority } : {}),
      ...(identity.turnSourceChannel?.trim()
        ? { turnSourceChannel: identity.turnSourceChannel.trim() }
        : {}),
      ...(identity.turnSourceTo?.trim() ? { turnSourceTo: identity.turnSourceTo.trim() } : {}),
      ...(identity.turnSourceAccountId?.trim()
        ? { turnSourceAccountId: identity.turnSourceAccountId.trim() }
        : {}),
      ...(identity.turnSourceThreadId !== undefined
        ? { turnSourceThreadId: identity.turnSourceThreadId }
        : {}),
    },
    run,
  );
}

export function wrapToolWithGatewayCallerIdentity(
  tool: AnyAgentTool,
  identity: GatewayToolCallerBinding | undefined,
): AnyAgentTool {
  if (!tool.execute) {
    return tool;
  }
  const wrapped: AnyAgentTool = {
    ...tool,
    ...(tool.prepareArguments
      ? {
          prepareArguments: (args: unknown) =>
            runWithGatewayToolCallerIdentity(identity, () =>
              Reflect.apply(tool.prepareArguments!, tool, [args]),
            ),
        }
      : {}),
    execute: async (...args) =>
      await runWithGatewayToolCallerIdentity(identity, async () => await tool.execute?.(...args)),
  };
  copyPluginToolMeta(tool, wrapped);
  copyChannelAgentToolMeta(tool as never, wrapped as never);
  copyBeforeToolCallHookMarker(tool, wrapped);
  copyToolTerminalPresentation(tool, wrapped);
  return wrapped;
}

export function createGatewayToolCallerWrapper(
  agentId: string | undefined,
  source: GatewayToolCallerSource | undefined,
): (tool: AnyAgentTool) => AnyAgentTool {
  const sessionKey = source?.runSessionKey?.trim() || source?.agentSessionKey?.trim();
  const turnAuthority = source?.turnAuthority;
  const hasSuppliedTurnAuthority = turnAuthority !== undefined;
  const identity: GatewayToolCallerBinding | undefined =
    (agentId && sessionKey) || hasSuppliedTurnAuthority
      ? {
          ...(agentId ? { agentId } : {}),
          ...(sessionKey ? { sessionKey } : {}),
          // Preserve supplied authority through the wrapper boundary. Validation
          // must distinguish an absent snapshot from a supplied forged one.
          ...(hasSuppliedTurnAuthority ? { turnAuthority } : {}),
          turnSourceChannel: source?.agentChannel,
          turnSourceTo:
            source?.currentMessagingTarget ?? source?.currentChannelId ?? source?.agentTo,
          turnSourceAccountId: source?.agentAccountId,
          turnSourceThreadId: source?.currentThreadTs ?? source?.agentThreadId,
        }
      : undefined;
  return (tool) => wrapToolWithGatewayCallerIdentity(tool, identity);
}
