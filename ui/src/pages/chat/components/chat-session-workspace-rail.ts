import { emptyLegacyContent, solidContent } from "../../../lit/solid-content.tsx";
import { SessionWorkspaceRail } from "./chat-session-workspace-rail-solid.tsx";
import type { SessionWorkspaceProps } from "./chat-session-workspace-types.ts";

export function renderSessionWorkspaceRail(workspace: SessionWorkspaceProps | undefined) {
  return workspace ? solidContent(SessionWorkspaceRail, { workspace }) : emptyLegacyContent;
}
