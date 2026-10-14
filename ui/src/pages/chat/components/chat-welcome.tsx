import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import type {
  AgentsListResult,
  GatewaySessionRow,
  SessionsListResult,
} from "../../../api/types.ts";
import { AgentIdentityAvatar } from "../../../components/solid/identity-avatar.tsx";
import { Kbd } from "../../../components/solid/kbd.tsx";
import "../../../components/openclaw-mascot.ts";
import { registerCommandPaletteEnglish } from "../../../i18n/locales/en-command-palette.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import {
  resolveChannelSessionInfo,
  resolveSessionDisplayName,
  resolveSessionWorkSubtitle,
} from "../../../lib/session-display.ts";
import { filterVisibleSessionRows } from "../../../lib/sessions/navigation.ts";
import {
  areUiSessionKeysEquivalent,
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
  type UiSessionDefaultsHost,
} from "../../../lib/sessions/session-key.ts";
import { resolveAssistantDisplayAvatar } from "./chat-welcome.ts";

registerCommandPaletteEnglish();

export type ChatWelcomeProps = {
  currentAgentId?: string;
  agents?: AgentsListResult["agents"];
  assistantName: string;
  assistantAvatar: string | null;
  assistantAvatarUrl?: string | null;
  /** Hero hint override; defaults to the chat slash-command hint. */
  hint?: JSX.Element;
  /** Rendered between the hero and the recents (the new-session draft composer). */
  composer?: JSX.Element;
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

/**
 * Recent user-created chats for the welcome screen: the sidebar's visible-row
 * rules (no archived/cron/subagent/spawned rows, scoped to the active agent)
 * minus channel-originated sessions — those live in their channel sections and
 * are not something the user "starts" from here.
 */
function selectWelcomeRecentSessions(props: ChatWelcomeProps): GatewaySessionRow[] {
  if (!props.sessions) {
    return [];
  }
  const host = props.sessionHost ?? {};
  // Bare global keys carry no agent; the selected agent lives in host state
  // (assistantAgentId). Mirrors resolveSessionNavigation's agent resolution.
  const defaultAgentId = resolveUiSelectedGlobalAgentId(host);
  const agentId = parseAgentSessionKey(props.sessionKey)?.agentId ?? defaultAgentId;
  return (
    filterVisibleSessionRows(props.sessions.sessions, {
      agentId,
      defaultAgentId,
      filterByAgent: true,
    })
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

function WelcomeClawd() {
  return (
    <div class="agent-chat__welcome-clawd" aria-hidden="true">
      <openclaw-mascot mood="idle" prop:size={112} />
    </div>
  );
}

function WelcomeRecentSessions(props: {
  rows: GatewaySessionRow[];
  onOpenSession: ChatWelcomeProps["onOpenSession"];
}) {
  return (
    <div class="agent-chat__recents">
      <div class="agent-chat__recents-title">{t("chat.welcome.recentSessions")}</div>
      <For each={props.rows}>
        {(row) => (
          <button
            type="button"
            class="agent-chat__recent"
            onClick={() => props.onOpenSession?.(row.key)}
          >
            <span class="agent-chat__recent-name">{resolveSessionDisplayName(row.key, row)}</span>
            <Show when={resolveSessionWorkSubtitle(row)}>
              {(subtitle) => <span class="agent-chat__recent-sub">{subtitle()}</span>}
            </Show>
            <span class="agent-chat__recent-time">
              {formatRelativeTimestamp(row.updatedAt, { fallback: "" })}
            </span>
          </button>
        )}
      </For>
    </div>
  );
}

function WelcomeSuggestions(props: Pick<ChatWelcomeProps, "onDraftChange" | "onSend">) {
  return (
    <div class="agent-chat__suggestions">
      <For each={WELCOME_SUGGESTION_KEYS}>
        {(key) => (
          <button
            type="button"
            class="agent-chat__suggestion"
            onClick={() => {
              props.onDraftChange(t(key));
              props.onSend();
            }}
          >
            {t(key)}
          </button>
        )}
      </For>
    </div>
  );
}

function WelcomeHero(props: ChatWelcomeProps) {
  return (
    <div class="agent-chat__welcome-identity">
      <span
        class="agent-chat__welcome-avatar"
        role="img"
        aria-label={props.assistantName || "Assistant"}
      >
        <AgentIdentityAvatar agent={resolveAssistantDisplayAvatar(props)} />
      </span>
      <div class="agent-chat__welcome-identity-copy">
        <h2>{props.assistantName || "Assistant"}</h2>
        <p class="agent-chat__hint">
          {props.hint ?? (
            <>
              {t("chat.welcome.hintBeforeShortcut")} <Kbd keys="/" />{" "}
              {t("chat.welcome.hintAfterShortcut")}
            </>
          )}
        </p>
      </div>
    </div>
  );
}

/** The start-screen welcome block, shared by the empty chat and the new-session draft. */
export function ChatWelcome(props: ChatWelcomeProps) {
  const recentSessions = createMemo(() => selectWelcomeRecentSessions(props));
  return (
    <Show
      when={!props.modelSetupRequired}
      fallback={
        <div class="agent-chat__welcome agent-chat__welcome--setup" role="alert">
          <WelcomeClawd />
          <h2>{t("modelSetup.required.title")}</h2>
          <p class="agent-chat__hint">{t("modelSetup.required.body")}</p>
          <Show when={props.onModelSetup}>
            <button class="btn primary" type="button" onClick={() => props.onModelSetup?.()}>
              {t("modelSetup.required.action")}
            </button>
          </Show>
        </div>
      }
    >
      <div class="agent-chat__welcome" style="--agent-color: var(--accent)">
        <WelcomeHero {...props} />
        {props.composer}
        <Show when={!props.hideSecondaryContent}>
          <div
            class={[
              "agent-chat__welcome-secondary",
              {
                "agent-chat__welcome-secondary--hidden": props.fadeSecondaryContent,
              },
            ]}
            aria-hidden={props.fadeSecondaryContent ? "true" : "false"}
            inert={props.fadeSecondaryContent}
          >
            <div class="agent-chat__welcome-secondary-inner">
              <Show
                when={recentSessions().length > 0}
                fallback={
                  <WelcomeSuggestions onDraftChange={props.onDraftChange} onSend={props.onSend} />
                }
              >
                <WelcomeRecentSessions
                  rows={recentSessions()}
                  onOpenSession={props.onOpenSession}
                />
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  );
}
