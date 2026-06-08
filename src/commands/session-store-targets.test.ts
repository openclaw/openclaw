// Session store target tests cover session-store path resolution for command surfaces.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCommandSessionStoreTargets } from "./session-store-targets.js";

const resolveAgentSessionStoreTargetsSyncMock = vi.hoisted(() => vi.fn());
const resolveSessionStoreTargetsMock = vi.hoisted(() => vi.fn());

vi.mock("../config/sessions.js", () => ({
  resolveAgentSessionStoreTargetsSync: resolveAgentSessionStoreTargetsSyncMock,
  resolveSessionStoreTargets: resolveSessionStoreTargetsMock,
}));

describe("resolveCommandSessionStoreTargets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentSessionStoreTargetsSyncMock.mockReturnValue([]);
  });

  it("delegates session store target resolution to the shared config helper", () => {
    resolveSessionStoreTargetsMock.mockReturnValue([
      { agentId: "main", storePath: "/tmp/main-sessions.json" },
    ]);

    const targets = resolveCommandSessionStoreTargets({}, {});

    expect(targets).toEqual([{ agentId: "main", storePath: "/tmp/main-sessions.json" }]);
    expect(resolveSessionStoreTargetsMock).toHaveBeenCalledWith({}, {});
  });

  it("uses an existing on-disk agent session store even when the current config registry does not list the agent", () => {
    resolveAgentSessionStoreTargetsSyncMock.mockReturnValue([
      { agentId: "mira-main", storePath: "/tmp/agents/mira-main/sessions/sessions.json" },
    ]);

    const targets = resolveCommandSessionStoreTargets({}, { agent: "mira-main" });

    expect(targets).toEqual([
      { agentId: "mira-main", storePath: "/tmp/agents/mira-main/sessions/sessions.json" },
    ]);
    expect(resolveAgentSessionStoreTargetsSyncMock).toHaveBeenCalledWith({}, "mira-main");
    expect(resolveSessionStoreTargetsMock).not.toHaveBeenCalled();
  });

  it("falls back to the shared config helper so truly unknown agents are still rejected", () => {
    resolveSessionStoreTargetsMock.mockImplementation(() => {
      throw new Error("Unknown agent id");
    });

    expect(() => resolveCommandSessionStoreTargets({}, { agent: "ghost" })).toThrow(
      /Unknown agent id/,
    );
    expect(resolveAgentSessionStoreTargetsSyncMock).toHaveBeenCalledWith({}, "ghost");
    expect(resolveSessionStoreTargetsMock).toHaveBeenCalledWith({}, { agent: "ghost" });
  });
});
