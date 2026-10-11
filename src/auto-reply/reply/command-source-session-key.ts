import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../agents/tools/sessions-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isNativeCommandTurn, resolveCommandTurnContext } from "../command-turn-context.js";
import type { MsgContext } from "../templating.js";

export function resolveCommandSourceSessionKey(
  params: { cfg: OpenClawConfig; ctx: MsgContext; sessionKey?: string },
  opts?: { preferCommandTarget?: boolean },
): string | undefined {
  const commandTarget = normalizeOptionalString(params.ctx.CommandTargetSessionKey);
  const commandSession = normalizeOptionalString(params.sessionKey);
  const preferCommandTarget =
    opts?.preferCommandTarget ?? isNativeCommandTurn(resolveCommandTurnContext(params.ctx));
  const raw = preferCommandTarget
    ? commandTarget || commandSession
    : commandSession || commandTarget;
  if (!raw) {
    return undefined;
  }
  const { alias } = resolveMainSessionAlias(params.cfg);
  return resolveInternalSessionKey({ key: raw, alias });
}
