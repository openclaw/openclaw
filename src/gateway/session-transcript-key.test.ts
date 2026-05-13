import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";

const {
  loadConfigMock,
  loadCombinedSessionEntriesForGatewayMock,
  resolveGatewaySessionDatabaseTargetMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(() => ({ session: {} })),
  loadCombinedSessionEntriesForGatewayMock: vi.fn(),
  resolveGatewaySessionDatabaseTargetMock: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: loadConfigMock,
}));

vi.mock("./session-utils.js", () => ({
  loadCombinedSessionEntriesForGateway: loadCombinedSessionEntriesForGatewayMock,
  resolveGatewaySessionDatabaseTarget: resolveGatewaySessionDatabaseTargetMock,
}));

import { resolveSessionKeyForSessionScope } from "./session-transcript-key.js";

describe("resolveSessionKeyForSessionScope", () => {
  const now = 1_700_000_000_000;

  beforeEach(() => {
    loadConfigMock.mockClear();
    loadCombinedSessionEntriesForGatewayMock.mockReset();
    resolveGatewaySessionDatabaseTargetMock.mockReset();
    resolveGatewaySessionDatabaseTargetMock.mockImplementation(({ key }: { key: string }) => ({
      agentId: key.split(":")[1] ?? "main",
      databasePath: "/tmp/openclaw-agent.sqlite",
      canonicalKey: key,
    }));
  });

  it("resolves a session key from SQLite agent/session identity", () => {
    loadCombinedSessionEntriesForGatewayMock.mockReturnValue({
      databasePath: "(multiple)",
      entries: {
        "agent:main:one": { sessionId: "sess-1", updatedAt: now },
        "agent:main:two": { sessionId: "sess-2", updatedAt: now + 1 },
      } satisfies Record<string, SessionEntry>,
    });

    expect(resolveSessionKeyForSessionScope({ agentId: "main", sessionId: "sess-2" })).toBe(
      "agent:main:two",
    );
  });

  it("filters duplicate session ids by agent id", () => {
    loadCombinedSessionEntriesForGatewayMock.mockReturnValue({
      databasePath: "(multiple)",
      entries: {
        "agent:other:main": { sessionId: "shared", updatedAt: now + 1 },
        "agent:main:main": { sessionId: "shared", updatedAt: now },
      } satisfies Record<string, SessionEntry>,
    });

    expect(resolveSessionKeyForSessionScope({ agentId: "main", sessionId: "shared" })).toBe(
      "agent:main:main",
    );
  });

  it("uses deterministic session-key preference for duplicate session ids", () => {
    loadCombinedSessionEntriesForGatewayMock.mockReturnValue({
      databasePath: "(multiple)",
      entries: {
        "agent:main:main": { sessionId: "run-dup", updatedAt: now + 1 },
        "agent:main:acp:run-dup": { sessionId: "run-dup", updatedAt: now },
      } satisfies Record<string, SessionEntry>,
    });

    expect(resolveSessionKeyForSessionScope({ agentId: "main", sessionId: "run-dup" })).toBe(
      "agent:main:acp:run-dup",
    );
  });

  it("returns undefined for blank or missing session ids", () => {
    expect(resolveSessionKeyForSessionScope({ agentId: "main", sessionId: "   " })).toBeUndefined();
    expect(loadCombinedSessionEntriesForGatewayMock).not.toHaveBeenCalled();
  });
});
