import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { supportedSpawnModelChoice } from "../subagents/spawn/subagent-spawn.test-helpers.js";
import { hoisted } from "./sessions-spawn-tool.mocks.test-support.js";

let createSessionsSpawnTool: typeof import("./sessions-spawn-tool.js").createSessionsSpawnTool;
type PrivateSessionsSpawnOptions = NonNullable<Parameters<typeof createSessionsSpawnTool>[0]> & {
  requesterThinkingExplicit?: boolean;
};

const requireRecord = createRequireRecord("record", "expected-non-array-record");

describe("sessions_spawn thinking provenance", () => {
  beforeAll(async () => {
    ({ createSessionsSpawnTool } = await import("./sessions-spawn-tool.js"));
  });

  beforeEach(() => {
    hoisted.prepareModelChoiceMock.mockReset().mockImplementation(supportedSpawnModelChoice);
    hoisted.spawnSubagentDirectMock.mockReset().mockResolvedValue({
      status: "accepted",
      context: "isolated",
      childSessionKey: "agent:main:subagent:1",
      runId: "run-subagent",
    });
    hoisted.spawnAcpDirectMock.mockReset();
    hoisted.registerSubagentRunMock.mockReset();
    hoisted.inProcessCreationMock.mockReset();
    hoisted.runSubagentProgressMock.mockClear();
  });

  it.each([undefined, false, true])(
    "forwards private requester provenance %s to subagent spawn",
    async (requesterThinkingExplicit) => {
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        config: { agents: { entries: { main: {} } } },
        requesterThinkingLevel: "high",
        requesterThinkingExplicit,
      } as PrivateSessionsSpawnOptions);

      const result = await tool.execute("thinking-provenance", { task: "inspect" });

      expect(result.details).toMatchObject({ status: "accepted" });
      const context = requireRecord(hoisted.spawnSubagentDirectMock.mock.calls[0]?.[1]);
      expect(context.requesterThinkingLevel).toBe("high");
      expect(context.requesterThinkingExplicit).toBe(requesterThinkingExplicit);
    },
  );
});
