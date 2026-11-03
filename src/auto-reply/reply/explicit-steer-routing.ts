import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  resolveExplicitSessionStorePathForScope,
  resolveSessionStorePathCore,
} from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getSessionControllerOperation,
  captureReplyMessageInjectionTarget,
} from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import {
  isAuthorizedTextSlashCommandTurn,
  isNativeCommandTurn,
  resolveCommandTurnContext,
} from "../command-turn-context.js";
import type { MsgContext } from "../templating.js";
import { resolveCommandSourceSessionKey } from "./command-source-session-key.js";

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

// Reads the steer payload of a native or authorized text command turn; null when
// that turn is not the /steer command. Uses the handler's own matcher.
function readExplicitSteerMessage(ctx: MsgContext, commandBody?: string): string | null {
  const commandTurn = resolveCommandTurnContext(ctx);
  if (!isNativeCommandTurn(commandTurn) && !isAuthorizedTextSlashCommandTurn(commandTurn)) {
    return null;
  }
  return parseSteerMessage(
    commandBody ??
      commandTurn.body ??
      normalizeOptionalString(ctx.CommandBody) ??
      normalizeOptionalString(ctx.BodyForCommands) ??
      normalizeOptionalString(ctx.Body) ??
      "",
  );
}

/**
 * True when this turn is an explicit /steer command. Its handler only replies with
 * usage or hands the message to queue policy, so admission must let it reach that
 * policy beside the active turn it steers instead of waiting for that turn to end.
 */
export function isExplicitSteerCommandTurn(ctx: MsgContext): boolean {
  return readExplicitSteerMessage(ctx) !== null;
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
  const message = readExplicitSteerMessage(params.ctx, params.commandBody);
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
  const agentId = resolveSessionAgentId({
    sessionKey: sourceSessionKey,
    config: params.cfg,
    fallbackAgentId: params.ctx.AgentId,
  });
  const storePath =
    resolveExplicitSessionStorePathForScope({ agentId, sessionKey: sourceSessionKey }) ??
    resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
  for (const candidateKey of listSteerCandidateSessionKeys(sourceSessionKey)) {
    const operation = getSessionControllerOperation(
      candidateKey,
      captureSessionTarget({ storeScope: storePath, sessionKey: candidateKey, agentId }),
    );
    if (captureReplyMessageInjectionTarget(operation)) {
      return candidateKey;
    }
  }
  return undefined;
}
