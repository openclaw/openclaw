import { vi } from "vitest";
import { createGatewayBrowserClientFixture } from "../chat-application-context.test-support.ts";
import { createSessionCapabilityFixture } from "../chat-session-capability.test-support.ts";
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
