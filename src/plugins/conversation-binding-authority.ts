import { AsyncLocalStorage } from "node:async_hooks";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ConversationRef } from "../infra/outbound/session-binding.types.js";
import type { WithCurrentPluginConversationBinding } from "./conversation-binding-authority.types.js";
import { mintPluginConversationBindingCurrent } from "./conversation-binding-current.js";

/** Bind authenticated host facts, never plugin/model-supplied selectors, before preparation. */
export function createPluginConversationBindingScope(params: {
  pluginId: string;
  pluginRoot?: string;
  senderId?: string;
  conversation: (ConversationRef & { threadId?: string | number }) | null;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  storePath?: string;
  config: OpenClawConfig;
  assertCurrent: () => void;
}): WithCurrentPluginConversationBinding {
  const captured = { ...params, conversation: params.conversation && { ...params.conversation } };
  return async (action) => {
    // Worker admission callbacks must retain this call's source, not a later tool call's ALS.
    const runInScope = AsyncLocalStorage.snapshot();
    const assertCallerCurrent = () => runInScope(captured.assertCurrent);
    assertCallerCurrent();
    const { pluginId, pluginRoot, senderId, conversation, agentId, sessionKey, sessionId } =
      captured;
    if (!pluginRoot || !senderId || !conversation || !agentId || !sessionKey || !sessionId) {
      throw new Error(
        "Current plugin conversation authority requires an authenticated channel requester and session",
      );
    }
    const [
      { captureSessionEntryCurrentCheckAsyncInternal },
      { prepareSessionBindingInspections },
      { captureOpenClawStateWorkerContext },
      { toPluginConversationBinding },
    ] = await Promise.all([
      import("../config/sessions/session-entry-current-check.js"),
      import("../infra/outbound/session-binding-service.js"),
      import("../state/openclaw-state-worker-context.js"),
      import("./conversation-binding.js"),
    ]);
    assertCallerCurrent();
    const context = captureOpenClawStateWorkerContext();
    const selection = await prepareSessionBindingInspections([conversation]);
    let active = true;
    let session:
      | Awaited<ReturnType<typeof captureSessionEntryCurrentCheckAsyncInternal>>
      | undefined;
    try {
      if (!selection.native) {
        throw new Error("Current plugin conversation authority requires a native binding owner");
      }
      session = await captureSessionEntryCurrentCheckAsyncInternal({
        agentId,
        sessionKey,
        storePath: captured.storePath,
        config: captured.config,
        fields: ["sessionId"],
      });
      const selected = selection.inspect()[0];
      const record = selected?.status === "available" ? selected.binding : null;
      const binding = toPluginConversationBinding(record);
      if (
        !record ||
        record.status !== "active" ||
        record.targetKind !== "session" ||
        record.targetSessionKey !== sessionKey ||
        !binding ||
        binding.pluginId !== pluginId ||
        binding.pluginRoot !== pluginRoot ||
        session.entry?.sessionId !== sessionId
      ) {
        throw new Error("This invocation has no current plugin conversation assignment");
      }
      const assertCurrent = () => {
        if (!active) {
          throw new Error("Plugin conversation binding scope closed");
        }
        assertCallerCurrent();
        context.admission.assertCurrent();
        session!.source();
        const current = selection.inspect()[0];
        if (
          current?.status !== "available" ||
          current.binding?.bindingId !== record.bindingId ||
          current.binding.status !== "active"
        ) {
          throw new Error("Plugin conversation assignment is no longer current");
        }
      };
      assertCurrent();
      const conversationBindingCurrent = mintPluginConversationBindingCurrent(
        { databaseIdentity: context.admission.identity.key, record: structuredClone(record) },
        assertCurrent,
      );
      return await action({
        version: 1,
        binding: { ...structuredClone(binding), threadId: conversation.threadId },
        requester: { kind: "channel", ...conversation, senderId },
        session: { agentId, sessionKey, sessionId },
        assertCurrent,
        sessionEntryCurrent: session.entryCurrent,
        conversationBindingCurrent,
      });
    } finally {
      active = false;
      selection.dispose();
      session?.release();
    }
  };
}
