import { For, Show, createMemo } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatSessionEnglish } from "../../../i18n/locales/en-chat-session.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import {
  visibleWorkspaceConflictPaths,
  workspaceConflictCount,
  workspaceConflictPathForDisplay,
  type WorkspaceResultConflict,
} from "../workspace-conflict.ts";

registerEnglishCatalog(registerChatSessionEnglish);

export function RemainingConflictPaths(props: { count: number }) {
  return (
    <Show when={props.count > 0}>
      <div class="chat-workspace-conflict-more">
        {t("chat.workspaceConflict.morePaths", { count: String(props.count) })}
      </div>
    </Show>
  );
}

export function WorkspaceConflictTranscriptMessage(props: {
  conflict: WorkspaceResultConflict;
  messageKey: string;
  entryId?: string;
  ref?: (element: HTMLDivElement) => void;
}) {
  const count = () => workspaceConflictCount(props.conflict);
  const visible = createMemo(() => visibleWorkspaceConflictPaths(props.conflict));
  return (
    <div
      ref={props.ref}
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
