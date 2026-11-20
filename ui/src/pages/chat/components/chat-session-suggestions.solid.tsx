import { createMemo, For, Show } from "solid-js";
import type {
  SessionSharingRole,
  SessionSuggestion,
  SessionSuggestionResolution,
} from "../../../../../packages/gateway-protocol/src/index.js";
import { IconButton } from "../../../components/solid/icon-button.tsx";
import type { IconName } from "../../../components/solid/icon.tsx";
import { registerChatSessionSharingEnglish } from "../../../i18n/locales/en-chat-session-sharing.ts";
import { findChatSubmissionMessage } from "../../../lib/chat/history-message-identity.ts";
import { t, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";

registerEnglishCatalog(registerChatSessionSharingEnglish);

const actions: readonly [SessionSuggestionResolution, string, IconName][] = [
  ["send", "sendNow", "arrowUp"],
  ["queue", "queue", "check"],
  ["edit", "edit", "edit"],
  ["dismiss", "dismiss", "trash"],
];

export function ChatSessionSuggestions(props: {
  suggestions: readonly SessionSuggestion[];
  role?: SessionSharingRole;
  busyIds: ReadonlySet<string>;
  archived: boolean;
  onClose?: (id: string) => void;
  liveResolutions?: ReadonlyMap<string, boolean>;
  messages?: readonly unknown[];
  canResolve: boolean;
  onResolve?: (suggestion: SessionSuggestion, resolution: SessionSuggestionResolution) => void;
}) {
  const canResolve = () => props.canResolve && (props.role === "owner" || props.role === "admin");
  const visible = createMemo(() =>
    props.suggestions.filter(
      (suggestion) =>
        props.role === "owner" ||
        props.role === "admin" ||
        suggestion.state === "pending" ||
        (props.liveResolutions?.get(suggestion.id) === true &&
          (suggestion.state !== "accepted" ||
            !findChatSubmissionMessage(
              props.messages,
              `session-suggestion:${suggestion.id}`,
              true,
            ))),
    ),
  );

  return (
    <Show when={visible().length > 0}>
      <div class="session-suggestions" aria-live="polite">
        <For each={visible()} keyed={(suggestion) => suggestion.id}>
          {(suggestion) => {
            const author = () => suggestion().author.label ?? suggestion().author.id;
            return (
              <article class="session-suggestion" data-suggestion-id={suggestion().id}>
                <span class="session-suggestion__author">{author()}</span>
                <span class="session-suggestion__text">{suggestion().text}</span>
                <Show
                  when={canResolve() && suggestion().state === "pending"}
                  fallback={
                    <div class="session-suggestion__actions">
                      {" "}
                      <span class="session-suggestion__state">
                        {t(`chat.sessionSuggestions.state.${suggestion().state}`)}
                      </span>{" "}
                      <Show
                        when={
                          props.role !== "owner" &&
                          props.role !== "admin" &&
                          suggestion().state === "dismissed"
                        }
                      >
                        <IconButton
                          size={28}
                          glyph="row"
                          icon="x"
                          label={t("common.close")}
                          onClick={() => props.onClose?.(suggestion().id)}
                        />
                      </Show>
                    </div>
                  }
                >
                  <div class="session-suggestion__actions">
                    <For each={actions}>
                      {(action) => (
                        <Show when={!props.archived || action[0] === "dismiss"}>
                          <IconButton
                            size={28}
                            glyph="row"
                            class="session-suggestion__action"
                            icon={action[2]}
                            label={t(`chat.sessionSuggestions.${action[1]}`, {
                              author: author(),
                            })}
                            tooltip={t(`chat.sessionSuggestions.${action[1]}`, {
                              author: author(),
                            })}
                            disabled={props.busyIds.has(suggestion().id)}
                            onClick={() => props.onResolve?.(suggestion(), action[0])}
                          />
                        </Show>
                      )}
                    </For>
                  </div>
                </Show>
              </article>
            );
          }}
        </For>
      </div>
    </Show>
  );
}
