import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveActiveEmbeddedRunSessionId } from "../../agents/embedded-agent-runner/active-run-projections.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isAuthorizedTextSlashCommandTurn,
  isNativeCommandTurn,
  resolveCommandTurnContext,
} from "../command-turn-context.js";
import type { MsgContext } from "../templating.js";
import { resolveCommandSourceSessionKey } from "./command-source-session-key.js";
import { replyRunRegistry } from "./reply-run-registry.js";

export function parseSteerMessage(raw: string): string | null {
  const match = raw.trim().match(/^\/(?:steer|tell)(?:\s+([\s\S]*))?$/i);
  return match ? (match[1] ?? "").trim() : null;
}

function listSteerCandidateSessionKeys(targetSessionKey: string): string[] {
  // Authorized text slash turns can still arrive on a source-only :slash:
  // lane while the direct conversation owns the active reply operation.
  return targetSessionKey.includes(":slash:")
    ? [
        targetSessionKey,
        targetSessionKey.replace(":slash:", ":direct:"),
        targetSessionKey.replace(":slash:", ":dm:"),
      ]
    : [targetSessionKey];
}

/**
 * Resolve an authorized explicit steer command to the exact session that owns
 * an injectable active reply. This is intentionally read-only: callers decide
 * whether to retarget session preparation or continue as an ordinary prompt.
 */
export function resolveActiveExplicitSteerSessionKey(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  sessionKey?: string;
  commandBody?: string;
}): string | undefined {
  const commandTurn = resolveCommandTurnContext(params.ctx);
  if (!isNativeCommandTurn(commandTurn) && !isAuthorizedTextSlashCommandTurn(commandTurn)) {
    return undefined;
  }
  const commandBody =
    params.commandBody ??
    commandTurn.body ??
    normalizeOptionalString(params.ctx.CommandBody) ??
    normalizeOptionalString(params.ctx.BodyForCommands) ??
    normalizeOptionalString(params.ctx.Body) ??
    "";
  const message = parseSteerMessage(commandBody);
  if (!message) {
    return undefined;
  }

  const sourceSessionKey = resolveCommandSourceSessionKey({
    ...params,
    sessionKey: params.sessionKey ?? params.ctx.SessionKey,
  });
  if (!sourceSessionKey) {
    return undefined;
  }
  for (const candidateKey of listSteerCandidateSessionKeys(sourceSessionKey)) {
    const operation = replyRunRegistry.get(candidateKey);
    const hasActiveOwner = operation
      ? replyRunRegistry.resolveCurrentMessageInjectionTarget(candidateKey) !== undefined
      : resolveActiveEmbeddedRunSessionId(candidateKey) !== undefined;
    if (hasActiveOwner) {
      return candidateKey;
    }
  }
  return undefined;
}
