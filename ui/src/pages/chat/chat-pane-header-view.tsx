import type { ElementProperties } from "../../types/solid-elements.d.ts";

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
      "openclaw-chat-header-session-menu": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-chat-header-session-menu"]
      > &
        ElementProperties<SessionMenuProps>;
    }
  }
}
