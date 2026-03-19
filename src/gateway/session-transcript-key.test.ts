import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";

const {
  loadConfigMock,
  loadCombinedSessionStoreForGatewayMock,
  resolveGatewaySessionStoreTargetMock,
  resolveSessionTranscriptCandidatesMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(() => ({ session: {} })),
  loadCombinedSessionStoreForGatewayMock: vi.fn(),
  resolveGatewaySessionStoreTargetMock: vi.fn(),
  resolveSessionTranscriptCandidatesMock: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("./session-utils.js", () => ({
  loadCombinedSessionStoreForGateway: loadCombinedSessionStoreForGatewayMock,
  resolveGatewaySessionStoreTarget: resolveGatewaySessionStoreTargetMock,
  resolveSessionTranscriptCandidates: resolveSessionTranscriptCandidatesMock,
}));

import {
  clearSessionTranscriptKeyCacheForTests,
  resolveSessionKeyForTranscriptFile,
} from "./session-transcript-key.js";

describe("resolveSessionKeyForTranscriptFile", () => {
  beforeEach(() => {
    clearSessionTranscriptKeyCacheForTests();
    loadConfigMock.mockClear();
    loadCombinedSessionStoreForGatewayMock.mockReset();
    resolveGatewaySessionStoreTargetMock.mockReset();
    resolveSessionTranscriptCandidatesMock.mockReset();
    resolveGatewaySessionStoreTargetMock.mockImplementation(({ key }: { key: string }) => ({
      agentId: "main",
      storePath: "/tmp/sessions.json",
      canonicalKey: key,
      storeKeys: [key],
    }));
  });

  it("reuses the cached session key for repeat transcript lookups", () => {
    const store = {
      "agent:main:one": { sessionId: "sess-1" },
      "agent:main:two": { sessionId: "sess-2" },
    } satisfies Record<string, SessionEntry>;
    loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "(multiple)",
      store,
    });
    resolveSessionTranscriptCandidatesMock.mockImplementation((sessionId: string) => {
      if (sessionId === "sess-1") {
        return ["/tmp/one.jsonl"];
      }
      if (sessionId === "sess-2") {
        return ["/tmp/two.jsonl"];
      }
      return [];
    });

    expect(resolveSessionKeyForTranscriptFile("/tmp/two.jsonl")).toBe("agent:main:two");
    expect(resolveSessionTranscriptCandidatesMock).toHaveBeenCalledTimes(2);

    expect(resolveSessionKeyForTranscriptFile("/tmp/two.jsonl")).toBe("agent:main:two");
    expect(resolveSessionTranscriptCandidatesMock).toHaveBeenCalledTimes(3);
  });

  it("drops stale cached mappings and falls back to the current store contents", () => {
    let store: Record<string, SessionEntry> = {
      "agent:main:alpha": { sessionId: "sess-alpha" },
      "agent:main:beta": { sessionId: "sess-beta" },
    };
    loadCombinedSessionStoreForGatewayMock.mockImplementation(() => ({
      storePath: "(multiple)",
      store,
    }));
    resolveSessionTranscriptCandidatesMock.mockImplementation(
      (sessionId: string, _storePath?: string, sessionFile?: string) => {
        if (sessionId === "sess-alpha") {
          return ["/tmp/alpha.jsonl"];
        }
        if (sessionId === "sess-beta") {
          return sessionFile ? [sessionFile] : ["/tmp/shared.jsonl"];
        }
        if (sessionId === "sess-alpha-2") {
          return ["/tmp/shared.jsonl"];
        }
        return [];
      },
    );

    expect(resolveSessionKeyForTranscriptFile("/tmp/shared.jsonl")).toBe("agent:main:beta");

    store = {
      "agent:main:alpha": { sessionId: "sess-alpha-2" },
      "agent:main:beta": { sessionId: "sess-beta", sessionFile: "/tmp/beta.jsonl" },
    };

    expect(resolveSessionKeyForTranscriptFile("/tmp/shared.jsonl")).toBe("agent:main:alpha");
  });

  it("returns undefined for blank transcript paths", () => {
    expect(resolveSessionKeyForTranscriptFile("   ")).toBeUndefined();
    expect(loadCombinedSessionStoreForGatewayMock).not.toHaveBeenCalled();
  });
});
