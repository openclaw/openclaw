import { html, nothing, type TemplateResult } from "lit";
import type {
  SessionPlacementDiskSpace,
  SessionPlacementWorkerRuntimeInstall,
} from "../../../../packages/gateway-protocol/src/schema/session-placement.ts";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import { renderCopyButton } from "../../components/copy-button.ts";
import { formatWebUiIconErrorText } from "../../components/error-presentation.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { formatBytes } from "../../lib/agents/display.ts";
import { findChatSubmissionMessage } from "../../lib/chat/history-message-identity.ts";
import { clampText } from "../../lib/format.ts";
import type { SubagentRoster, SubagentRowContext } from "./chat-spawned-subagent.ts";
import "./components/chat-child-attention.ts";
import { renderWorkspaceConflictNotice } from "./components/chat-workspace-conflict.ts";
import type { ChatRunError } from "./run-lifecycle.ts";
import type { ProviderPolicyNotice } from "./tool-stream-contract.ts";
import type { WorkspaceResultConflict } from "./workspace-conflict.ts";

registerNewSessionSetupEnglish();

export type ChatPlacementStartupNoticeProps = {
  placementStartup?: ApplicationPlacementStartupStatus | null;
  onRetrySessionPlacementStartup?: () => void;
};

type ChatViewNoticesProps = {
  diskSpace?: SessionPlacementDiskSpace;
  workerRuntimeInstall?: SessionPlacementWorkerRuntimeInstall;
  error?: string | null;
  onDismissError?: () => void;
};

type ChatComposerNoticesProps = ChatPlacementStartupNoticeProps &
  SubagentRowContext &
  Pick<SubagentRoster, "subagentSessionsRead"> & {
    sessionKey?: string;
    onSessionSelect?: (key: string) => void;
    connected?: boolean;
    messages: readonly unknown[];
    providerPolicyNotice?: ProviderPolicyNotice | null;
    providerReviewNotice?: TemplateResult | typeof nothing;
    runError?: ChatRunError | null;
    onRefresh?: () => void;
    onDismissWorkspaceConflict?: () => void;
    workspaceConflict?: WorkspaceResultConflict | null;
  };

function renderStatusNotice(
  className: string,
  tone: "info" | "warn" | "danger",
  title: string,
  body: string,
  tooltip: string | typeof nothing = nothing,
) {
  return html`
    <div
      class="chat-composer-neighbor-card chat-composer-neighbor-card--${tone} ${className}"
      role=${tone === "danger" ? "alert" : "status"}
      title=${tooltip}
    >
      <span class="chat-composer-neighbor-card__icon" aria-hidden="true"
        >${tone === "info" ? icons.info : icons.alertTriangle}</span
      >
      <div class="chat-composer-neighbor-card__copy">
        <strong>${title}</strong>
        <span>${body}</span>
      </div>
    </div>
  `;
}

function renderDiskSpaceNotice(diskSpace: SessionPlacementDiskSpace | undefined) {
  if (!diskSpace || diskSpace.status === "ok") {
    return nothing;
  }
  const usedPercent =
    diskSpace.totalBytes > 0
      ? Math.round(((diskSpace.totalBytes - diskSpace.availableBytes) / diskSpace.totalBytes) * 100)
      : 0;
  const critical = diskSpace.status === "critical";
  return renderStatusNotice(
    "chat-cloud-disk-space-notice",
    critical ? "danger" : "warn",
    t(critical ? "chat.diskSpace.criticalTitle" : "chat.diskSpace.warningTitle"),
    t(critical ? "chat.diskSpace.criticalBody" : "chat.diskSpace.warningBody", {
      percent: String(usedPercent),
      free: formatBytes(diskSpace.availableBytes),
    }),
  );
}

function renderWorkerRuntimeInstallNotice(
  install: SessionPlacementWorkerRuntimeInstall | undefined,
) {
  if (!install) {
    return nothing;
  }
  const progress = {
    transferred: formatBytes(install.transferredBytes),
    total: formatBytes(install.totalBytes),
    percent: String(Math.round((install.transferredBytes / install.totalBytes) * 100)),
  };
  const installing = install.phase === "installing";
  const body = installing
    ? t("chat.workerRuntimeInstall.installingBody")
    : t("chat.workerRuntimeInstall.transferringBody", progress);
  // Topbar notices render as compact pills that hide the body, so the title carries progress.
  return renderStatusNotice(
    "chat-worker-runtime-install-notice",
    "info",
    installing
      ? t("chat.workerRuntimeInstall.installingTitle")
      : t("chat.workerRuntimeInstall.transferringTitle", progress),
    body,
    body,
  );
}

function renderErrorNotice(
  error: string,
  action: TemplateResult | typeof nothing = nothing,
  displayError = formatWebUiIconErrorText(error),
  tone: "danger" | "warn" = "danger",
  summary?: string,
) {
  const lines = displayError
    .trim()
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim());
  // Local action errors already contain recovery instructions; keep those visible.
  const title = summary ?? clampText(lines[0] ?? "");
  const hasDetails = lines.some((line) => line !== "" && line !== title);
  return html`
    <div
      class="chat-composer-neighbor-card chat-composer-neighbor-card--${tone} chat-error"
      role=${tone === "warn" ? "status" : "alert"}
    >
      <span class="chat-composer-neighbor-card__icon" aria-hidden="true"
        >${icons.alertTriangle}</span
      >
      ${
        hasDetails
          ? html`<details class="chat-error__content">
              <summary class="chat-error__summary">
                <strong>${title}</strong>
                <span>${t("chat.details")}</span>
                <span class="chat-error__chevron" aria-hidden="true">${icons.chevronDown}</span>
                ${renderCopyButton(error, t("chat.copyError"))}
              </summary>
              <pre class="chat-error__diagnostic" tabindex="0" aria-label=${t("chat.errorDetails")}>
${displayError}</pre>
            </details>`
          : html`<span class="chat-error__content"
              ><strong>${title}</strong>${renderCopyButton(error, t("chat.copyError"))}</span
            >`
      }
      ${action}
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
      ${renderWorkerRuntimeInstallNotice(props.workerRuntimeInstall)}
      ${props.error ? renderErrorNotice(props.error, dismiss) : nothing}
    </div>
  `;
}

export function renderChatComposerNotices(props: ChatComposerNoticesProps) {
  const contention = props.runError?.kind === "state_contention";
  const refresh = props.onRefresh
    ? html`<button
        class="btn btn--sm chat-error__refresh"
        type="button"
        ?disabled=${!props.connected}
        @click=${props.onRefresh}
      >
        ${t(contention ? "chat.checkStatus" : "common.refresh")}
      </button>`
    : nothing;
  return html`
    ${
      // Seeded rows can name children the gateway no longer links; wait for its child read.
      props.subagentParentKey && props.subagentSessionsRead
        ? html`<openclaw-chat-child-attention
            .sessionKey=${props.subagentParentKey}
            .sessions=${props.subagentSessions ?? []}
            .onOpenSubagent=${props.onOpenSubagent}
            .onOpenSession=${props.onSessionSelect}
          ></openclaw-chat-child-attention>`
        : nothing
    }
    ${props.providerReviewNotice ?? nothing}
    ${renderProviderPolicyNotice(props.providerPolicyNotice)}
    ${props.runError ? renderErrorNotice(props.runError.summary, refresh, undefined, contention ? "warn" : "danger", props.runError.kind === "stop" ? undefined : t(contention ? "chat.errorBusySummary" : props.runError.kind === "auth_refresh" ? "chat.errorSignInSummary" : "chat.errorReplySummary")) : nothing}
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
  return renderStatusNotice(
    "chat-provider-policy-notice",
    blocked ? "danger" : "warn",
    t(`chat.providerPolicy.${notice.state}Title`),
    body,
  );
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
  return renderErrorNotice(
    error,
    action,
    displayError,
    "danger",
    checking
      ? t("chat.queue.checkDeliveryHelp")
      : status.discardAndReload
        ? displayError
        : t("chat.errorStartSummary"),
  );
}
