// Control UI chat module implements chat welcome behavior.
import { html, nothing } from "lit";
import type {
  AgentsListResult,
  GatewaySessionRow,
  SessionsListResult,
} from "../../../api/types.ts";
import { renderAgentIdentityAvatar } from "../../../components/identity-avatar-view.ts";
import "../../../components/openclaw-mascot.ts";
import { t } from "../../../i18n/index.ts";
import { resolveAgentTextAvatar } from "../../../lib/agents/display.ts";
import {
  resolveAgentAvatarUrl,
  resolveAssistantTextAvatar,
  resolveChatAvatarRenderUrl,
} from "../../../lib/avatar.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";
import {
  resolveChannelSessionInfo,
  resolveSessionDisplayName,
  resolveSessionWorkSubtitle,
} from "../../../lib/session-display.ts";
import { getVisibleSessionRows } from "../../../lib/sessions/navigation.ts";
import {
  areUiSessionKeysEquivalent,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
  type UiSessionDefaultsHost,
} from "../../../lib/sessions/session-key.ts";

type ChatWelcomeProps = {
  currentAgentId?: string;
  agents?: AgentsListResult["agents"];
  assistantName: string;
  assistantAvatar: string | null;
  assistantAvatarUrl?: string | null;
  /** Hero hint override; defaults to the chat slash-command hint. */
  hint?: unknown;
  /** Rendered between the hero and the recents (the new-session draft composer). */
  composer?: unknown;
  /** Hide recents and suggestions when the surrounding flow must stay ephemeral. */
  hideSecondaryContent?: boolean;
  /** Visually retire secondary content while the new-session draft is active. */
  fadeSecondaryContent?: boolean;
  sessions?: SessionsListResult | null;
  sessionKey?: string;
  sessionHost?: UiSessionDefaultsHost | null;
  modelSetupRequired?: boolean;
  onModelSetup?: () => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onOpenSession?: (sessionKey: string) => void;
};

const WELCOME_SUGGESTION_KEYS = [
  "chat.welcome.suggestions.whatCanYouDo",
  "chat.welcome.suggestions.summarizeRecentSessions",
  "chat.welcome.suggestions.configureChannel",
  "chat.welcome.suggestions.checkSystemHealth",
];

const WELCOME_RECENT_SESSION_LIMIT = 5;

export function resolveAssistantDisplayAvatar(
  props: Pick<
    ChatWelcomeProps,
    "currentAgentId" | "agents" | "assistantAvatar" | "assistantAvatarUrl"
  >,
) {
  const id = props.currentAgentId ?? "main";
  const agent = props.agents?.find((entry) => entry.id === id);
  const avatar = resolveChatAvatarRenderUrl(props.assistantAvatarUrl, {
    identity: {
      avatar: props.assistantAvatar ?? undefined,
      avatarUrl: props.assistantAvatarUrl ?? undefined,
    },
  });
  return {
    id,
    avatar: avatar ?? (agent ? resolveAgentAvatarUrl(agent) : null),
    textAvatar:
      resolveAssistantTextAvatar(props.assistantAvatar) ??
      (agent ? resolveAgentTextAvatar(agent) : null),
  };
}

/**
 * Recent user-created chats for the welcome screen: the sidebar's visible-row
 * rules (no archived/cron/subagent/spawned rows, scoped to the active agent)
 * minus channel-originated sessions — those live in their channel sections and
 * are not something the user "starts" from here.
 */
function selectWelcomeRecentSessions(
  props: Pick<ChatWelcomeProps, "sessions" | "sessionKey" | "sessionHost">,
): GatewaySessionRow[] {
  if (!props.sessions) {
    return [];
  }
  const host = props.sessionHost ?? {};
  // Bare global keys carry no agent; the selected agent lives in host state
  // (assistantAgentId). Mirrors resolveSessionNavigation's agent resolution.
  const defaultAgentId = resolveUiSelectedGlobalAgentId(host);
  const agentId = parseAgentSessionKey(props.sessionKey)?.agentId ?? defaultAgentId;
  return (
    getVisibleSessionRows(props.sessions, { agentId, defaultAgentId, filterByAgent: true })
      .filter(
        (row) =>
          !areUiSessionKeysEquivalent(row.key, props.sessionKey) &&
          !resolveChannelSessionInfo(row.key, row.channel).channelSession,
      )
      // Pure recency, unlike the sidebar's pin-aware sort: a "Recent chats"
      // list capped at five must not let stale pinned rows hide newer chats.
      .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.key.localeCompare(b.key))
      .slice(0, WELCOME_RECENT_SESSION_LIMIT)
  );
}

function renderWelcomeClawd() {
  return html`
    <div class="agent-chat__welcome-clawd" aria-hidden="true">
      <openclaw-mascot mood="idle" .size=${112}></openclaw-mascot>
    </div>
  `;
}

function renderWelcomeRecentSessions(
  rows: GatewaySessionRow[],
  onOpenSession: ((sessionKey: string) => void) | undefined,
) {
  return html`
    <div class="agent-chat__recents">
      <div class="agent-chat__recents-title">${t("chat.welcome.recentSessions")}</div>
      ${rows.map((row) => {
        const subtitle = resolveSessionWorkSubtitle(row);
        return html`
          <button type="button" class="agent-chat__recent" @click=${() => onOpenSession?.(row.key)}>
            <span class="agent-chat__recent-name">${resolveSessionDisplayName(row.key, row)}</span>
            ${subtitle ? html`<span class="agent-chat__recent-sub">${subtitle}</span>` : nothing}
            <span class="agent-chat__recent-time">
              ${formatRelativeTimestamp(row.updatedAt, { fallback: "" })}
            </span>
          </button>
        `;
      })}
    </div>
  `;
}

function renderWelcomeSuggestions(props: Pick<ChatWelcomeProps, "onDraftChange" | "onSend">) {
  return html`
    <div class="agent-chat__suggestions">
      ${WELCOME_SUGGESTION_KEYS.map((key) => {
        const text = t(key);
        return html`
          <button
            type="button"
            class="agent-chat__suggestion"
            @click=${() => {
              props.onDraftChange(text);
              props.onSend();
            }}
          >
            ${text}
          </button>
        `;
      })}
    </div>
  `;
}

function renderWelcomeHero(
  props: Pick<
    ChatWelcomeProps,
    "currentAgentId" | "agents" | "assistantName" | "assistantAvatar" | "assistantAvatarUrl"
  > & {
    hint: unknown;
  },
) {
  const name = props.assistantName || "Assistant";
  return html`
    <div class="agent-chat__welcome-identity">
      <span class="agent-chat__welcome-avatar" role="img" aria-label=${name}>
        ${renderAgentIdentityAvatar(resolveAssistantDisplayAvatar(props))}
      </span>
      <div class="agent-chat__welcome-identity-copy">
        <h2>${name}</h2>
        <p class="agent-chat__hint">${props.hint}</p>
      </div>
    </div>
  `;
}

/** The start-screen welcome block, shared by the empty chat and the new-session draft. */
export function renderWelcomeState(props: ChatWelcomeProps) {
  if (props.modelSetupRequired) {
    return html`
      <div class="agent-chat__welcome agent-chat__welcome--setup" role="alert">
        ${renderWelcomeClawd()}
        <h2>${t("modelSetup.required.title")}</h2>
        <p class="agent-chat__hint">${t("modelSetup.required.body")}</p>
        ${
          props.onModelSetup
            ? html`<button class="btn primary" type="button" @click=${props.onModelSetup}>
                ${t("modelSetup.required.action")}
              </button>`
            : nothing
        }
      </div>
    `;
  }
  const recentSessions = selectWelcomeRecentSessions(props);
  return html`
    <div class="agent-chat__welcome" style="--agent-color: var(--accent)">
      ${renderWelcomeHero({
        currentAgentId: props.currentAgentId,
        agents: props.agents,
        assistantName: props.assistantName,
        assistantAvatar: props.assistantAvatar,
        assistantAvatarUrl: props.assistantAvatarUrl,
        hint:
          props.hint ??
          html`${t("chat.welcome.hintBeforeShortcut")} <kbd>/</kbd> ${t(
              "chat.welcome.hintAfterShortcut",
            )}`,
      })}
      ${props.composer ?? nothing}
      ${
        props.hideSecondaryContent
          ? nothing
          : html`<div
              class="agent-chat__welcome-secondary ${
                props.fadeSecondaryContent ? "agent-chat__welcome-secondary--hidden" : ""
              }"
              aria-hidden=${props.fadeSecondaryContent ? "true" : "false"}
              ?inert=${props.fadeSecondaryContent}
            >
              <div class="agent-chat__welcome-secondary-inner">
                ${
                  recentSessions.length > 0
                    ? renderWelcomeRecentSessions(recentSessions, props.onOpenSession)
                    : renderWelcomeSuggestions(props)
                }
              </div>
            </div>`
      }
    </div>
  `;
}
