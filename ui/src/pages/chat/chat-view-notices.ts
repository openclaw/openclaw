import { html, nothing, type TemplateResult } from "lit";
import type { SessionPlacementDiskSpace } from "../../../../packages/gateway-protocol/src/schema/session-placement.ts";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import { formatWebUiIconErrorText } from "../../components/error-presentation.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { formatBytes } from "../../lib/agents/display.ts";
import { findChatSubmissionMessage } from "../../lib/chat/history-message-identity.ts";
import { renderChatErrorNotice } from "./components/chat-error-notice.ts";
import { renderWorkspaceConflictNotice } from "./components/chat-workspace-conflict.ts";
import type { ProviderPolicyNotice } from "./tool-stream-contract.ts";
import type { WorkspaceResultConflict } from "./workspace-conflict.ts";

registerNewSessionSetupEnglish();

export type ChatPlacementStartupNoticeProps = {
  placementStartup?: ApplicationPlacementStartupStatus | null;
  onRetrySessionPlacementStartup?: () => void;
};

type ChatViewNoticesProps = ChatPlacementStartupNoticeProps & {
  diskSpace?: SessionPlacementDiskSpace;
  error?: string | null;
  focusMode?: boolean;
  onDismissError?: () => void;
  onDismissWorkspaceConflict?: () => void;
  onToggleFocusMode?: () => void;
  workspaceConflict?: WorkspaceResultConflict | null;
};

type ChatComposerNoticesProps = ChatPlacementStartupNoticeProps & {
  connected?: boolean;
  messages: readonly unknown[];
  providerPolicyNotice?: ProviderPolicyNotice | null;
  providerReviewNotice?: TemplateResult | typeof nothing;
  runError?: { summary: string; runId?: string } | null;
  onRefresh?: () => void;
  onDismissWorkspaceConflict?: () => void;
  workspaceConflict?: WorkspaceResultConflict | null;
};

function renderDiskSpaceNotice(diskSpace: SessionPlacementDiskSpace | undefined) {
  if (!diskSpace || diskSpace.status === "ok") {
    return nothing;
  }
  const usedPercent =
    diskSpace.totalBytes > 0
      ? Math.round(((diskSpace.totalBytes - diskSpace.availableBytes) / diskSpace.totalBytes) * 100)
      : 0;
  const critical = diskSpace.status === "critical";
  return html`
    <div
      class="chat-composer-neighbor-card chat-composer-neighbor-card--${
        critical ? "danger" : "warn"
      } chat-cloud-disk-space-notice"
      role=${critical ? "alert" : "status"}
    >
      <span class="chat-composer-neighbor-card__icon" aria-hidden="true"
        >${icons.alertTriangle}</span
      >
      <div class="chat-composer-neighbor-card__copy">
        <strong
          >${t(critical ? "chat.diskSpace.criticalTitle" : "chat.diskSpace.warningTitle")}</strong
        >
        <span>
          ${t(critical ? "chat.diskSpace.criticalBody" : "chat.diskSpace.warningBody", {
            percent: String(usedPercent),
            free: formatBytes(diskSpace.availableBytes),
          })}
        </span>
      </div>
    </div>
  `;
}

export function renderChatTopbarNotices(props: ChatViewNoticesProps) {
  const dismiss = props.onDismissError
    ? html`
        <openclaw-tooltip .content=${t("chat.actions.dismissError")}>
          <button
            class="chat-error__dismiss"
            type="button"
            @click=${props.onDismissError}
            aria-label=${t("chat.actions.dismissError")}
          >
            ${icons.x}
          </button>
        </openclaw-tooltip>
      `
    : nothing;
  return html`
    <div class="chat-topbar-notices">
      ${renderDiskSpaceNotice(props.diskSpace)}
      ${props.error ? renderChatErrorNotice({ error: props.error, action: dismiss }) : nothing}
      ${
        props.focusMode && props.onToggleFocusMode
          ? html`
              <openclaw-tooltip .content=${t("chat.actions.exitFocusMode")}>
                <button
                  class="chat-focus-exit"
                  type="button"
                  @click=${props.onToggleFocusMode}
                  aria-label=${t("chat.actions.exitFocusMode")}
                >
                  ${icons.x}
                </button>
              </openclaw-tooltip>
            `
          : nothing
      }
    </div>
  `;
}

export function renderChatComposerNotices(props: ChatComposerNoticesProps) {
  const refresh = props.onRefresh
    ? html`<button
        class="btn btn--sm chat-error__refresh"
        type="button"
        ?disabled=${!props.connected}
        @click=${props.onRefresh}
      >
        ${t("common.refresh")}
      </button>`
    : nothing;
  return html`
    ${props.providerReviewNotice ?? nothing}
    ${renderProviderPolicyNotice(props.providerPolicyNotice)}
    ${
      props.runError
        ? renderChatErrorNotice({
            error: props.runError.summary,
            action: refresh,
            runId: props.runError.runId,
          })
        : nothing
    }
    ${renderWorkspaceConflictNotice({
      conflict: props.workspaceConflict ?? undefined,
      onDismiss: props.onDismissWorkspaceConflict,
    })}
    ${renderPlacementStartupError(
      props.placementStartup,
      props.messages,
      props.onRetrySessionPlacementStartup,
    )}
  `;
}

function renderProviderPolicyNotice(notice: ProviderPolicyNotice | null | undefined) {
  if (!notice) {
    return nothing;
  }
  const blocked = notice.state === "blocked" || notice.state === "unavailable";
  const model = notice.fallbackModel ?? notice.model;
  const namesModel = notice.state !== "buffering" && notice.state !== "blocked";
  const body =
    namesModel && !model
      ? t("chat.providerPolicy.fallbackUnknownBody")
      : t(`chat.providerPolicy.${notice.state}Body`, { model: model ?? "" });
  return html`
    <div
      class="chat-composer-neighbor-card chat-composer-neighbor-card--${blocked ? "danger" : "warn"} chat-provider-policy-notice"
      role=${blocked ? "alert" : "status"}
    >
      <span class="chat-composer-neighbor-card__icon" aria-hidden="true"
        >${icons.alertTriangle}</span
      >
      <div class="chat-composer-neighbor-card__copy">
        <strong>${t(`chat.providerPolicy.${notice.state}Title`)}</strong>
        <span>${body}</span>
      </div>
    </div>
  `;
}

function renderPlacementStartupError(
  status: ApplicationPlacementStartupStatus | null | undefined,
  messages: readonly unknown[],
  onRetry?: () => void,
) {
  if (status?.phase !== "failed") {
    return nothing;
  }
  const checking = status.action === "check-delivery";
  const statusError = status.error ?? t("newSession.createFailed");
  const error = checking
    ? [t("chat.queue.checkDeliveryHelp"), status.error].filter(Boolean).join("\n\n")
    : t("newSession.placementStartFailed", { error: statusError });
  const displayStatusError = formatWebUiIconErrorText(statusError);
  const displayError = checking
    ? [t("chat.queue.checkDeliveryHelp"), status.error ? displayStatusError : undefined]
        .filter(Boolean)
        .join("\n\n")
    : t("newSession.placementStartFailed", { error: displayStatusError });
  // History can own the bubble before startup observes its receipt. Keep the
  // banner action reachable when transcript deduplication hides the row.
  const hasInlineTurn =
    status.initialTurn && !findChatSubmissionMessage(messages, status.initialTurn.sendRunId, true);
  const action = status.discardAndReload
    ? html`<button
        class="btn btn--sm danger chat-error__discard"
        type="button"
        @click=${status.discardAndReload}
      >
        ${t("newSession.discardUnsavedAndReload")}
      </button>`
    : status.retryable && onRetry && !hasInlineTurn
      ? html`<button class="btn btn--sm" type="button" @click=${onRetry}>
          ${t(checking ? "chat.queue.checkDelivery" : "common.retry")}
        </button>`
      : nothing;
  return renderChatErrorNotice({ error, action, displayError });
}
