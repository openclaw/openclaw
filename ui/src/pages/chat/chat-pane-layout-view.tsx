import type { JSX as SolidJSX } from "@solidjs/web";
import { Show } from "solid-js";
import type { ApplicationContext } from "../../app/context-types.ts";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import { SessionBackgroundView } from "../../components/session-background-view.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { useScrollState } from "../../components/solid/scroll-state.ts";
import { registerChatSessionEnglish } from "../../i18n/locales/en-chat-session.ts";
import type { PresentationValue } from "../../lib/presentation.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { PaneSubagentStop } from "./chat-pane-header-view.tsx";
import { usePanePresentation } from "./chat-pane-presentation.ts";
import { SidebarRegionView } from "./chat-pane-sidebar-view.tsx";
import { ChatBoardResetConfirmation } from "./chat-pane-surfaces.tsx";
import { renderChatTopbarNotices } from "./chat-view-notices.tsx";
import { ChatView, type ChatProps } from "./chat-view.tsx";
import type { ComposerQuestions } from "./components/chat-composer-questions.ts";
import { ChatDetails, type ChatDetailsViewProps } from "./components/chat-details.tsx";
import { ChatImageLightbox } from "./components/chat-image-lightbox-view.tsx";
import { PaneHeaderView } from "./components/chat-pane-header.tsx";
import type { ChatPaneHeaderPresentation } from "./components/chat-pane-header.types.ts";
import type { SidebarRegionViewProps } from "./components/chat-sidebar-region-types.ts";
import { SubagentDesktopAvatar } from "./components/chat-subagent-avatar.tsx";
import {
  ChatSubagentMobileHeader,
  type ChatSubagentMobileStop,
} from "./components/chat-subagent-mobile-header.tsx";

registerEnglishCatalog(registerChatSessionEnglish);

function PaneSubagentHeader(props: {
  sessionKey: string;
  title: string;
  onBack: () => void;
  stop: (Parameters<typeof PaneSubagentStop>[0] & { target: string }) | undefined;
  details: ChatDetailsViewProps | undefined;
  /** Supplied by the chrome owner for desktop, including embedded child panes. */
  desktop?: { sessionKey: string };
  /** Explicit native presentation, including child panes without a mobile host. */
  mobile?: boolean;
}) {
  const mobileStop = (): ChatSubagentMobileStop | undefined => {
    const stop = props.stop;
    return stop
      ? {
          target: stop.target,
          label: t("chat.runControls.stop"),
          accessibleLabel: t("chat.subagentsPanel.stop", { name: props.title }),
          disabled: false,
          pending: false,
          confirmation: {
            title: t("chat.subagentsPanel.stopConfirmTitle"),
            message: t("chat.subagentsPanel.stopConfirmMessage"),
            confirmLabel: t("chat.subagentsPanel.stopConfirmAction"),
            cancelLabel: t("common.cancel"),
          },
          // The native callback captures and revalidates its session/run and access.
          onConfirm: stop.onAbort,
        }
      : undefined;
  };
  return (
    <Show
      when={props.mobile === true}
      fallback={
        <Show
          when={props.desktop}
          fallback={
            <header class="chat-subagent-detail__header">
              <button
                class="chat-subagent-detail__back"
                type="button"
                onClick={() => props.onBack()}
              >
                <Icon name="arrowLeft" />
                {t("chat.subagentsPanel.back")}
              </button>
              <div class="chat-subagent-detail__heading">
                <strong class="chat-subagent-detail__title">{props.title}</strong>
                <Show when={props.stop}>{(stop) => <PaneSubagentStop {...stop()} />}</Show>
                <Show when={props.details !== undefined}>
                  <ChatDetails {...props.details!} />
                </Show>
              </div>
            </header>
          }
        >
          {(desktop) => {
            const nameRef = useScrollState(true, false);
            return (
              <header
                class="subagents-desktop__child-rail session-panel-rail"
                data-presentation="desktop"
              >
                <span class="session-panel-rail__group">
                  <button
                    class="subagents-desktop__back session-panel-rail__button"
                    type="button"
                    aria-label={t("chat.subagentsPanel.back")}
                    onClick={() => props.onBack()}
                  >
                    <Icon name="chevronLeft" />
                  </button>
                </span>
                <SubagentDesktopAvatar sessionKey={desktop().sessionKey} />
                <strong ref={nameRef} class="subagents-desktop__child-name" title={props.title}>
                  {props.title}
                </strong>
                <Show when={props.stop}>
                  {(stop) => (
                    <span class="session-panel-rail__group">
                      <button
                        class="subagents-desktop__stop session-panel-rail__button session-panel-rail__button--labelled"
                        type="button"
                        aria-label={t("chat.runControls.stopGenerating")}
                        onClick={() => stop().onAbort()}
                      >
                        <Icon name="stop" />
                        <span>{t("chat.runControls.stop")}</span>
                      </button>
                    </span>
                  )}
                </Show>
                <Show when={props.details !== undefined}>
                  <ChatDetails {...props.details!} />
                </Show>
              </header>
            );
          }}
        </Show>
      }
    >
      <ChatSubagentMobileHeader
        sessionKey={props.sessionKey}
        title={props.title}
        backLabel={t("chat.subagentsPanel.back")}
        onBack={() => props.onBack()}
        stop={mobileStop()}
        actions={
          <Show when={props.details !== undefined}>
            <ChatDetails {...props.details!} />
          </Show>
        }
      />
    </Show>
  );
}

function PaneHeaderContent(props: {
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

export type PaneLayoutData = {
  region: SidebarRegionViewProps;
  header: Parameters<typeof PaneHeaderContent>[0] | null;
  subagentHeader: Parameters<typeof PaneSubagentHeader>[0] | null;
  primary: { chat: ChatProps; application: ApplicationContext };
  background: Parameters<typeof SessionBackgroundView>[0];
  overlays: {
    presentation: PresentationValue;
    image: ImageLightboxItem | null;
    onCloseImage: () => void;
    reset: Parameters<typeof ChatBoardResetConfirmation>[0] | null;
  };
};

function PaneContent(props: { data: PaneLayoutData; questions: ComposerQuestions }) {
  const presented = usePanePresentation(() => props.data.overlays.presentation);
  const header = (
    <Show
      when={props.data.subagentHeader}
      fallback={
        <Show when={props.data.header}>{(value) => <PaneHeaderContent {...value()} />}</Show>
      }
    >
      {(value) => <PaneSubagentHeader {...value()} />}
    </Show>
  );
  const primary = (
    <div class="chat-pane-primary-column">
      <ChatView
        props={props.data.primary.chat}
        application={props.data.primary.application}
        questions={props.questions}
      />
    </div>
  );
  const background = <SessionBackgroundView {...props.data.background} />;
  return (
    <>
      <SidebarRegionView
        {...props.data.region}
        header={header}
        primary={primary}
        background={background}
      />
      <Show when={presented()}>
        <ChatImageLightbox
          item={props.data.overlays.image}
          onClose={() => props.data.overlays.onCloseImage()}
        />
        <Show when={props.data.overlays.reset}>
          {(reset) => <ChatBoardResetConfirmation {...reset()} />}
        </Show>
      </Show>
    </>
  );
}

export function PaneLayout(props: {
  layout: PaneLayoutData | null;
  questions: ComposerQuestions;
}): SolidJSX.Element {
  return (
    <Show
      when={props.layout}
      fallback={<main class="app-shell app-shell--booting" aria-busy="true" />}
    >
      {(layout) => (
        <Show
          when={layout().subagentHeader}
          fallback={<PaneContent data={layout()} questions={props.questions} />}
        >
          <section class="chat-subagent-detail">
            <PaneContent data={layout()} questions={props.questions} />
          </section>
        </Show>
      )}
    </Show>
  );
}
