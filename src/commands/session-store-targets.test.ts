import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionStoreTargets } from "./session-store-targets.js";

const resolveStorePathMock = vi.hoisted(() => vi.fn());
const resolveDefaultAgentIdMock = vi.hoisted(() => vi.fn());
const listAgentIdsMock = vi.hoisted(() => vi.fn());

vi.mock("../config/sessions.js", () => ({
  resolveStorePath: resolveStorePathMock,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
  listAgentIds: listAgentIdsMock,
}));

describe("resolveSessionStoreTargets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves the default agent store when no selector is provided", () => {
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveStorePathMock.mockReturnValue("/tmp/main-sessions.json");

    const targets = resolveSessionStoreTargets({}, {});

    expect(targets).toEqual([{ agentId: "main", storePath: "/tmp/main-sessions.json" }]);
    expect(resolveStorePathMock).toHaveBeenCalledWith(undefined, { agentId: "main" });
  });

  it("resolves all configured agent stores", () => {
    listAgentIdsMock.mockReturnValue(["main", "work"]);
    resolveStorePathMock
      .mockReturnValueOnce("/tmp/main-sessions.json")
      .mockReturnValueOnce("/tmp/work-sessions.json");

    const targets = resolveSessionStoreTargets(
      {
        session: { store: "~/.openclaw/agents/{agentId}/sessions/sessions.json" },
      },
      { allAgents: true },
    );

    expect(targets).toEqual([
      { agentId: "main", storePath: "/tmp/main-sessions.json" },
      { agentId: "work", storePath: "/tmp/work-sessions.json" },
    ]);
  });

  it("dedupes shared store paths for --all-agents", () => {
    listAgentIdsMock.mockReturnValue(["main", "work"]);
    resolveStorePathMock.mockReturnValue("/tmp/shared-sessions.json");

    const targets = resolveSessionStoreTargets(
      {
        session: { store: "/tmp/shared-sessions.json" },
      },
      { allAgents: true },
    );

    expect(targets).toEqual([{ agentId: "main", storePath: "/tmp/shared-sessions.json" }]);
    expect(resolveStorePathMock).toHaveBeenCalledTimes(2);
  });

  it("rejects unknown agent ids", () => {
    listAgentIdsMock.mockReturnValue(["main", "work"]);
    expect(() => resolveSessionStoreTargets({}, { agent: "ghost" })).toThrow(/Unknown agent id/);
  });

  it("rejects conflicting selectors", () => {
    expect(() => resolveSessionStoreTargets({}, { agent: "main", allAgents: true })).toThrow(
      /cannot be used together/i,
    );
    expect(() =>
      resolveSessionStoreTargets({}, { store: "/tmp/sessions.json", allAgents: true }),
    ).toThrow(/cannot be combined/i);
  });
});
