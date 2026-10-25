import { vi } from "vitest";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
} from "../chat-pane.test-support.ts";
import type { SessionWorkspaceHost } from "./chat-session-workspace-types.ts";

export function createSessionWorkspaceHost(
  overrides: Partial<SessionWorkspaceHost> = {},
): SessionWorkspaceHost {
  return {
    sessionKey: "agent:main:files",
    connectionEpoch: 1,
    connected: true,
    client: overrides.client ?? createGatewayBrowserClientFixture(),
    sessions: overrides.sessions ?? createSessionCapabilityFixture(),
    hello: null,
    sidebarContent: null,
    handleOpenSidebar: overrides.handleOpenSidebar ?? vi.fn(),
    ...overrides,
  };
}
