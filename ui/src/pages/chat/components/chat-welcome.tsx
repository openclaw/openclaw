import type { JSX } from "@solidjs/web";
import { createMemo, For, Show } from "solid-js";
import type { AgentsListResult, SessionsListResult } from "../../../api/types.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import { createBackgroundLayoutRef } from "../../../components/session-background-layout-context.tsx";
import { AgentIdentityAvatar } from "../../../components/solid/identity-avatar.tsx";
import { Kbd } from "../../../components/solid/kbd.tsx";
import "../../../components/openclaw-mascot.ts";
import { registerCommandPaletteEnglish } from "../../../i18n/locales/en-command-palette.ts";
import { formatRelativeTimestamp } from "../../../lib/format.ts";
import { projectGateway } from "../../../lib/reactive/application.ts";
import { i18nRevision, t } from "../../../lib/reactive/i18n.ts";
import { createParkedProjection } from "../../../lib/reactive/parked-projection.ts";
import { projectOwner, projectSource } from "../../../lib/reactive/projection.ts";
import {
  parseAgentSessionKey,
  resolveUiSelectedGlobalAgentId,
  type UiSessionDefaultsHost,
} from "../../../lib/sessions/session-key.ts";
import { prepareWelcomeRecentSessions, resolveAssistantDisplayAvatar } from "./chat-welcome.ts";

registerCommandPaletteEnglish();

export type ChatWelcomeIdentityProps = {
  currentAgentId?: string;
  agents?: AgentsListResult["agents"];
  assistantName: string;
  assistantAvatar: string | null;
  assistantAvatarUrl?: string | null;
  sessionHost?: UiSessionDefaultsHost | null;
  modelSetupRequired?: boolean;
  onModelSetup?: () => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
  onOpenSession?: (sessionKey: string) => void;
};

export type ChatWelcomeProps = {
  applicationContext?: Pick<ApplicationContext, "gateway" | "sessions">;
  /** Existing agent picker, shown in the new-session welcome heading. */
  assistantNameControl?: JSX.Element;
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
} & ChatWelcomeIdentityProps;

const WELCOME_SUGGESTION_KEYS = [
  "chat.welcome.suggestions.whatCanYouDo",
  "chat.welcome.suggestions.summarizeRecentSessions",
  "chat.welcome.suggestions.configureChannel",
  "chat.welcome.suggestions.checkSystemHealth",
];

/** The start-screen welcome block, shared by the empty chat and the new-session draft. */
export function ChatWelcome(props: ChatWelcomeProps) {
  const welcomeRef = createBackgroundLayoutRef("welcome");
  const context = createMemo(() => props.applicationContext);
  const gateway = createMemo(() => {
    const owner = context()?.gateway;
    return owner ? projectGateway(owner) : undefined;
  });
  const scope = createMemo(
    () => {
      const snapshot = gateway()?.read().snapshot;
      return {
        sessionKey: props.sessionKey,
        agentId:
          parseAgentSessionKey(props.sessionKey)?.agentId ??
          resolveUiSelectedGlobalAgentId(props.sessionHost ?? {}),
        profileId:
          snapshot?.hello?.policy?.hasMultipleSessionSharingIdentities === true
            ? snapshot.selfUser?.id
            : undefined,
        identityPending: Boolean(snapshot && snapshot.selfUser === undefined),
      };
    },
    {
      equals: (a, b) =>
        a.sessionKey === b.sessionKey &&
        a.agentId === b.agentId &&
        a.profileId === b.profileId &&
        a.identityPending === b.identityPending,
    },
  );
  const sessions = createMemo(() => {
    const owner = context()?.sessions;
    const selected = scope();
    if (!owner || selected.identityPending) {
      return undefined;
    }
    if (!selected.profileId) {
      return projectOwner(owner, (current) => current.state.result);
    }
    const query = {
      agentId: selected.agentId,
      involvingMe: true,
      includeDerivedTitles: true,
      includeLastMessage: true,
    };
    // Membership (including mentions and personal hide/show) is decided by the
    // Gateway before pagination, independently of the primary All owners roster.
    return projectSource(
      { owner, query },
      {
        read: (source) => source.owner.listSnapshot(source.query).result,
        subscribe: (source, notify) => {
          const stop = source.owner.subscribeList(source.query, notify);
          void source.owner.refreshList(source.query);
          return stop;
        },
        equality: "revision",
      },
    );
  });
  const excluded = createMemo(() => props.hideSecondaryContent || props.modelSetupRequired);
  const presented = createMemo(() => !excluded() && !props.fadeSecondaryContent);
  const recentSessions = createParkedProjection(() => {
    if (excluded()) {
      return [];
    }
    i18nRevision();
    return prepareWelcomeRecentSessions(
      context() ? sessions()?.read() : props.sessions,
      scope().sessionKey,
      scope().agentId,
    );
  }, presented);
  return (
    <Show
      when={!props.modelSetupRequired}
      fallback={
        <div ref={welcomeRef} class="agent-chat__welcome agent-chat__welcome--setup" role="alert">
          <div class="agent-chat__welcome-clawd" aria-hidden="true">
            <openclaw-mascot mood="idle" prop:size={112} />
          </div>
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
      <div ref={welcomeRef} class="agent-chat__welcome" style="--agent-color: var(--accent)">
        <div class="agent-chat__welcome-identity">
          <span
            class="agent-chat__welcome-avatar"
            role="img"
            aria-label={props.assistantName || "Assistant"}
          >
            <AgentIdentityAvatar agent={resolveAssistantDisplayAvatar(props)} />
          </span>
          <div class="agent-chat__welcome-identity-copy">
            <h2 class={props.assistantNameControl ? "sr-only" : undefined}>
              {props.assistantName || "Assistant"}
            </h2>
            <Show when={props.assistantNameControl}>
              <div class="agent-chat__welcome-name">{props.assistantNameControl}</div>
            </Show>
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
                }
              >
                <div class="agent-chat__recents">
                  <div class="agent-chat__recents-title">{t("chat.welcome.recentSessions")}</div>
                  <For each={recentSessions()}>
                    {(row) => (
                      <button
                        type="button"
                        class="agent-chat__recent"
                        onClick={() => props.onOpenSession?.(row.key)}
                      >
                        <span class="agent-chat__recent-name">{row.name}</span>
                        <Show when={row.subtitle}>
                          {(subtitle) => <span class="agent-chat__recent-sub">{subtitle()}</span>}
                        </Show>
                        <span class="agent-chat__recent-time">
                          {formatRelativeTimestamp(row.updatedAt, { fallback: "" })}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  );
}
