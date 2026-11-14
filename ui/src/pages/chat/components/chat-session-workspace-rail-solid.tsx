import { Match, Show, Switch } from "solid-js";
import { DesktopWorkspaceContents } from "./chat-session-workspace-desktop.tsx";
import { MobileWorkspaceContents } from "./chat-session-workspace-mobile-adapter.tsx";
import type { SessionWorkspaceProps } from "./chat-sidebar-view-types.ts";

export function SessionWorkspaceRail(props: { workspace?: SessionWorkspaceProps }) {
  // Separate modes retire row-owned operations when presentation changes.
  return (
    <Show when={props.workspace}>
      {(workspace) => (
        <Switch fallback={<DesktopWorkspaceContents workspace={workspace()} />}>
          <Match when={workspace().presentation === "desktop"}>
            <DesktopWorkspaceContents workspace={workspace()} />
          </Match>
          <Match when={workspace().presentation === "mobile"}>
            <MobileWorkspaceContents workspace={workspace()} />
          </Match>
        </Switch>
      )}
    </Show>
  );
}
