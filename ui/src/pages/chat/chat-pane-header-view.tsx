import { onCleanup } from "solid-js";
import type { PresentationValue } from "../../lit/presentation-binding.ts";
import type { ElementProperties } from "../../types/solid-elements.d.ts";
import { usePanePresentation } from "./chat-pane-embedded-view.tsx";
import type { ChatDetails } from "./components/chat-details.tsx";

export type PaneDetailsProps = {
  chat: ChatDetails["props"];
  mobile: boolean;
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
      prop:presented={presented()}
    />
  );
}

type PresenceProps = Pick<
  HTMLElementTagNameMap["openclaw-viewer-facepile"],
  "staticUsers" | "personActivity"
>;
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
      prop:onSettingsChange={props.onSettingsChange}
      prop:onAction={props.onAction}
    />
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-details": HTMLAttributes<ChatDetails> &
        ElementProperties<Pick<ChatDetails, "props" | "presented" | "mobile">>;
      "openclaw-chat-header-session-menu": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-chat-header-session-menu"]
      > &
        ElementProperties<SessionMenuProps>;
    }
  }
}
