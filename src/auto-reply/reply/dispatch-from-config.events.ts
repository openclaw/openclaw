import type { PluginHookReplyDispatchEvent } from "../../plugins/hook-types.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";

export type PluginBindingTranscriptOwner = {
  agentId: string;
  expectedSessionId?: string;
  sessionKey: string;
  transcriptWriteBlocked?: true;
};

export function admittedSessionSettingsRestrictRuntime(
  settings: InternalGetReplyOptions["admittedSessionSettings"],
): boolean {
  return (
    (settings?.permissionMode !== undefined && settings.permissionMode !== "full") ||
    (settings?.toolOverrides !== undefined && Object.keys(settings.toolOverrides).length > 0)
  );
}

export function createReplyDispatchEvent(
  params: Omit<PluginHookReplyDispatchEvent, "shouldSendToolSummaries"> & {
    shouldSendToolSummaries: () => boolean;
  },
): PluginHookReplyDispatchEvent {
  const { shouldSendToolSummaries, ...event } = params;
  return Object.defineProperty(event, "shouldSendToolSummaries", {
    enumerable: true,
    get: shouldSendToolSummaries,
  }) as PluginHookReplyDispatchEvent;
}
