import { beforeEach, describe, expect, it, vi } from "vitest";

const runSessionsArchiveMock = vi.fn();

vi.mock("../../commands/sessions-archive-core.js", () => ({
  runSessionsArchive: (...args: unknown[]) => runSessionsArchiveMock(...args),
}));

import { createSessionsArchiveTool } from "./sessions-archive-tool.js";

describe("sessions_archive tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards archive requests to the shared archive command in json mode", async () => {
    runSessionsArchiveMock.mockResolvedValue({
      allAgents: true,
      requestedKey: "agent:main:subagent:abc",
      status: "done",
      olderThan: "7d",
      stores: [
        {
          summary: { archived: 3, skipped: 1, agentId: "main" },
          actionRows: [],
          eligibleKeys: [],
        },
      ],
    });

    const tool = createSessionsArchiveTool();
    const result = await tool.execute?.("call-1", {
      sessionKey: "agent:main:subagent:abc",
      agentId: "main",
      allAgents: true,
      status: "done",
      olderThan: "7d",
      dryRun: true,
    });

    expect(runSessionsArchiveMock).toHaveBeenCalledTimes(1);
    expect(runSessionsArchiveMock).toHaveBeenCalledWith({
      sessionKey: "agent:main:subagent:abc",
      agent: "main",
      allAgents: true,
      status: "done",
      olderThan: "7d",
      dryRun: true,
    });
    expect(result?.details).toEqual({ archived: 3, skipped: 1, agentId: "main" });
  });

  it("returns structured errors when the shared command reports a failure", async () => {
    runSessionsArchiveMock.mockRejectedValue(
      new Error("Cannot archive agent:main:main: protected main session."),
    );

    const tool = createSessionsArchiveTool();
    const result = await tool.execute?.("call-2", {
      sessionKey: "agent:main:main",
    });

    expect(result?.details).toEqual({
      ok: false,
      error: "Cannot archive agent:main:main: protected main session.",
    });
  });

  it("rejects conflicting agent and agentId inputs before invoking the command", async () => {
    const tool = createSessionsArchiveTool();
    const result = await tool.execute?.("call-3", {
      agent: "main",
      agentId: "lead",
      status: "done",
    });

    expect(runSessionsArchiveMock).not.toHaveBeenCalled();
    expect(result?.details).toEqual({
      ok: false,
      error: "Provide either agent or agentId (not conflicting values for both).",
    });
  });
});
