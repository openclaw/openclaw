import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import type { AgentsListResult } from "../../../api/types.ts";
import { createBackgroundLayoutRef } from "../../../components/session-background-layout-context.tsx";
import { AgentIdentityAvatar } from "../../../components/solid/identity-avatar.tsx";
import "../../../components/openclaw-mascot.tsx";
import { registerChatWelcomeEnglish } from "../../../i18n/locales/en-chat-welcome.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { UiSessionDefaultsHost } from "../../../lib/sessions/session-key.ts";
import {
  resolveAssistantDisplayAvatar,
  resolveWelcomeSuggestionKeys,
  type WelcomeSuggestionAuth,
} from "./chat-welcome.ts";

registerChatWelcomeEnglish();

export type ChatWelcomeIdentityProps = {
  currentAgentId?: string;
  agents?: AgentsListResult["agents"];
  assistantName: string;
  assistantAvatar: string | null;
  assistantAvatarUrl?: string | null;
  /** Undefined leaves bootstrap identity in control; null records a known absence. */
  assistantAvatarSource?: string | null;
  sessionHost?: UiSessionDefaultsHost | null;
  /** Connected principal's grant; selects starter prompts it can act on. */
  operatorAuth?: WelcomeSuggestionAuth;
  modelSetupRequired?: boolean;
  onModelSetup?: () => void;
  onDraftChange: (next: string) => void;
  onSend: () => void;
};

export type ChatWelcomeProps = {
  /** Existing agent picker, shown in the new-session welcome heading. */
  assistantNameControl?: JSX.Element;
  /** Hint owned by the new-session draft flow. */
  hint?: JSX.Element;
  /** Rendered below the hero (the new-session draft composer). */
  composer?: JSX.Element;
  /** Hide suggestions when the surrounding flow must stay ephemeral. */
  hideSecondaryContent?: boolean;
  /** Visually retire secondary content while the new-session draft is active. */
  fadeSecondaryContent?: boolean;
} & ChatWelcomeIdentityProps;

/** The new-session draft's welcome block. */
export function ChatWelcome(
  /** Starter suggestions are for a first chat; the sidebar lists existing ones. */
  props: ChatWelcomeProps & { hasRecentSessions?: boolean },
) {
  const welcomeRef = createBackgroundLayoutRef("welcome");
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
            aria-label={props.assistantName || t("chat.messages.agentName")}
          >
            <AgentIdentityAvatar agent={resolveAssistantDisplayAvatar(props)} />
          </span>
          <div class="agent-chat__welcome-identity-copy">
            <h2 class={props.assistantNameControl ? "sr-only" : undefined}>
              {props.assistantName || t("chat.messages.agentName")}
            </h2>
            <Show when={props.assistantNameControl}>
              <div class="agent-chat__welcome-name">{props.assistantNameControl}</div>
            </Show>
            <Show when={props.hint}>
              <p class="agent-chat__hint">{props.hint}</p>
            </Show>
          </div>
        </div>
        {props.composer}
        <Show when={!props.hideSecondaryContent && !props.hasRecentSessions}>
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
              <div class="agent-chat__suggestions">
                <For each={resolveWelcomeSuggestionKeys(props.operatorAuth)}>
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
            </div>
          </div>
        </Show>
      </div>
    </Show>
  );
}
