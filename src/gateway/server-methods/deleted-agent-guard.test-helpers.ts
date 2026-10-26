/**
 * Module-level session-utils mocks for deleted-agent guard tests.
 */
import { vi } from "vitest";

const deletedAgentSessionMocks = vi.hoisted(() => ({
  loadGatewaySessionEntryReadOnly: vi.fn(),
  prepareDeletedAgentSessionCheck: vi.fn(),
}));

// mock-isolation: Guard tests supply session facts without opening real session stores.
vi.mock("../session-utils.js", () => ({
  loadGatewaySessionEntryReadOnlyAsync: deletedAgentSessionMocks.loadGatewaySessionEntryReadOnly,
  prepareDeletedAgentSessionCheck: deletedAgentSessionMocks.prepareDeletedAgentSessionCheck,
}));

/** Resets mocked deleted-agent session lookups between tests. */
export function resetDeletedAgentSessionMocks(): void {
  deletedAgentSessionMocks.loadGatewaySessionEntryReadOnly.mockReset();
  deletedAgentSessionMocks.prepareDeletedAgentSessionCheck.mockReset();
}

/** Stubs a session that resolves to an agent id no longer present in config. */
export function mockDeletedAgentSession(
  orphanKey = "agent:deleted-agent:main",
  check: () => string | null | Promise<string | null> = () => "deleted-agent",
): string {
  deletedAgentSessionMocks.prepareDeletedAgentSessionCheck.mockImplementation(check);
  return orphanKey;
}
