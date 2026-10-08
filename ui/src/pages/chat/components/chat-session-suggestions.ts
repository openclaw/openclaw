import { html, nothing } from "lit";
import type {
  SessionSharingRole,
  SessionSuggestion,
  SessionSuggestionResolution,
} from "../../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";

export function renderChatSessionSuggestions(props: {
  suggestions: readonly SessionSuggestion[];
  role?: SessionSharingRole;
  busyIds: ReadonlySet<string>;
  archived: boolean;
  canResolve: boolean;
  onResolve: (suggestion: SessionSuggestion, resolution: SessionSuggestionResolution) => void;
}) {
  if (props.suggestions.length === 0) {
    return nothing;
  }
  const canResolve = props.canResolve && (props.role === "owner" || props.role === "admin");
  return html`
    <div class="session-suggestions" aria-live="polite">
      ${props.suggestions.map((suggestion) => {
        const busy = props.busyIds.has(suggestion.id);
        const author = suggestion.author.label ?? suggestion.author.id;
        return html`
          <article class="session-suggestion" data-suggestion-id=${suggestion.id}>
            <span class="session-suggestion__author">${author}</span>
            <span class="session-suggestion__text">${suggestion.text}</span>
            ${
              canResolve && suggestion.state === "pending"
                ? html`
                    <div class="session-suggestion__actions">
                      ${(
                        [
                          ["send", "sendNow", icons.arrowUp],
                          ["queue", "queue", icons.check],
                          ["edit", "edit", icons.edit],
                          ["dismiss", "dismiss", icons.trash],
                        ] as const
                      ).map(([resolution, key, icon]) =>
                        props.archived && resolution !== "dismiss"
                          ? nothing
                          : html`
                              <button
                                class="btn btn--ghost btn--icon session-suggestion__action"
                                type="button"
                                ?disabled=${busy}
                                aria-label=${t(`chat.sessionSuggestions.${key}`, { author })}
                                title=${t(`chat.sessionSuggestions.${key}`, { author })}
                                @click=${() => props.onResolve(suggestion, resolution)}
                              >
                                ${icon}
                              </button>
                            `,
                      )}
                    </div>
                  `
                : html`<span class="session-suggestion__state"
                    >${t(`chat.sessionSuggestions.state.${suggestion.state}`)}</span
                  >`
            }
          </article>
        `;
      })}
    </div>
  `;
}
