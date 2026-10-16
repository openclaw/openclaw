import { onCleanup } from "solid-js";
import { Icon } from "../../components/solid/icon.tsx";
import type { PresentationValue } from "../../lib/presentation.ts";
import { t } from "../../lib/reactive/i18n.ts";
import type { ElementProperties } from "../../types/solid-elements.d.ts";
import { usePanePresentation } from "./chat-pane-embedded-view.tsx";
import type { ChatDetails } from "./components/chat-details.tsx";

export type PaneDetailsProps = {
  chat: ChatDetails["props"];
  mobile: boolean;
  conversationVisible?: boolean;
  externalTrigger?: boolean;
  presentation: PresentationValue;
  setRef: (details: ChatDetails | undefined) => void;
};

export function PaneDetails(props: PaneDetailsProps) {
  const presented = usePanePresentation(() => props.presentation);
  onCleanup(() => props.setRef(undefined));
  return (
    <openclaw-chat-details
      ref={(element) => props.setRef(element)}
      prop:props={props.chat}
      prop:mobile={props.mobile}
      prop:conversationVisible={props.conversationVisible ?? true}
      prop:externalTrigger={props.externalTrigger ?? false}
      prop:presented={presented()}
    />
  );
}

type PresenceProps = Pick<
  HTMLElementTagNameMap["openclaw-viewer-facepile"],
  "staticUsers" | "personActivity"
>;

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
export function PaneHeaderPresence(props: PresenceProps) {
  return (
    <openclaw-viewer-facepile
      class="chat-pane__presence"
      prop:staticUsers={props.staticUsers}
      prop:maxVisible={4}
      prop:personActivity={props.personActivity}
      variant="session"
    />
  );
}

type SessionMenuProps = Omit<
  HTMLElementTagNameMap["openclaw-chat-header-session-menu"],
  keyof HTMLElement | "updateComplete" | "openMenu"
>;
export function PaneHeaderSessionMenu(props: SessionMenuProps) {
  return (
    <openclaw-chat-header-session-menu
      prop:session={props.session}
      prop:worktreePath={props.worktreePath}
      prop:onboarding={props.onboarding}
      prop:preferencesBrowserOnly={props.preferencesBrowserOnly}
      prop:compact={props.compact}
      prop:copyMarkdownAllowed={props.copyMarkdownAllowed}
      prop:splitAllowed={props.splitAllowed}
      prop:settings={props.settings}
      prop:bubbleModeEnabled={props.bubbleModeEnabled}
      prop:mainKey={props.mainKey}
      prop:boardWidgetMenu={props.boardWidgetMenu}
      prop:sessionActions={props.sessionActions}
      prop:sharing={props.sharing}
      prop:groups={props.groups}
      prop:currentOwner={props.currentOwner}
      prop:actionDisabledReasons={props.actionDisabledReasons}
      prop:forkDisabled={props.forkDisabled}
      prop:forkFromLastCompleted={props.forkFromLastCompleted}
      prop:archiveAllowed={props.archiveAllowed}
      prop:archiveShortcut={props.archiveShortcut}
      prop:deleteAllowed={props.deleteAllowed}
      prop:onOpen={props.onOpen}
      prop:onOpenCommandPalette={props.onOpenCommandPalette}
      prop:onOpenDetails={props.onOpenDetails}
      prop:onSettingsChange={props.onSettingsChange}
      prop:onAction={props.onAction}
    />
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-details": HTMLAttributes<ChatDetails> &
        ElementProperties<
          Pick<
            ChatDetails,
            "props" | "presented" | "mobile" | "conversationVisible" | "externalTrigger"
          >
        >;
      "openclaw-chat-header-session-menu": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-chat-header-session-menu"]
      > &
        ElementProperties<SessionMenuProps>;
    }
  }
}
