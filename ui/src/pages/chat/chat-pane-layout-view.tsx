import { Show } from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import { Icon } from "../../components/solid/icon.tsx";
import type { PresentationValue } from "../../lib/presentation.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { LitContent } from "../../lit/solid-content.tsx";
import { PaneDetails, PaneSubagentStop, type PaneDetailsProps } from "./chat-pane-header-view.tsx";
import { usePanePresentation } from "./chat-pane-presentation.ts";
import { renderChatTopbarNotices } from "./chat-view-notices.tsx";
import { ChatView, type ChatProps } from "./chat-view.tsx";
import { PaneHeaderView, type ChatPaneHeaderPresentation } from "./components/chat-pane-header.tsx";

export function PaneBootLayout() {
  return <main class="app-shell app-shell--booting" aria-busy="true" />;
}

export function PaneSubagentHeader(props: {
  title: string;
  onBack: () => void;
  stop: Parameters<typeof PaneSubagentStop>[0] | undefined;
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
        <Show when={props.stop}>{(stop) => <PaneSubagentStop {...stop()} />}</Show>
        <Show when={props.details !== undefined}>
          <PaneDetails {...props.details!} />
        </Show>
      </div>
    </header>
  );
}

export function PaneHeaderContent(props: {
  header: ChatPaneHeaderPresentation;
  notice?: Parameters<typeof renderChatTopbarNotices>[0];
  sessionKey: string;
  agentId: string;
  presentation: PresentationValue;
}) {
  const presented = usePanePresentation(() => props.presentation);
  return (
    <>
      <PaneHeaderView {...props.header} />
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
