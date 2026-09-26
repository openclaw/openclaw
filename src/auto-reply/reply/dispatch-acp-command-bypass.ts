// Detects ACP commands that should bypass normal agent dispatch.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasControlCommand } from "../command-detection.js";
import { isCommandEnabled } from "../commands-registry-list.js";
import { shouldHandleTextCommands } from "../commands-text-routing.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { resolveCommandContextText } from "./context-text.js";

export function shouldBypassAcpDispatchForCommand(
  ctx: FinalizedRuntimeMsgContext,
  cfg: OpenClawConfig,
): boolean {
  const candidate = resolveCommandContextText(ctx);
  if (!candidate) {
    return false;
  }
  const allowTextCommands = shouldHandleTextCommands({
    cfg,
    surface: ctx.Surface ?? ctx.Provider ?? "",
    commandSource: ctx.CommandSource,
  });
  if (/^\/(?:new|reset|acp)(?:\s|$)/i.test(candidate)) {
    return true;
  }

  if (hasControlCommand(candidate, cfg)) {
    return allowTextCommands;
  }

  if (!candidate.startsWith("!") || !ctx.CommandAuthorized || !isCommandEnabled(cfg, "bash")) {
    return false;
  }
  return allowTextCommands;
}
