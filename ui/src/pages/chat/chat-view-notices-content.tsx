import type { JSX } from "@solidjs/web";
import { For, Show, createMemo, useContext } from "solid-js";
import type {
  SessionPlacementDiskSpace,
  SessionPlacementWorkerRuntimeInstall,
} from "../../../../packages/gateway-protocol/src/schema/session-placement.ts";
import { hasTerminalControl } from "../../../../packages/terminal-core/src/safe-text.js";
import { readRunFailureNotice } from "../../../../src/shared/run-failure-notice.js";
import { shellEscapeBackslash as shellQuote } from "../../../../src/shared/shell-quote.js";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import { handleCopyButton } from "../../components/copy-button-state.ts";
import { formatWebUiIconErrorText } from "../../components/error-presentation.ts";
import { CopyButton } from "../../components/solid/copy-button.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { registerChatComposerEnglish } from "../../i18n/locales/en-chat-composer.ts";
import { registerChatSessionOptionalEnglish } from "../../i18n/locales/en-chat-session-optional.ts";
import { registerNewSessionRuntimeEnglish } from "../../i18n/locales/en-new-session-runtime.ts";
import { formatBytes } from "../../lib/agents/display.ts";
import { findChatSubmissionMessage } from "../../lib/chat/history-message-identity.ts";
import { clampText } from "../../lib/format.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { isChatSendReconnecting } from "./chat-send-presentation.ts";
import type { ChatComposerNoticesProps, ChatViewNoticesProps } from "./chat-view-notices.tsx";
import { ChatGPTUsageLimit } from "./chatgpt-usage-limit.tsx";
import { ChatConversationMobile } from "./components/chat-conversation-presentation.ts";
import { ChatSendStatus } from "./components/chat-message-send-status-view.tsx";
import { RemainingConflictPaths } from "./components/chat-workspace-conflict.tsx";
import type { ProviderPolicyNotice } from "./tool-stream-contract.ts";
import {
  visibleWorkspaceConflictPaths,
  workspaceConflictCount,
  workspaceConflictPathForDisplay,
  type WorkspaceResultConflict,
} from "./workspace-conflict.ts";

registerEnglishCatalog(registerChatSessionOptionalEnglish);
registerEnglishCatalog(registerChatComposerEnglish);

registerNewSessionRuntimeEnglish();

function workspaceConflictGitCommands(
  conflict: WorkspaceResultConflict,
  requestedPath?: string,
):
  | {
      inspect: string;
      takeCloud: string;
    }
  | undefined {
  const entryPath =
    requestedPath === undefined
      ? conflict.paths.find((candidate) => !hasTerminalControl(candidate))
      : conflict.paths.includes(requestedPath) && !hasTerminalControl(requestedPath)
        ? requestedPath
        : undefined;
  if (!entryPath) {
    return undefined;
  }
  const stagedPath = shellQuote(`${conflict.stagedResultRef}:${entryPath}`);
  const stagedRef = shellQuote(conflict.stagedResultRef);
  const literalPathspec = shellQuote(`:(top,literal)${entryPath}`);
  return {
    inspect: `git show ${stagedPath}`,
    takeCloud: `git checkout ${stagedRef} -- ${literalPathspec}`,
  };
}

function ConflictCopyAction(props: { text: string; label: string }) {
  return (
    <For each={[props.text]}>
      {(text) => {
        let label!: HTMLSpanElement;
        return (
          <button
            class="btn btn--sm chat-copy-btn"
            type="button"
            onClick={(event) => void handleCopyButton(event, text, props.label, { label })}
          >
            <span ref={(element) => (label = element)} data-copy-label>
              {props.label}
            </span>
          </button>
        );
      }}
    </For>
  );
}

function WorkspaceConflictNotice(props: {
  conflict?: WorkspaceResultConflict;
  onDismiss?: () => void;
}) {
  return (
    <Show when={props.conflict}>
      {(conflict) => {
        const count = () => workspaceConflictCount(conflict());
        const visible = createMemo(() => visibleWorkspaceConflictPaths(conflict()));
        const commands = createMemo(() => workspaceConflictGitCommands(conflict()));
        return (
          <details
            class="chat-composer-neighbor-card chat-composer-neighbor-card--warn chat-workspace-conflict-notice"
            role="status"
          >
            <summary class="chat-workspace-conflict-notice__summary">
              <span class="chat-composer-neighbor-card__icon" aria-hidden="true">
                <Icon name="alertTriangle" />
              </span>
              <span class="chat-composer-neighbor-card__copy">
                <strong>
                  {t(
                    count() === 1
                      ? "chat.workspaceConflict.titleOne"
                      : "chat.workspaceConflict.titleMany",
                    { count: String(count()) },
                  )}
                </strong>
                <span>{t("chat.workspaceConflict.summary")}</span>
              </span>
              <span class="chat-workspace-conflict-notice__chevron" aria-hidden="true">
                <Icon name="chevronUp" />
              </span>
              <Show when={props.onDismiss}>
                <button
                  class="chat-error__dismiss"
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    props.onDismiss?.();
                  }}
                  aria-label={t("chat.workspaceConflict.dismiss")}
                >
                  <Icon name="x" />
                </button>
              </Show>
            </summary>
            <div class="chat-workspace-conflict-notice__content">
              <ul class="chat-workspace-conflict-paths">
                <For each={visible().paths}>
                  {(entryPath) => (
                    <li>
                      <code>{workspaceConflictPathForDisplay(entryPath)}</code>
                      <Show when={workspaceConflictGitCommands(conflict(), entryPath)}>
                        {(entryCommands) => (
                          <span class="chat-workspace-conflict-path-actions">
                            <ConflictCopyAction
                              text={entryCommands().inspect}
                              label={t("chat.workspaceConflict.inspectCloud")}
                            />
                            <ConflictCopyAction
                              text={entryCommands().takeCloud}
                              label={t("chat.workspaceConflict.takeCloud")}
                            />
                          </span>
                        )}
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
              <RemainingConflictPaths count={visible().remaining} />
              <details class="chat-workspace-conflict-commands-disclosure">
                <summary>{t("chat.workspaceConflict.showCommands")}</summary>
                <div class="chat-workspace-conflict-ref">
                  <span>{t("chat.workspaceConflict.stagedResult")}</span>
                  <code>{conflict().stagedResultRef}</code>
                  <CopyButton
                    text={conflict().stagedResultRef}
                    idleLabel={t("chat.workspaceConflict.copyStagedResult")}
                  />
                </div>
                <Show
                  when={commands()}
                  fallback={
                    <p class="chat-workspace-conflict-command-help">
                      {t("chat.workspaceConflict.commandsUnavailable")}
                    </p>
                  }
                >
                  {(command) => (
                    <>
                      <div class="chat-workspace-conflict-commands">
                        <For
                          each={
                            [
                              [command().inspect, "inspectCloud", "copyInspectCommand"],
                              [command().takeCloud, "takeCloud", "copyTakeCommand"],
                            ] as const
                          }
                          keyed={(entry) => entry[1]}
                        >
                          {(entry) => (
                            <div>
                              <span>{t(`chat.workspaceConflict.${entry()[1]}`)}</span>
                              <code>{entry()[0]}</code>
                              <CopyButton
                                text={entry()[0]}
                                idleLabel={t(`chat.workspaceConflict.${entry()[2]}`)}
                              />
                            </div>
                          )}
                        </For>
                      </div>
                      <p class="chat-workspace-conflict-command-help">
                        {t("chat.workspaceConflict.commandHelp")}
                      </p>
                    </>
                  )}
                </Show>
              </details>
            </div>
          </details>
        );
      }}
    </Show>
  );
}

function StatusNotice(props: {
  class: string;
  tone: "info" | "warn" | "danger";
  title: string;
  body: string;
  tooltip?: string;
}) {
  return (
    <div
      class={[
        "chat-composer-neighbor-card",
        `chat-composer-neighbor-card--${props.tone}`,
        props.class,
      ]}
      role={props.tone === "danger" ? "alert" : "status"}
      title={props.tooltip}
    >
      <span class="chat-composer-neighbor-card__icon" aria-hidden="true">
        <Icon name={props.tone === "info" ? "info" : "alertTriangle"} />
      </span>
      <div class="chat-composer-neighbor-card__copy">
        <strong>{props.title}</strong>
        <span>{props.body}</span>
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
  return (
    <StatusNotice
      class="chat-cloud-disk-space-notice"
      tone={critical ? "danger" : "warn"}
      title={t(critical ? "chat.diskSpace.criticalTitle" : "chat.diskSpace.warningTitle")}
      body={t(critical ? "chat.diskSpace.criticalBody" : "chat.diskSpace.warningBody", {
        percent: String(usedPercent),
        free: formatBytes(diskSpace.availableBytes),
      })}
    />
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
  return (
    <StatusNotice
      class="chat-worker-runtime-install-notice"
      tone="info"
      title={
        installing
          ? t("chat.workerRuntimeInstall.installingTitle")
          : t("chat.workerRuntimeInstall.transferringTitle", progress)
      }
      body={body}
      tooltip={body}
    />
  );
}

function ChatErrorNotice(props: {
  error: string;
  action?: JSX.Element;
  displayError?: string;
  tone?: "danger" | "warn";
  summary?: string;
  compact?: boolean;
  actionAvailable?: boolean;
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
    <Show
      when={props.compact}
      fallback={
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
      }
    >
      <div
        class={[
          "chat-composer-neighbor-card",
          `chat-composer-neighbor-card--${tone()}`,
          "chat-error chat-error--mobile",
          { "chat-error--with-action": props.actionAvailable },
        ]}
        role={tone() === "warn" ? "status" : "alert"}
      >
        <Show
          when={hasDetails()}
          fallback={
            <div class="chat-error__mobile-header">
              <Icon name="alertTriangle" />
              <span class="chat-error__mobile-title">{title()}</span>
              {props.action}
            </div>
          }
        >
          <details
            class="chat-error__mobile-disclosure"
            onPointerDown={(event) => {
              event.currentTarget.dataset.disclosureInput = "pointer";
            }}
            onKeyDown={(event) => {
              event.currentTarget.dataset.disclosureInput = "keyboard";
            }}
          >
            <summary class="chat-error__mobile-header">
              <Icon name="alertTriangle" />
              <span class="chat-error__mobile-title">
                {title()}
                <span class="chat-error__mobile-chevron" aria-hidden="true">
                  <Icon name="chevronRight" />
                </span>
              </span>
              {props.action}
            </summary>
            <div class="chat-error__mobile-details">
              <pre tabindex={0} aria-label={t("chat.errorDetails")}>
                {displayError()}
              </pre>
              <CopyButton text={props.error} idleLabel={t("chat.copyError")} bare />
            </div>
          </details>
        </Show>
      </div>
    </Show>
  );
}

export function ChatTopbarNoticesContent(props: ChatViewNoticesProps) {
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
    <>
      {renderDiskSpaceNotice(props.diskSpace)}
      {renderWorkerRuntimeInstallNotice(props.workerRuntimeInstall)}
      <Show when={props.error}>
        {(error) => <ChatErrorNotice error={error()} action={dismiss} />}
      </Show>
    </>
  );
}

export function ChatComposerNoticesContent(props: ChatComposerNoticesProps) {
  const mobile = useContext(ChatConversationMobile);
  const hasTranscriptFailure = () =>
    Boolean(
      props.runError?.runId &&
      props.messages.some(
        (message) => readRunFailureNotice(message)?.runId === props.runError?.runId,
      ),
    );
  const contention = () => props.runError?.kind === "state_contention";
  const usageLimit = (): "business" | "consumer" | undefined =>
    props.runError?.kind === "chatgpt_business_usage_limit"
      ? "business"
      : props.runError?.kind === "chatgpt_consumer_usage_limit"
        ? "consumer"
        : undefined;
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
      <Show when={props.providerPolicyNotice}>
        {(notice) => <ProviderPolicyNoticeView notice={notice()} />}
      </Show>
      <Show when={usageLimit()}>
        {(kind) => (
          <For each={[`${props.sessionKey}:${props.runError?.runId}:${kind()}`]}>
            {() => <ChatGPTUsageLimit kind={kind()} presented={props.presented ?? true} />}
          </For>
        )}
      </Show>
      <Show when={!hasTranscriptFailure() && !usageLimit() && props.runError}>
        {(error) => (
          <>
            <ChatErrorNotice
              error={error().summary}
              action={refresh}
              compact={mobile()}
              actionAvailable={Boolean(props.onRefresh)}
              tone={contention() ? "warn" : "danger"}
              summary={
                error().kind === "stop"
                  ? undefined
                  : t(
                      contention()
                        ? "chat.errorBusySummary"
                        : error().kind === "auth_refresh"
                          ? "chat.errorSignInSummary"
                          : mobile()
                            ? "chat.errorReplyTitle"
                            : "chat.errorReplySummary",
                    )
              }
            />
          </>
        )}
      </Show>
      <Show when={props.workspaceConflict}>
        <WorkspaceConflictNotice
          conflict={props.workspaceConflict ?? undefined}
          onDismiss={props.onDismissWorkspaceConflict}
        />
      </Show>
    </>
  );
}

function ProviderPolicyNoticeView(props: { notice: ProviderPolicyNotice }) {
  const blocked = () => props.notice.state === "blocked" || props.notice.state === "unavailable";
  const model = () => props.notice.fallbackModel ?? props.notice.model;
  const namesModel = () => props.notice.state !== "buffering" && props.notice.state !== "blocked";
  const body = () =>
    namesModel() && !model()
      ? t("chat.providerPolicy.fallbackUnknownBody")
      : t(`chat.providerPolicy.${props.notice.state}Body`, { model: model() ?? "" });
  return (
    <StatusNotice
      class="chat-provider-policy-notice"
      tone={blocked() ? "danger" : "warn"}
      title={t(`chat.providerPolicy.${props.notice.state}Title`)}
      body={body()}
    />
  );
}

export function ChatPlacementStartupNotice(props: {
  status: ApplicationPlacementStartupStatus | null | undefined;
  messages: readonly unknown[];
  connected?: boolean;
  onRetry?: () => void;
  onDiscard?: () => void;
}) {
  const statusError = () => props.status?.error ?? t("newSession.createFailed");
  const error = () => t("newSession.placementStartFailed", { error: statusError() });
  const displayStatusError = () => formatWebUiIconErrorText(statusError());
  const displayError = () => t("newSession.placementStartFailed", { error: displayStatusError() });
  // History can own the bubble before startup observes its receipt. Keep the
  // notice actions reachable when transcript deduplication hides the row.
  const hasInlineTurn = () => {
    const initialTurn = props.status?.initialTurn;
    return initialTurn && !findChatSubmissionMessage(props.messages, initialTurn.sendRunId, true);
  };
  return (
    <>
      <Show
        when={
          props.status?.phase !== "failed" &&
          !hasInlineTurn() &&
          isChatSendReconnecting(props.status?.initialTurn?.sendState, props.connected) &&
          props.status?.initialTurn
        }
      >
        {(turn) => (
          <div class="chat-composer-neighbor-card chat-composer-neighbor-card--info" role="status">
            <span class="chat-composer-neighbor-card__icon" aria-hidden="true">
              <Icon name="info" />
            </span>
            <div class="chat-composer-neighbor-card__copy">
              <ChatSendStatus
                status={{
                  id: turn().id,
                  state: "waiting-reconnect",
                  error: turn().sendError,
                }}
                actions={{
                  connected: props.connected,
                  queuedMessageAction: { id: turn().id, onDiscard: props.onDiscard },
                }}
              />
            </div>
          </div>
        )}
      </Show>
      <Show when={props.status?.phase === "failed"}>
        <ChatErrorNotice
          error={error()}
          action={
            <Show
              when={props.status?.discardAndReload}
              fallback={
                <span class="row">
                  <Show when={props.status?.retryable && props.onRetry && !hasInlineTurn()}>
                    <button class="btn btn--sm" type="button" onClick={() => props.onRetry?.()}>
                      {t("common.retry")}
                    </button>
                  </Show>
                  <Show when={props.onDiscard && !hasInlineTurn()}>
                    <button
                      class="btn btn--sm"
                      type="button"
                      title={t("chat.queue.discardPendingMessage")}
                      onClick={() => props.onDiscard?.()}
                    >
                      {t("chat.queue.discard")}
                    </button>
                  </Show>
                </span>
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
          summary={props.status?.discardAndReload ? displayError() : t("chat.errorStartSummary")}
        />
      </Show>
    </>
  );
}
