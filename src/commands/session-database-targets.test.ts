import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSessionDatabaseTargets } from "./session-database-targets.js";

const resolveSessionDatabaseTargetsMock = vi.hoisted(() => vi.fn());

vi.mock("../config/sessions.js", () => ({
  resolveSessionDatabaseTargets: resolveSessionDatabaseTargetsMock,
}));

describe("resolveSessionDatabaseTargets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates session database target resolution to the shared config helper", () => {
    resolveSessionDatabaseTargetsMock.mockReturnValue([
      {
        agentId: "main",
        databasePath: "/tmp/main/openclaw-agent.sqlite",
      },
    ]);

    const targets = resolveSessionDatabaseTargets({}, {});

    expect(targets).toEqual([
      {
        agentId: "main",
        databasePath: "/tmp/main/openclaw-agent.sqlite",
      },
    ]);
    expect(resolveSessionDatabaseTargetsMock).toHaveBeenCalledWith({}, {});
  });
});
