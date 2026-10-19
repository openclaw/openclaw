import type { JSX } from "@solidjs/web";
import { createMemo, Show } from "solid-js";
import type {
  SessionPlacementDiskSpace,
  SessionPlacementWorkerRuntimeInstall,
} from "../../../../packages/gateway-protocol/src/schema/session-placement.ts";
import { readRunFailureNotice } from "../../../../src/shared/run-failure-notice.js";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import { formatWebUiIconErrorText } from "../../components/error-presentation.ts";
import { CopyButton } from "../../components/solid/copy-button.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import { formatBytes } from "../../lib/agents/display.ts";
import { findChatSubmissionMessage } from "../../lib/chat/history-message-identity.ts";
import { clampText } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import {
  ChatProviderReviewNotice,
  type ChatProviderReviewOwner,
} from "./chat-provider-review-controller.tsx";
import type { SubagentRoster, SubagentRowContext } from "./chat-spawned-subagent.ts";
import { ChatChildAttention } from "./components/chat-child-attention.tsx";
import { WorkspaceConflictNotice } from "./components/chat-workspace-conflict.tsx";
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
    // Resolve after the first pane frame prepares the Solid owner's permission facts.
    readProviderReview?: () => ChatProviderReviewOwner;
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
  tooltip?: string,
) {
  return (
    <div
      class={["chat-composer-neighbor-card", `chat-composer-neighbor-card--${tone}`, className]}
      role={tone === "danger" ? "alert" : "status"}
      title={tooltip}
    >
      <span class="chat-composer-neighbor-card__icon" aria-hidden="true">
        <Icon name={tone === "info" ? "info" : "alertTriangle"} />
      </span>
      <div class="chat-composer-neighbor-card__copy">
        <strong>{title}</strong>
        <span>{body}</span>
      </div>
    </div>
  );
}

function renderDiskSpaceNotice(diskSpace: SessionPlacementDiskSpace | undefined) {
  if (!diskSpace || diskSpace.status === "ok") {
    return undefined;
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
    return undefined;
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

function ChatErrorNotice(props: {
  error: string;
  action?: JSX.Element;
  displayError?: string;
  tone?: "danger" | "warn";
  summary?: string;
}) {
  const displayError = () => props.displayError ?? formatWebUiIconErrorText(props.error);
  const lines = () =>
    displayError()
      .trim()
      .split(/\r?\n/u)
      .map((line) => line.replace(/\s+/gu, " ").trim());
  // Local action errors already contain recovery instructions; keep those visible.
  const title = () => props.summary ?? clampText(lines()[0] ?? "");
  const hasDetails = () => lines().some((line) => line !== "" && line !== title());
  const tone = () => props.tone ?? "danger";
  return (
    <div
      class={[
        "chat-composer-neighbor-card",
        `chat-composer-neighbor-card--${tone()}`,
        "chat-error",
      ]}
      role={tone() === "warn" ? "status" : "alert"}
    >
      <span class="chat-composer-neighbor-card__icon" aria-hidden="true">
        <Icon name="alertTriangle" />
      </span>
      <Show
        when={hasDetails()}
        fallback={
          <span class="chat-error__content">
            <strong>{title()}</strong>
            <CopyButton text={props.error} idleLabel={t("chat.copyError")} />
          </span>
        }
      >
        <details class="chat-error__content">
          <summary class="chat-error__summary">
            <strong>{title()}</strong>
            <span>{t("chat.details")}</span>
            <span class="chat-error__chevron" aria-hidden="true">
              <Icon name="chevronDown" />
            </span>
            <CopyButton text={props.error} idleLabel={t("chat.copyError")} />
          </summary>
          <pre class="chat-error__diagnostic" tabindex={0} aria-label={t("chat.errorDetails")}>
            {displayError()}
          </pre>
        </details>
      </Show>
      {props.action}
    </div>
  );
}

export function renderChatTopbarNotices(props: ChatViewNoticesProps) {
  const dismiss = (
    <Show when={props.onDismissError}>
      <openclaw-tooltip prop:content={t("chat.actions.dismissError")}>
        <button
          class="chat-error__dismiss"
          type="button"
          onClick={() => props.onDismissError?.()}
          aria-label={t("chat.actions.dismissError")}
        >
          <Icon name="x" />
        </button>
      </openclaw-tooltip>
    </Show>
  );
  return (
    <div class="chat-topbar-notices">
      {renderDiskSpaceNotice(props.diskSpace)}
      {renderWorkerRuntimeInstallNotice(props.workerRuntimeInstall)}
      <Show when={props.error}>
        {(error) => <ChatErrorNotice error={error()} action={dismiss} />}
      </Show>
    </div>
  );
}

export function renderChatComposerNotices(props: ChatComposerNoticesProps) {
  // Unrelated pane publications must not replace a visible provider notice.
  const providerPolicyNotice = createMemo(() => props.providerPolicyNotice);
  const hasTranscriptFailure = () =>
    Boolean(
      props.runError?.runId &&
      props.messages.some(
        (message) => readRunFailureNotice(message)?.runId === props.runError?.runId,
      ),
    );
  const contention = () => props.runError?.kind === "state_contention";
  const refresh = (
    <Show when={props.onRefresh}>
      <button
        class="btn btn--sm chat-error__refresh"
        type="button"
        disabled={!props.connected}
        onClick={() => props.onRefresh?.()}
      >
        {t(contention() ? "chat.checkStatus" : "common.refresh")}
      </button>
    </Show>
  );
  return (
    <>
      {/* Seeded rows can name children the gateway no longer links; wait for its child read. */}
      <Show when={props.subagentParentKey && props.subagentSessionsRead}>
        <ChatChildAttention
          sessionKey={props.subagentParentKey ?? ""}
          sessions={props.subagentSessions ?? []}
          onOpenSubagent={props.onOpenSubagent}
          onOpenSession={props.onSessionSelect}
        />
      </Show>
      <Show when={props.readProviderReview?.()}>
        {(owner) => <ChatProviderReviewNotice owner={owner()} />}
      </Show>
      {renderProviderPolicyNotice(providerPolicyNotice())}
      <Show when={!hasTranscriptFailure() && props.runError}>
        {(error) => (
          <>
            <ChatErrorNotice
              error={error().summary}
              action={refresh}
              tone={contention() ? "warn" : "danger"}
              summary={
                error().kind === "stop"
                  ? undefined
                  : t(
                      contention()
                        ? "chat.errorBusySummary"
                        : error().kind === "auth_refresh"
                          ? "chat.errorSignInSummary"
                          : "chat.errorReplySummary",
                    )
              }
            />
          </>
        )}
      </Show>
      <WorkspaceConflictNotice
        conflict={props.workspaceConflict ?? undefined}
        onDismiss={props.onDismissWorkspaceConflict}
      />
      <ChatPlacementStartupError
        status={props.placementStartup}
        messages={props.messages}
        onRetry={props.onRetrySessionPlacementStartup}
      />
    </>
  );
}

function renderProviderPolicyNotice(notice: ProviderPolicyNotice | null | undefined) {
  if (!notice) {
    return undefined;
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

function ChatPlacementStartupError(props: {
  status: ApplicationPlacementStartupStatus | null | undefined;
  messages: readonly unknown[];
  onRetry?: () => void;
}) {
  const checking = () => props.status?.action === "check-delivery";
  const statusError = () => props.status?.error ?? t("newSession.createFailed");
  const error = () =>
    checking()
      ? [t("chat.queue.checkDeliveryHelp"), props.status?.error].filter(Boolean).join("\n\n")
      : t("newSession.placementStartFailed", { error: statusError() });
  const displayStatusError = () => formatWebUiIconErrorText(statusError());
  const displayError = () =>
    checking()
      ? [t("chat.queue.checkDeliveryHelp"), props.status?.error ? displayStatusError() : undefined]
          .filter(Boolean)
          .join("\n\n")
      : t("newSession.placementStartFailed", { error: displayStatusError() });
  // History can own the bubble before startup observes its receipt. Keep the
  // banner action reachable when transcript deduplication hides the row.
  const hasInlineTurn = () => {
    const initialTurn = props.status?.initialTurn;
    return initialTurn && !findChatSubmissionMessage(props.messages, initialTurn.sendRunId, true);
  };
  return (
    <Show when={props.status?.phase === "failed"}>
      <ChatErrorNotice
        error={error()}
        action={
          <Show
            when={props.status?.discardAndReload}
            fallback={
              <Show when={props.status?.retryable && props.onRetry && !hasInlineTurn()}>
                <button class="btn btn--sm" type="button" onClick={() => props.onRetry?.()}>
                  {t(checking() ? "chat.queue.checkDelivery" : "common.retry")}
                </button>
              </Show>
            }
          >
            <button
              class="btn btn--sm danger chat-error__discard"
              type="button"
              onClick={() => props.status?.discardAndReload?.()}
            >
              {t("newSession.discardUnsavedAndReload")}
            </button>
          </Show>
        }
        displayError={displayError()}
        summary={
          checking()
            ? t("chat.queue.checkDeliveryHelp")
            : props.status?.discardAndReload
              ? displayError()
              : t("chat.errorStartSummary")
        }
      />
    </Show>
  );
}
