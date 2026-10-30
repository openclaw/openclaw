import { vi } from "vitest";
import { renderChatPaneComposerControls } from "./chat-pane-session-controls.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

type ComposerControlsParams = Parameters<typeof renderChatPaneComposerControls>[0];

export function renderControls(
  state: ChatPageHost,
  overrides: Partial<Omit<ComposerControlsParams, "state">> = {},
) {
  return renderChatPaneComposerControls({
    state,
    selectedSession: state.sessionsResult?.sessions[0],
    agentDefaultModel: undefined,
    modelAccess: { allowed: true, requiredScope: "operator.write" },
    effortAccess: { allowed: true, requiredScope: "operator.write" },
    contextWindowAccess: { allowed: true, requiredScope: "operator.admin" },
    permissionAccess: { allowed: true, requiredScope: "operator.write" },
    canSelectFull: true,
    onModelSetup: vi.fn(),
    ...overrides,
  });
}
