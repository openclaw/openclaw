import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSqliteSessionTranscriptLocator } from "../config/sessions/paths.js";
import type { SessionEntry } from "../config/sessions/types.js";

const {
  loadConfigMock,
  loadCombinedSessionEntriesForGatewayMock,
  resolveGatewaySessionDatabaseTargetMock,
  resolveSessionTranscriptCandidatesMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(() => ({ session: {} })),
  loadCombinedSessionEntriesForGatewayMock: vi.fn(),
  resolveGatewaySessionDatabaseTargetMock: vi.fn(),
  resolveSessionTranscriptCandidatesMock: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: loadConfigMock,
}));

vi.mock("./session-utils.js", () => ({
  loadCombinedSessionEntriesForGateway: loadCombinedSessionEntriesForGatewayMock,
  resolveGatewaySessionDatabaseTarget: resolveGatewaySessionDatabaseTargetMock,
  resolveSessionTranscriptCandidates: resolveSessionTranscriptCandidatesMock,
}));

import {
  clearSessionTranscriptKeyCacheForTests,
  resolveSessionKeyForTranscriptLocator,
} from "./session-transcript-key.js";

describe("resolveSessionKeyForTranscriptLocator", () => {
  const now = 1_700_000_000_000;
  const locator = (sessionId: string, agentId = "main") =>
    createSqliteSessionTranscriptLocator({ agentId, sessionId });

  beforeEach(() => {
    clearSessionTranscriptKeyCacheForTests();
    loadConfigMock.mockClear();
    loadCombinedSessionEntriesForGatewayMock.mockReset();
    resolveGatewaySessionDatabaseTargetMock.mockReset();
    resolveSessionTranscriptCandidatesMock.mockReset();
    resolveGatewaySessionDatabaseTargetMock.mockImplementation(({ key }: { key: string }) => ({
      agentId: "main",
      databasePath: "/tmp/openclaw-agent.sqlite",
      canonicalKey: key,
      storeKeys: [key],
    }));
  });

  it("reuses the cached session key for repeat transcript lookups", () => {
    const store = {
      "agent:main:one": { sessionId: "sess-1", updatedAt: now },
      "agent:main:two": { sessionId: "sess-2", updatedAt: now },
    } satisfies Record<string, SessionEntry>;
    loadCombinedSessionEntriesForGatewayMock.mockReturnValue({
      databasePath: "(multiple)",
      entries: store,
    });
    resolveSessionTranscriptCandidatesMock.mockImplementation((sessionId: string) => {
      if (sessionId === "sess-1") {
        return [locator("sess-1")];
      }
      if (sessionId === "sess-2") {
        return [locator("sess-2")];
      }
      return [];
    });

    expect(resolveSessionKeyForTranscriptLocator(locator("sess-2"))).toBe("agent:main:two");
    expect(resolveSessionTranscriptCandidatesMock).toHaveBeenCalledTimes(2);

    expect(resolveSessionKeyForTranscriptLocator(locator("sess-2"))).toBe("agent:main:two");
    expect(resolveSessionTranscriptCandidatesMock).toHaveBeenCalledTimes(3);
  });

  it("drops stale cached mappings and falls back to the current store contents", () => {
    let store: Record<string, SessionEntry> = {
      "agent:main:alpha": { sessionId: "sess-alpha", updatedAt: now },
      "agent:main:beta": { sessionId: "sess-beta", updatedAt: now },
    };
    loadCombinedSessionEntriesForGatewayMock.mockImplementation(() => ({
      databasePath: "(multiple)",
      entries: store,
    }));
    resolveSessionTranscriptCandidatesMock.mockImplementation(
      (sessionId: string, sessionFile?: string) => {
        if (sessionId === "sess-alpha") {
          return [locator("sess-alpha")];
        }
        if (sessionId === "sess-beta") {
          return sessionFile ? [sessionFile] : [locator("shared")];
        }
        if (sessionId === "sess-alpha-2") {
          return [locator("shared")];
        }
        return [];
      },
    );

    expect(resolveSessionKeyForTranscriptLocator(locator("shared"))).toBe("agent:main:beta");

    store = {
      "agent:main:alpha": { sessionId: "sess-alpha-2", updatedAt: now + 1 },
      "agent:main:beta": {
        sessionId: "sess-beta",
        updatedAt: now + 1,
        sessionFile: locator("sess-beta"),
      },
    };

    expect(resolveSessionKeyForTranscriptLocator(locator("shared"))).toBe("agent:main:alpha");
  });

  it("returns undefined for blank transcript locators", () => {
    expect(resolveSessionKeyForTranscriptLocator("   ")).toBeUndefined();
    expect(loadCombinedSessionEntriesForGatewayMock).not.toHaveBeenCalled();
  });

  it("prefers the deterministic session key when duplicate sessionIds share a transcript path", () => {
    const store = {
      "agent:other:main": { sessionId: "run-dup", updatedAt: now + 1 },
      "agent:main:acp:run-dup": { sessionId: "run-dup", updatedAt: now },
    } satisfies Record<string, SessionEntry>;
    loadCombinedSessionEntriesForGatewayMock.mockReturnValue({
      databasePath: "(multiple)",
      entries: store,
    });
    resolveSessionTranscriptCandidatesMock.mockReturnValue([locator("run-dup")]);

    expect(resolveSessionKeyForTranscriptLocator(locator("run-dup"))).toBe(
      "agent:main:acp:run-dup",
    );
  });

  it("prefers the freshest matching session when different sessionIds share a transcript locator", () => {
    const store = {
      "agent:main:older": { sessionId: "sess-old", updatedAt: now },
      "agent:main:newer": { sessionId: "sess-new", updatedAt: now + 10 },
    } satisfies Record<string, SessionEntry>;
    loadCombinedSessionEntriesForGatewayMock.mockReturnValue({
      databasePath: "(multiple)",
      entries: store,
    });
    resolveSessionTranscriptCandidatesMock.mockReturnValue([locator("shared")]);

    expect(resolveSessionKeyForTranscriptLocator(locator("shared"))).toBe("agent:main:newer");
  });

  it("evicts oldest entry when cache exceeds 256 entries (#63643)", () => {
    // Fill cache with 256 unique transcript paths
    for (let i = 0; i < 256; i++) {
      const sessionKey = `agent:main:session-${i}`;
      const transcriptPath = locator(`session-${i}`);
      const store = {
        [sessionKey]: { sessionId: `sid-${i}`, updatedAt: now + i },
      } satisfies Record<string, SessionEntry>;
      loadCombinedSessionEntriesForGatewayMock.mockReturnValue({
        databasePath: "(multiple)",
        entries: store,
      });
      resolveSessionTranscriptCandidatesMock.mockReturnValue([transcriptPath]);
      resolveSessionKeyForTranscriptLocator(transcriptPath);
    }

    // Now add the 257th — should evict session-0
    const overflowKey = "agent:main:session-overflow";
    const overflowPath = locator("session-overflow");
    const overflowStore = {
      [overflowKey]: { sessionId: "sid-overflow", updatedAt: now + 999 },
    } satisfies Record<string, SessionEntry>;
    loadCombinedSessionEntriesForGatewayMock.mockReturnValue({
      databasePath: "(multiple)",
      entries: overflowStore,
    });
    resolveSessionTranscriptCandidatesMock.mockReturnValue([overflowPath]);
    expect(resolveSessionKeyForTranscriptLocator(overflowPath)).toBe(overflowKey);

    // session-0 should have been evicted from cache — next lookup will
    // re-resolve from the store (returns undefined since store was mocked
    // with only the overflow entry).
    loadCombinedSessionEntriesForGatewayMock.mockReturnValue({
      databasePath: "(multiple)",
      entries: overflowStore,
    });
    resolveSessionTranscriptCandidatesMock.mockReturnValue([]);
    expect(resolveSessionKeyForTranscriptLocator(locator("session-0"))).toBeUndefined();
  });
});
