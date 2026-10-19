import type { toolIcons } from "../../components/icons-tools.ts";

export type PendingInputStatus =
  | "queued"
  | "waitingForWorkerSetup"
  | "waitingForWorkspaceSync"
  | "cancelled"
  | "interrupted";

type SystemNoticeKind = {
  icon: keyof typeof toolIcons;
  labelKey: string;
  // Fixed operator summary shown instead of the raw model prompt. Omit when the
  // producer emits variable, informative text (reasons, doctor hints) that must
  // stay visible; the notice then keeps the message body under the kind label.
  // Null keeps only the label unless a pending state supplies an actionable summary.
  summaryKey?: string | null;
  pendingSummaryKeys?: Partial<Record<PendingInputStatus, string>>;
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
  main_session_restart_recovery: {
    icon: "cpu",
    labelKey: "chat.systemNotice.restartRecovery.label",
    summaryKey: null,
    pendingSummaryKeys: {
      interrupted: "chat.systemNotice.restartRecovery.interrupted",
      cancelled: "chat.systemNotice.restartRecovery.cancelled",
    },
  },
  cron_failure_repair: {
    icon: "cpu",
    labelKey: "chat.systemNotice.automationRecovery.label",
    summaryKey: "chat.systemNotice.automationRecovery.summary",
  },
  "restart-sentinel": {
    icon: "cpu",
    labelKey: "chat.systemNotice.gatewayRestarted.label",
  },
  cli_harness_context: {
    icon: "cpu",
    labelKey: "chat.systemNotice.cliHarnessContext.label",
    collapsedBody: true,
    startsTurn: false,
  },
  claude_cli_task_notification: {
    icon: "cpu",
    labelKey: "chat.systemNotice.claudeCliTaskNotification.label",
    collapsedBody: true,
    startsTurn: false,
  },
};

const pluginSteeringNotice: SystemNoticeKind = {
  icon: "cpu",
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
