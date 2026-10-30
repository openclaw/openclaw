import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { create as createSessionRow } from "./session-row-projection-record.js";
import type { SessionRowProjection } from "./session-row-projection.js";

const hoisted = vi.hoisted(() => ({
  loadConfigMock: vi.fn<() => OpenClawConfig>(),
}));
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => hoisted.loadConfigMock() }));
const { resolveSessionForRun } = await import("./server-session-key.js");

function indexedProjection(
  entries: [key: string, sessionId: string, updatedAt?: number][],
  agentId = "main",
) {
  const rows = entries.map(([key, sessionId, updatedAt = 1]) =>
    Object.assign(
      createSessionRow({
        key,
        agentId: parseAgentSessionKey(key)?.agentId ?? agentId,
        storeTarget: { agentId: "main", storePath: "fixture" },
      }),
      { entry: { sessionId, updatedAt } },
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
    resetAgentEventsForTest();
  });
  afterEach(() => {
    resetAgentEventsForTest();
  });

  it.each([
    ["main", "agent:main:acp:run-1", true],
    ["retired", "agent:retired:acp:run-1", true],
    ["main", "agent:work:acp:run-1", false],
  ] as const)("keeps stored keys scoped to %s for %s", (agentId, key, matches) => {
    const projection = indexedProjection([[key, "run-1"]]);
    expect(resolveSessionForRun("run-1", { agentId, projection })).toEqual(
      matches ? { sessionKey: key, agentId } : undefined,
    );
  });

  it("defaults an unscoped persisted lookup to the sole configured agent", () => {
    hoisted.loadConfigMock.mockReturnValue({ agents: { entries: { work: {} } } });
    const projection = indexedProjection([["main", "run-1"]], "work");
    expectOwner("run-1", { projection }, "main", "work");
  });

  it("keeps qualified global-main ownership", () => {
    hoisted.loadConfigMock.mockReturnValue({
      session: { scope: "global" },
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    });
    const projection = indexedProjection([]);
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
    const projection = indexedProjection([]);
    expect(resolveSessionForRun("live", { projection })).toEqual({ sessionKey, agentId });
    expect(projection.findBySessionId).not.toHaveBeenCalled();
  });

  it("waits for a cached raw-key owner across roster changes", () => {
    const projection = indexedProjection([["global", "pending"]]);
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
    const projection = indexedProjection([["agent:main:main", "hidden"]]);
    registerAgentRunContext("hidden", { isControlUiVisible: false });
    expect(resolveSessionForRun("hidden", { projection })).toBeUndefined();
    expect(projection.findBySessionId).not.toHaveBeenCalled();
  });

  it("lets a scoped lookup find another agent without overwriting the live context", () => {
    const projection = indexedProjection([["agent:main:acp:run-1", "run-1"]]);
    registerAgentRunContext("run-1", { sessionKey: "agent:retired:acp:run-1" });
    expectOwner("run-1", { agentId: "main", projection }, "agent:main:acp:run-1");
    expectOwner("run-1", { projection }, "agent:retired:acp:run-1", "retired");
  });

  it("prefers a structural ID match and refuses a tied ambiguous match", () => {
    const projection = indexedProjection([
      ["agent:main:acp:run-dup", "run-dup", 100],
      ["agent:main:other", "run-dup", 999],
      ["agent:main:first", "run-tied", 100],
      ["agent:main:second", "run-tied", 100],
    ]);
    expectOwner("run-dup", { projection }, "agent:main:acp:run-dup");
    expect(resolveSessionForRun("run-tied", { projection })).toBeUndefined();
  });
});
