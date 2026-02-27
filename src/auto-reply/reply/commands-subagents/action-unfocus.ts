import { getThreadBindingManager } from "../../../discord/monitor/thread-bindings.js";
import type { CommandHandlerResult } from "../commands-types.js";
import {
  type SubagentsCommandContext,
  isDiscordSurface,
  resolveDiscordAccountId,
  stopWithText,
} from "./shared.js";

export function handleSubagentsUnfocusAction(ctx: SubagentsCommandContext): CommandHandlerResult {
  const { params } = ctx;
  if (!isDiscordSurface(params)) {
    return stopWithText("⚠️ /unfocus is only available on Discord.");
  }

  const threadId = params.ctx.MessageThreadId != null ? String(params.ctx.MessageThreadId) : "";
  if (!threadId.trim()) {
    return stopWithText("⚠️ /unfocus must be run inside a Discord thread.");
  }

  const threadBindings = getThreadBindingManager(resolveDiscordAccountId(params));
  if (!threadBindings) {
    return stopWithText("⚠️ Discord thread bindings are unavailable for this account.");
  }

  const binding = threadBindings.getByThreadId(threadId);
  if (!binding) {
    return stopWithText("ℹ️ This thread is not currently focused.");
  }

  const senderId = params.command.senderId?.trim() || "";
  if (binding.boundBy && binding.boundBy !== "system" && senderId && senderId !== binding.boundBy) {
    return stopWithText(`⚠️ Only ${binding.boundBy} can unfocus this thread.`);
  }

  threadBindings.unbindThread({
    threadId,
    reason: "manual",
    sendFarewell: true,
  });
  return stopWithText("✅ Thread unfocused.");
}
