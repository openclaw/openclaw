import type {
  PluginHookMessageReceivedEvent,
  PluginHookMessageSentEvent,
  PluginHookMessageContext,
} from "../plugins/types.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";

export type {
  PluginHookMessageReceivedEvent,
  PluginHookMessageSentEvent,
  PluginHookMessageContext,
};

export function emitMessageReceived(
  event: PluginHookMessageReceivedEvent,
  ctx: PluginHookMessageContext,
): void {
  const runner = getGlobalHookRunner();
  if (!runner?.hasHooks("message_received")) {
    if (process.env.DEBUG_HOOKS) {
      const hookCount = runner?.getHookCount("message_received") ?? 0;
      console.log(
        `[emit-hooks] message_received: no hooks (runner=${!!runner}, count=${hookCount}, from=${event.from})`,
      );
    }
    return;
  }
  void runner.runMessageReceived(event, ctx).catch((err) => {
    console.error(`[emit-hooks] message_received hook failed: ${String(err)}`);
  });
}

export function emitMessageSent(
  event: PluginHookMessageSentEvent,
  ctx: PluginHookMessageContext,
): void {
  const runner = getGlobalHookRunner();
  if (!runner?.hasHooks("message_sent")) {
    if (process.env.DEBUG_HOOKS) {
      const hookCount = runner?.getHookCount("message_sent") ?? 0;
      console.log(
        `[emit-hooks] message_sent: no hooks (runner=${!!runner}, count=${hookCount}, to=${event.to})`,
      );
    }
    return;
  }
  void runner.runMessageSent(event, ctx).catch((err) => {
    console.error(`[emit-hooks] message_sent hook failed: ${String(err)}`);
  });
}
