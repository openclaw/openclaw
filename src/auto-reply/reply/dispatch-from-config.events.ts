import type { PluginHookReplyDispatchEvent } from "../../plugins/hook-types.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
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
    shouldSendToolSummariesAsync: () => Promise<boolean>;
    shouldSendFullToolDetailsAsync: () => Promise<boolean>;
  },
): PluginHookReplyDispatchEvent {
  const { shouldSendToolSummaries, shouldSendFullToolDetails, ...event } = params;
  return Object.defineProperties(event, {
    shouldSendToolSummaries: {
      enumerable: true,
      get() {
        warnPluginSdkDeprecation({
          family: "reply-visibility",
          method: "reply_dispatch.shouldSendToolSummaries",
          replacement: "await shouldSendToolSummariesAsync()",
        });
        return shouldSendToolSummaries();
      },
    },
    shouldSendFullToolDetails: {
      enumerable: true,
      get() {
        warnPluginSdkDeprecation({
          family: "reply-visibility",
          method: "reply_dispatch.shouldSendFullToolDetails",
          replacement: "await shouldSendFullToolDetailsAsync()",
        });
        return shouldSendFullToolDetails;
      },
    },
  }) as PluginHookReplyDispatchEvent;
}
