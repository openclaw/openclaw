import { For, Show, createMemo } from "solid-js";
import { handleCopyButton } from "../../../components/copy-button-state.ts";
import { CopyButton } from "../../../components/solid/copy-button.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import { solidContent } from "../../../lit/solid-content.tsx";
import {
  visibleWorkspaceConflictPaths,
  workspaceConflictCount,
  workspaceConflictGitCommands,
  workspaceConflictPathForDisplay,
  type WorkspaceResultConflict,
} from "../workspace-conflict.ts";

function ConflictCopyAction(props: { text: string; label: string }) {
  return (
    <For each={[props.text]}>
      {(text) => (
        <button
          class="btn btn--sm chat-copy-btn"
          type="button"
          onClick={(event) => void handleCopyButton(event, text, props.label)}
        >
          <span data-copy-label>{props.label}</span>
        </button>
      )}
    </For>
  );
}

function RemainingConflictPaths(props: { count: number }) {
  return (
    <Show when={props.count > 0}>
      <div class="chat-workspace-conflict-more">
        {t("chat.workspaceConflict.morePaths", { count: String(props.count) })}
      </div>
    </Show>
  );
}

export function WorkspaceConflictNotice(props: {
  conflict?: WorkspaceResultConflict;
  onDismiss?: () => void;
}) {
  return (
    <Show when={props.conflict}>
      {(conflict) => {
        const count = createMemo(() => workspaceConflictCount(conflict()));
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

export function WorkspaceConflictTranscriptMessage(props: {
  conflict: WorkspaceResultConflict;
  messageKey: string;
  entryId?: string;
}) {
  const count = createMemo(() => workspaceConflictCount(props.conflict));
  const visible = createMemo(() => visibleWorkspaceConflictPaths(props.conflict));
  return (
    <div
      class="chat-bubble chat-bubble--workspace-conflict"
      data-message-id={props.messageKey}
      data-entry-id={props.entryId || undefined}
    >
      <div class="chat-workspace-conflict-event" role="status">
        <div class="chat-workspace-conflict-event__header">
          <span aria-hidden="true">
            <Icon name="alertTriangle" />
          </span>
          <strong>
            {t(
              count() === 1
                ? "chat.workspaceConflict.eventTitleOne"
                : "chat.workspaceConflict.eventTitleMany",
              { count: String(count()) },
            )}
          </strong>
        </div>
        <p>{t("chat.workspaceConflict.eventDescription")}</p>
        <ul class="chat-workspace-conflict-paths">
          <For each={visible().paths}>
            {(entryPath) => (
              <li>
                <code>{workspaceConflictPathForDisplay(entryPath)}</code>
              </li>
            )}
          </For>
        </ul>
        <RemainingConflictPaths count={visible().remaining} />
        <div class="chat-workspace-conflict-ref">
          <span>{t("chat.workspaceConflict.stagedResult")}</span>
          <code>{props.conflict.stagedResultRef}</code>
        </div>
      </div>
    </div>
  );
}

export const renderWorkspaceConflictNotice = (
  props: Parameters<typeof WorkspaceConflictNotice>[0],
) => solidContent(WorkspaceConflictNotice, props);
export function renderWorkspaceConflictTranscriptMessage(
  conflict: WorkspaceResultConflict,
  messageKey: string,
  entryId?: string,
) {
  return solidContent(WorkspaceConflictTranscriptMessage, { conflict, messageKey, entryId });
}
