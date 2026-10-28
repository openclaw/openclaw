import crypto from "node:crypto";
import {
  expectedCurrentSessionBinding,
  type CurrentSessionBindingExpectation,
} from "../infra/outbound/session-binding-native-selection.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import type {
  SessionBindingBindInput,
  SessionBindingUnbindInput,
} from "../infra/outbound/session-binding.types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { bindConversationNow } from "./conversation-binding.js";
import type {
  PluginConversationBinding,
  PluginConversationBindingRequestParams,
} from "./conversation-binding.types.js";

const log = createSubsystemLogger("plugins/binding");

// Serializes bind+finalize+rollback per session so a failing older attempt
// can never unbind or restore over a newer successful one (all session binds
// go through this in-process seam).
const pluginSessionBindQueue = new KeyedAsyncQueue();

/** Binds a plugin-owned runtime to one authenticated Control UI session. */
export async function bindPluginSessionConversation(params: {
  pluginId: string;
  pluginName?: string;
  pluginRoot: string;
  sessionKey: string;
  binding: PluginConversationBindingRequestParams;
  afterBind?: () => Promise<void>;
}): Promise<PluginConversationBinding> {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    throw new Error("session key is required for a plugin session binding");
  }
  return await pluginSessionBindQueue.enqueue(sessionKey, async () => {
    const operation = { ...params, sessionKey };
    const conversation = {
      channel: INTERNAL_MESSAGE_CHANNEL,
      accountId: "default",
      conversationId: sessionKey,
    };
    const bindingService = getSessionBindingService();
    const previous = await bindingService.resolveByConversationAsync(conversation);
    const bindingAttemptId = crypto.randomUUID();
    const binding = await bindConversationNow({
      identity: operation,
      conversation,
      targetSessionKey: sessionKey,
      summary: operation.binding.summary,
      detachHint: operation.binding.detachHint,
      data: operation.binding.data,
      bindingAttemptId,
      expectedBinding: previous,
    });
    try {
      await operation.afterBind?.();
      return binding;
    } catch (error) {
      const current = await bindingService.resolveByConversationAsync(conversation);
      if (current?.metadata?.bindingAttemptId !== bindingAttemptId) {
        throw error;
      }
      try {
        const rollbackInput: SessionBindingUnbindInput & CurrentSessionBindingExpectation = {
          [expectedCurrentSessionBinding]: current,
          bindingId: current.bindingId,
          reason: "plugin-session-bind-rollback",
          scope: current.conversation,
        };
        await bindingService.unbind(rollbackInput);
        if (previous && (previous.expiresAt === undefined || previous.expiresAt > Date.now())) {
          const restoreInput: SessionBindingBindInput & CurrentSessionBindingExpectation = {
            [expectedCurrentSessionBinding]: null,
            targetSessionKey: previous.targetSessionKey,
            targetKind: previous.targetKind,
            conversation: previous.conversation,
            placement: "current",
            metadata: previous.metadata,
            ...(previous.expiresAt === undefined
              ? {}
              : { ttlMs: Math.max(1, previous.expiresAt - Date.now()) }),
          };
          await bindingService.bind(restoreInput);
        }
      } catch (rollbackError) {
        // The finalize failure is superseded by the rollback failure on the
        // throw path; keep it observable for diagnosis.
        log.warn("plugin session binding finalization failed before rollback", { error });
        throw new Error(
          "plugin session binding finalization failed and its previous binding could not be restored",
          { cause: rollbackError },
        );
      }
      throw error;
    }
  });
}
