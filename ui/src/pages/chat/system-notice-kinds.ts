import { registerChatMessageMetadataEnglish } from "../../i18n/locales/en-chat-message-metadata.ts";

registerChatMessageMetadataEnglish();

export type PendingInputStatus =
  | "queued"
  | "waitingForWorkerSetup"
  | "waitingForWorkspaceSync"
  | "cancelled";

type SystemNoticeKind = {
  labelKey: string;
  // Fixed operator summary shown instead of the raw model prompt. Omit when the
  // producer emits variable, informative text (reasons, doctor hints) that must
  // stay visible; the notice then keeps the message body under the kind label.
  summaryKey?: string;
  // Collapse the variable body behind a disclosure. For bulky injected context
  // (skill instructions, continuation summaries) the label stays visible while
  // the payload opens on demand.
  collapsedBody?: true;
  showTimestamp?: true;
  // Injected mid-run context does not begin a new operator turn; kinds that do
  // start a turn omit this field.
  startsTurn?: false;
};

const systemNoticeKinds: Readonly<Record<string, SystemNoticeKind>> = {
  restart: {
    labelKey: "common.system",
    showTimestamp: true,
  },
  // Older scheduled conversation turns lack the run metadata for an activity row.
  cron: {
    labelKey: "chat.messages.forwardedAutomation",
    collapsedBody: true,
  },
  cron_failure_repair: {
    labelKey: "chat.systemNotice.automationRecovery.label",
    summaryKey: "chat.systemNotice.automationRecovery.summary",
  },
  "restart-sentinel": {
    labelKey: "chat.systemNotice.gatewayRestarted.label",
  },
  cli_harness_context: {
    labelKey: "chat.systemNotice.cliHarnessContext.label",
    collapsedBody: true,
    startsTurn: false,
  },
  claude_cli_task_notification: {
    labelKey: "chat.systemNotice.claudeCliTaskNotification.label",
    collapsedBody: true,
    startsTurn: false,
  },
};

const pluginSteeringNotice: SystemNoticeKind = {
  labelKey: "chat.systemNotice.pluginSteering.label",
  collapsedBody: true,
  showTimestamp: true,
  startsTurn: false,
};

export function resolveSystemNoticeKind(
  sourceTool: string | undefined,
): SystemNoticeKind | undefined {
  if (sourceTool?.startsWith("plugin:") && sourceTool.length > "plugin:".length) {
    return pluginSteeringNotice;
  }
  return sourceTool === undefined ? undefined : systemNoticeKinds[sourceTool];
}
