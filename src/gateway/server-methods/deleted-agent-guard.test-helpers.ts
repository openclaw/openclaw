/**
 * Module-level session-utils mocks for deleted-agent guard tests.
 */
import { vi } from "vitest";

const deletedAgentSessionMocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  loadGatewaySessionEntryReadOnly: vi.fn(),
  prepareDeletedAgentSessionCheck: vi.fn(),
}));

// mock-isolation: Guard tests supply session facts without opening real session stores.
vi.mock("../session-utils.js", () => ({
  loadSessionEntry: deletedAgentSessionMocks.loadSessionEntry,
  loadGatewaySessionEntryReadOnly: deletedAgentSessionMocks.loadGatewaySessionEntryReadOnly,
  prepareDeletedAgentSessionCheck: deletedAgentSessionMocks.prepareDeletedAgentSessionCheck,
}));

/** Resets mocked deleted-agent session lookups between tests. */
export function resetDeletedAgentSessionMocks(): void {
  deletedAgentSessionMocks.loadSessionEntry.mockReset();
  deletedAgentSessionMocks.loadGatewaySessionEntryReadOnly.mockReset();
  deletedAgentSessionMocks.prepareDeletedAgentSessionCheck.mockReset();
}

/** Stubs a session that resolves to an agent id no longer present in config. */
export function mockDeletedAgentSession(
  orphanKey = "agent:deleted-agent:main",
  check: () => string | null | Promise<string | null> = () => "deleted-agent",
): string {
  deletedAgentSessionMocks.loadSessionEntry.mockReturnValue({
    cfg: {},
    canonicalKey: orphanKey,
    storePath: "/tmp/sessions.json",
    entry: { sessionId: "sess-orphan" },
  });
  deletedAgentSessionMocks.prepareDeletedAgentSessionCheck.mockImplementation(check);
  return orphanKey;
}
