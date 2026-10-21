import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
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
const { resolveSessionForRun } = await import("./server-session-key.js");

function indexedProjection(store: Record<string, SessionEntry>, agentId = "main") {
  const rows = Object.entries(store).map(([key, entry]) =>
    Object.assign(
      createSessionRow({
        key,
        agentId: parseAgentSessionKey(key)?.agentId ?? agentId,
        storeTarget: { agentId: "main", storePath: "fixture" },
      }),
      { entry },
    ),
  );
  return {
    findBySessionId: vi.fn<SessionRowProjection["findBySessionId"]>((query) =>
      rows.filter(({ entry }) => entry.sessionId === query.sessionId),
    ),
  };
}
function expectOwner(
  runId: string,
  options: Parameters<typeof resolveSessionForRun>[1],
  sessionKey: string,
  agentId = "main",
) {
  expect(resolveSessionForRun(runId, options)).toEqual({ sessionKey, agentId });
}

describe("resolveSessionForRun", () => {
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
    {
      agentId: "main",
      key: "agent:main:acp:run-1",
      expected: { sessionKey: "agent:main:acp:run-1", agentId: "main" },
    },
    {
      agentId: "retired",
      key: "agent:retired:acp:run-1",
      expected: { sessionKey: "agent:retired:acp:run-1", agentId: "retired" },
    },
    { agentId: "main", key: "agent:work:acp:run-1", expected: undefined },
  ])("keeps stored keys scoped to $agentId for $key", ({ agentId, key, expected }) => {
    const projection = indexedProjection({ [key]: { sessionId: "run-1", updatedAt: 123 } });
    expect(resolveSessionForRun("run-1", { agentId, projection })).toEqual(expected);
  });

  it("defaults an unscoped persisted lookup to the sole configured agent", () => {
    hoisted.loadConfigMock.mockReturnValue({ agents: { entries: { work: {} } } });
    const projection = indexedProjection({ main: { sessionId: "run-1", updatedAt: 1 } }, "work");
    expectOwner("run-1", { projection }, "main", "work");
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
    const projection = indexedProjection(
      { global: { sessionId: "global-run", updatedAt: 1 } },
      "research",
    );
    expectOwner("global-run", { agentId: "research", projection }, "global", "research");
    registerAgentRunContext("qualified-run", { sessionKey: "agent:research:main" });
    expectOwner(
      "qualified-run",
      { agentId: "research", projection },
      "agent:research:main",
      "research",
    );
    expect(resolveSessionForRun("qualified-run", { agentId: "ops", projection })).toBeUndefined();
  });

  it.each([
    { sessionKey: "global", agentId: "research" },
    { sessionKey: "agent:work:main", agentId: "work" },
  ])("uses active context $sessionKey without any persisted lookup", ({ sessionKey, agentId }) => {
    registerAgentRunContext("live", { sessionKey, agentId });
    const projection = indexedProjection({});
    expect(resolveSessionForRun("live", { projection })).toEqual({ sessionKey, agentId });
    expect(projection.findBySessionId).not.toHaveBeenCalled();
  });

  it("waits for a cached raw-key owner across roster changes", () => {
    const projection = indexedProjection({ global: { sessionId: "pending", updatedAt: 1 } });
    registerAgentRunContext("pending", { sessionKey: "global" });
    hoisted.loadConfigMock.mockReturnValue({
      session: { scope: "global" },
      agents: { entries: { main: {}, research: {} } },
    });
    expect.soft(resolveSessionForRun("pending", { projection })).toBeUndefined();
    expect.soft(resolveSessionForRun("pending", { agentId: "main", projection })).toBeUndefined();
    registerAgentRunContext("pending", { agentId: "research" });
    hoisted.loadConfigMock.mockReturnValue({
      session: { scope: "global" },
      agents: { entries: { work: {}, research: {} } },
    });
    expectOwner("pending", { projection }, "global", "research");
  });

  it("does not infer a stored parent for intentionally keyless internal runs", () => {
    const projection = indexedProjection({
      "agent:main:main": { sessionId: "hidden", updatedAt: 1 },
    });
    registerAgentRunContext("hidden", { isControlUiVisible: false });
    expect(resolveSessionForRun("hidden", { projection })).toBeUndefined();
    expect(projection.findBySessionId).not.toHaveBeenCalled();
  });

  it("lets a scoped lookup find another agent without overwriting the live context", () => {
    const projection = indexedProjection({
      "agent:main:acp:run-1": { sessionId: "run-1", updatedAt: 1 },
    });
    registerAgentRunContext("run-1", { sessionKey: "agent:retired:acp:run-1" });
    expectOwner("run-1", { agentId: "main", projection }, "agent:main:acp:run-1");
    expectOwner("run-1", { projection }, "agent:retired:acp:run-1", "retired");
  });

  it("never reloads the store when orphan events outlive the old miss TTL", () => {
    vi.useFakeTimers();
    const projection = indexedProjection({});
    for (let second = 0; second < 10; second++) {
      for (let run = 0; run < 20; run++) {
        expect(resolveSessionForRun(`orphan-${run}`, { projection })).toBeUndefined();
      }
      vi.advanceTimersByTime(1000);
    }
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).not.toHaveBeenCalled();
    registerAgentRunContext("orphan-0", { sessionKey: "agent:main:main" });
    expect(resolveSessionForRun("orphan-0", { projection })).toEqual({
      sessionKey: "agent:main:main",
      agentId: "main",
    });
  });

  it("prefers a structural ID match and refuses a tied ambiguous match", () => {
    const projection = indexedProjection({
      "agent:main:acp:run-dup": { sessionId: "run-dup", updatedAt: 100 },
      "agent:main:other": { sessionId: "run-dup", updatedAt: 999 },
      "agent:main:first": { sessionId: "run-tied", updatedAt: 100 },
      "agent:main:second": { sessionId: "run-tied", updatedAt: 100 },
    });
    expectOwner("run-dup", { projection }, "agent:main:acp:run-dup");
    expect(resolveSessionForRun("run-tied", { projection })).toBeUndefined();
  });
});
