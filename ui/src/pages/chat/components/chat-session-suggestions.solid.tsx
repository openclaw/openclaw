import { For, Show } from "solid-js";
import type {
  SessionSharingRole,
  SessionSuggestion,
  SessionSuggestionResolution,
} from "../../../../../packages/gateway-protocol/src/index.js";
import { Icon, type IconName } from "../../../components/solid/icon.tsx";
import { t } from "../../../lib/reactive/i18n.ts";

export type ChatSessionSuggestionsProps = {
  suggestions: readonly SessionSuggestion[];
  role?: SessionSharingRole;
  busyIds: ReadonlySet<string>;
  archived: boolean;
  canResolve: boolean;
  onResolve: (suggestion: SessionSuggestion, resolution: SessionSuggestionResolution) => void;
};

const actions: readonly [SessionSuggestionResolution, string, IconName][] = [
  ["send", "sendNow", "arrowUp"],
  ["queue", "queue", "check"],
  ["edit", "edit", "edit"],
  ["dismiss", "dismiss", "trash"],
];

export function ChatSessionSuggestions(props: ChatSessionSuggestionsProps) {
  const canResolve = () => props.canResolve && (props.role === "owner" || props.role === "admin");
  return (
    <Show when={props.suggestions.length > 0}>
      <div class="session-suggestions" aria-live="polite">
        <For each={props.suggestions} keyed={(suggestion) => suggestion.id}>
          {(suggestion) => {
            const author = () => suggestion().author.label ?? suggestion().author.id;
            return (
              <article class="session-suggestion" data-suggestion-id={suggestion().id}>
                <span class="session-suggestion__author">{author()}</span>
                <span class="session-suggestion__text">{suggestion().text}</span>
                <Show
                  when={canResolve() && suggestion().state === "pending"}
                  fallback={
                    <span class="session-suggestion__state">
                      {t(`chat.sessionSuggestions.state.${suggestion().state}`)}
                    </span>
                  }
                >
                  <div class="session-suggestion__actions">
                    <For each={actions}>
                      {(action) => (
                        <Show when={!props.archived || action[0] === "dismiss"}>
                          <button
                            class="btn btn--ghost btn--icon session-suggestion__action"
                            type="button"
                            disabled={props.busyIds.has(suggestion().id)}
                            aria-label={t(`chat.sessionSuggestions.${action[1]}`, {
                              author: author(),
                            })}
                            title={t(`chat.sessionSuggestions.${action[1]}`, { author: author() })}
                            onClick={() => props.onResolve(suggestion(), action[0])}
                          >
                            <Icon name={action[2]} />
                          </button>
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
