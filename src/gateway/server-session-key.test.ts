import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import { create as createSessionRow } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";

const hoisted = vi.hoisted(() => ({
  loadConfigMock: vi.fn<() => OpenClawConfig>(),
  loadCombinedSessionStoreForGatewayMock: vi.fn(),
}));
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => hoisted.loadConfigMock() }));
vi.mock("./session-utils.js", () => ({
  loadCombinedSessionStoreForGatewayCore: (...args: unknown[]) =>
    hoisted.loadCombinedSessionStoreForGatewayMock(...args),
}));
const { resolveSessionKeyForRun } = await import("./server-session-key.js");

function indexedProjection(store: Record<string, SessionEntry>) {
  const index = new Map<string, ReturnType<SessionRowProjection["findBySessionId"]>>();
  for (const [key, entry] of Object.entries(store)) {
    const rows = index.get(entry.sessionId) ?? [];
    rows.push({
      ...createSessionRow({
        key,
        agentId: "main",
        storeTarget: { agentId: "main", storePath: "fixture" },
      }),
      entry,
    });
    index.set(entry.sessionId, rows);
  }
  return {
    findBySessionId: vi.fn<SessionRowProjection["findBySessionId"]>(
      (query) => index.get(query.sessionId) ?? [],
    ),
  };
}

describe("resolveSessionKeyForRun", () => {
  beforeEach(() => {
    hoisted.loadConfigMock.mockReturnValue({});
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReset();
    hoisted.loadCombinedSessionStoreForGatewayMock.mockImplementation(() => {
      throw new Error("run lookup must not load a complete store");
    });
    resetAgentEventsForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetAgentEventsForTest();
  });

  it.each([
    { agentId: "main", key: "agent:main:acp:run-1", expected: "acp:run-1" },
    { agentId: "retired", key: "agent:retired:acp:run-1", expected: "acp:run-1" },
    { agentId: "main", key: "agent:work:acp:run-1", expected: undefined },
  ])("keeps caller-facing keys scoped to $agentId for $key", ({ agentId, key, expected }) => {
    const projection = indexedProjection({ [key]: { sessionId: "run-1", updatedAt: 123 } });
    expect(resolveSessionKeyForRun("run-1", { agentId, projection })).toBe(expected);
  });

  it("defaults an unscoped persisted lookup to the configured default agent", () => {
    hoisted.loadConfigMock.mockReturnValue({ agents: { list: [{ id: "work", default: true }] } });
    const projection = indexedProjection({ main: { sessionId: "run-1", updatedAt: 1 } });
    expect(resolveSessionKeyForRun("run-1", { projection })).toBe("main");
    expect(projection.findBySessionId).toHaveBeenCalledWith({
      sessionId: "run-1",
      agentId: "work",
      federated: true,
    });
  });

  it("keeps literal global and qualified global-main ownership", () => {
    hoisted.loadConfigMock.mockReturnValue({
      session: { scope: "global" },
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    });
    const projection = indexedProjection({ global: { sessionId: "global-run", updatedAt: 1 } });
    expect(resolveSessionKeyForRun("global-run", { agentId: "research", projection })).toBe(
      "global",
    );
    registerAgentRunContext("qualified-run", { sessionKey: "agent:research:main" });
    expect(resolveSessionKeyForRun("qualified-run", { agentId: "research", projection })).toBe(
      "main",
    );
    expect(
      resolveSessionKeyForRun("qualified-run", { agentId: "ops", projection }),
    ).toBeUndefined();
  });

  it.each(["main", "agent:work:main"])(
    "uses active context %s without any persisted lookup",
    (sessionKey) => {
      registerAgentRunContext("live", { sessionKey });
      const projection = indexedProjection({});
      expect(resolveSessionKeyForRun("live", { projection })).toBe(sessionKey);
      expect(projection.findBySessionId).not.toHaveBeenCalled();
    },
  );

  it("does not infer a stored parent for intentionally keyless internal runs", () => {
    const projection = indexedProjection({
      "agent:main:main": { sessionId: "hidden", updatedAt: 1 },
    });
    registerAgentRunContext("hidden", { isControlUiVisible: false });
    expect(resolveSessionKeyForRun("hidden", { projection })).toBeUndefined();
    expect(projection.findBySessionId).not.toHaveBeenCalled();
  });

  it("lets a scoped lookup find another agent without overwriting the live context", () => {
    const projection = indexedProjection({
      "agent:main:acp:run-1": { sessionId: "run-1", updatedAt: 1 },
    });
    registerAgentRunContext("run-1", { sessionKey: "agent:retired:acp:run-1" });
    expect(resolveSessionKeyForRun("run-1", { agentId: "main", projection })).toBe("acp:run-1");
    expect(resolveSessionKeyForRun("run-1", { projection })).toBe("agent:retired:acp:run-1");
  });

  it("never reloads the store when orphan events outlive the old miss TTL", () => {
    vi.useFakeTimers();
    const projection = indexedProjection({});
    for (let second = 0; second < 10; second++) {
      for (let run = 0; run < 20; run++) {
        expect(resolveSessionKeyForRun(`orphan-${run}`, { projection })).toBeUndefined();
      }
      vi.advanceTimersByTime(1000);
    }
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).not.toHaveBeenCalled();
    registerAgentRunContext("orphan-0", { sessionKey: "agent:main:main" });
    expect(resolveSessionKeyForRun("orphan-0", { projection })).toBe("agent:main:main");
  });

  it("prefers a structural ID match and refuses a tied ambiguous match", () => {
    const projection = indexedProjection({
      "agent:main:acp:run-dup": { sessionId: "run-dup", updatedAt: 100 },
      "agent:main:other": { sessionId: "run-dup", updatedAt: 999 },
      "agent:main:first": { sessionId: "run-tied", updatedAt: 100 },
      "agent:main:second": { sessionId: "run-tied", updatedAt: 100 },
    });
    expect(resolveSessionKeyForRun("run-dup", { projection })).toBe("acp:run-dup");
    expect(resolveSessionKeyForRun("run-tied", { projection })).toBeUndefined();
  });
});
