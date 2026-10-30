import { t } from "../i18n/index.ts";
import type { SidebarRecentSession, SidebarSessionAttention } from "./app-sidebar-session-types.ts";
import { formatWebUiIconErrorText } from "./error-presentation.ts";
import { SESSION_ATTENTION_ICON_NAMES } from "./session-attention-icon-registry.ts";

export function sessionAttentionIconName(attention: SidebarSessionAttention) {
  return attention.kind === "question"
    ? "hand"
    : attention.kind === "approval"
      ? "shieldQuestion"
      : attention.kind === "agent"
        ? SESSION_ATTENTION_ICON_NAMES[attention.icon]
        : "alertTriangle";
}

export function resolveSessionIdleBadge(status: SidebarRecentSession["status"], translate = t) {
  switch (status) {
    case "done":
      return { icon: "check", label: translate("sessionsView.statusDone") } as const;
    case "killed":
      return { icon: "stop", label: translate("sessionsView.statusKilled") } as const;
    case "timeout":
      return { icon: "alertTriangle", label: translate("sessionsView.statusTimeout") } as const;
    case "interrupted":
      return { icon: "pause", label: translate("sessionsView.statusInterrupted") } as const;
    case "failed":
      return { icon: "alertTriangle", label: translate("sessionsView.statusFailed") } as const;
    default:
      return undefined;
  }
}

export function sessionAttentionSubtitle(
  attention: SidebarSessionAttention,
  translate = t,
): string | undefined {
  switch (attention.kind) {
    case "question":
      return translate("sessionsView.waitingForAnswer");
    case "approval":
      return translate("sessionsView.waitingForApproval");
    case "error":
      return translate(
        attention.childLabel === undefined
          ? "sessionsView.runFailedReason"
          : "sessionsView.childRunFailedReason",
        {
          label: attention.childLabel ?? "",
          reason: formatWebUiIconErrorText(attention.reason),
        },
      );
    case "agent":
      return attention.note;
    case "none":
      return undefined;
    default:
      return attention satisfies never;
  }
}

export function sessionAttentionTooltipParts(attention: SidebarSessionAttention, translate = t) {
  const subtitle = sessionAttentionSubtitle(attention, translate);
  if (attention.kind !== "question" && attention.kind !== "approval") {
    return { status: subtitle };
  }
  const requests = attention.requests.filter((request) => request.kind === attention.kind);
  const count = requests.reduce((total, request) => total + request.count, 0);
  return {
    status:
      count > 1
        ? translate(
            attention.kind === "question"
              ? "sessionsView.questionsNeedAnswer"
              : "sessionsView.approvalsNeedApproval",
            { count: String(count) },
          )
        : subtitle,
    preview: requests[0]?.preview,
    more:
      count > 1 ? translate("sessionsView.attentionMore", { count: String(count - 1) }) : undefined,
  };
}
