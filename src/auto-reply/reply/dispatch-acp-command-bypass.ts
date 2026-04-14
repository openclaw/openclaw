import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isCommandEnabled,
  maybeResolveTextAlias,
  shouldHandleTextCommands,
} from "../commands-registry.js";
import type { FinalizedMsgContext } from "../templating.js";

function resolveFirstContextText(
  ctx: FinalizedMsgContext,
  keys: Array<"BodyForAgent" | "BodyForCommands" | "CommandBody" | "RawBody" | "Body">,
): string {
  for (const key of keys) {
    const value = ctx[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function resolveCommandCandidateText(ctx: FinalizedMsgContext): string {
  return resolveFirstContextText(ctx, ["CommandBody", "BodyForCommands", "RawBody", "Body"]).trim();
}

function isResetCommandCandidate(text: string): boolean {
  return /^\/(?:new|reset)(?:[\s:@]|$)/i.test(text);
}

function isAcpCommandCandidate(text: string): boolean {
  return /^\/acp(?:[\s:@]|$)/i.test(text);
}

export function shouldBypassAcpDispatchForCommand(
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): boolean {
  const candidate = resolveCommandCandidateText(ctx);
  if (!candidate) {
    return false;
  }
  const normalized = candidate.trim();
  const allowTextCommands = shouldHandleTextCommands({
    cfg,
    surface: ctx.Surface ?? ctx.Provider ?? "",
    commandSource: ctx.CommandSource,
  });
  if (!normalized.startsWith("/") && maybeResolveTextAlias(candidate, cfg) != null) {
    return allowTextCommands;
  }

  if (isResetCommandCandidate(normalized)) {
    return true;
  }

  // `/acp ...` must bypass the ACP dispatch unconditionally, for the same
  // reason `/new` and `/reset` do: these are session-management commands
  // and the user needs them to work even when `commands.text: false` is
  // set on the surface. In particular, `/acp close` is the escape hatch
  // for a runaway ACP session — gating it on `allowTextCommands` would
  // leave the user editing `thread-bindings.json` by hand to recover,
  // which is exactly the workaround that motivated #66298. Without this
  // bypass, `/acp close` issued inside a bound Discord thread reaches
  // the ACP agent and gets replied to with a hallucinated natural-
  // language message while the session stays open.
  if (isAcpCommandCandidate(normalized)) {
    return true;
  }

  if (!normalized.startsWith("!")) {
    return false;
  }

  if (!ctx.CommandAuthorized) {
    return false;
  }

  if (!isCommandEnabled(cfg, "bash")) {
    return false;
  }

  return allowTextCommands;
}
