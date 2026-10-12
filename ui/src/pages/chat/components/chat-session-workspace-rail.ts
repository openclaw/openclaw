import { html, nothing } from "lit";
import { solidContent } from "../../../lit/solid-content.tsx";
import { SessionWorkspaceRail } from "./chat-session-workspace-rail-solid.tsx";
import type { SessionWorkspaceProps } from "./chat-session-workspace-types.ts";

export { SessionWorkspaceRail } from "./chat-session-workspace-rail-solid.tsx";

export function renderSessionWorkspaceRail(workspace: SessionWorkspaceProps | undefined) {
  return workspace ? html`${solidContent(SessionWorkspaceRail, { workspace })}` : nothing;
}
