import { Show } from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import { t } from "../../lib/reactive/i18n.ts";
import type { PresentationValue } from "../../lit/presentation-binding.ts";
import { LitContent } from "../../lit/solid-content.tsx";
import type { ElementProperties } from "../../types/solid-elements.d.ts";
import { usePanePresentation } from "./chat-pane-embedded-view.tsx";
import { PaneDetails, type PaneDetailsProps } from "./chat-pane-header-view.tsx";
import type { ChatPageHost } from "./chat-state-host.ts";
import { renderChatTopbarNotices } from "./chat-view-notices.tsx";
import { ChatView, type ChatProps } from "./chat-view.tsx";

export function PaneBootLayout() {
  return <main class="app-shell app-shell--booting" aria-busy="true" />;
}

export function PaneOutboxRecovery(props: {
  state: ChatPageHost;
  identity: string;
  onRestored: () => void;
}) {
  return (
    <openclaw-chat-outbox-recovery
      prop:host={props.state}
      prop:messages={props.state.chatMessages}
      prop:identity={props.identity}
      onOutbox-restored={() => props.onRestored()}
    />
  );
}

export function PaneSubagentStop(props: { onAbort: () => void }) {
  return (
    <button
      class="chat-subagent-detail__stop"
      type="button"
      aria-label={t("chat.runControls.stopGenerating")}
      onClick={() => props.onAbort()}
    >
      <Icon name="stop" />
      <span>{t("chat.runControls.stop")}</span>
    </button>
  );
}

export function PaneSubagentHeader(props: {
  title: string;
  onBack: () => void;
  stop: unknown;
  details: PaneDetailsProps | undefined;
}) {
  return (
    <header class="chat-subagent-detail__header">
      <button class="chat-subagent-detail__back" type="button" onClick={() => props.onBack()}>
        <Icon name="arrowLeft" />
        {t("chat.subagentsPanel.back")}
      </button>
      <div class="chat-subagent-detail__heading">
        <strong class="chat-subagent-detail__title">{props.title}</strong>
        <LitContent value={props.stop} />
        <Show when={props.details !== undefined}>
          <PaneDetails {...props.details!} />
        </Show>
      </div>
    </header>
  );
}

export function PaneHeaderContent(props: {
  header: unknown;
  notice?: Parameters<typeof renderChatTopbarNotices>[0];
  sessionKey: string;
  agentId: string;
  presentation: PresentationValue;
}) {
  const presented = usePanePresentation(() => props.presentation);
  return (
    <>
      <LitContent value={props.header} />
      {props.notice ? renderChatTopbarNotices(props.notice) : undefined}
      <openclaw-plugin-contributions
        prop:kind="session-header"
        prop:sessionKey={props.sessionKey}
        prop:agentId={props.agentId}
        prop:presented={presented()}
      />
    </>
  );
}

export function PanePrimary(props: { chat: ChatProps; application: ApplicationContext }) {
  return (
    <div class="chat-pane-primary-column">
      <ChatView props={props.chat} application={props.application} />
    </div>
  );
}

export function PaneSubagentContent(props: { content: unknown; overlays: unknown }) {
  return (
    <section class="chat-subagent-detail">
      <LitContent value={[props.content, props.overlays]} />
    </section>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-outbox-recovery": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-chat-outbox-recovery"]
      > &
        ElementProperties<
          Pick<
            HTMLElementTagNameMap["openclaw-chat-outbox-recovery"],
            "host" | "identity" | "messages"
          >
        > & {
          "onOutbox-restored"?: () => void;
        };
    }
  }
}
