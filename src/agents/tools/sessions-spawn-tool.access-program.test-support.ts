import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, expect, it, vi, type Mock } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";
import type { createSessionsSpawnTool as SpawnToolFactory } from "./sessions-spawn-tool.js";

const requireRecord = createRequireRecord("record", "expected-label");
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-spawn-access-");

const visibleCreated = {
  key: "agent:main:dashboard:child",
  sessionId: "visible-child",
  runStarted: true,
  runId: "run-visible",
};

export function registerSessionsSpawnAccessProgramTests({
  createTool,
  registerAcpBackendForTest,
  mockGateway,
  mocks: hoisted,
}: {
  createTool: typeof SpawnToolFactory;
  registerAcpBackendForTest: () => void;
  mockGateway: (response: Record<string, unknown>) => InProcessGatewayCaller;
  mocks: { spawnSubagentDirectMock: Mock; spawnAcpDirectMock: Mock };
}) {
  const makeVisibleTool = (options: Parameters<typeof SpawnToolFactory>[0] = {}) =>
    createTool({
      config: { agents: { entries: { main: {} } } },
      registerRun: vi.fn(),
      countActiveRuns: () => 0,
      ...options,
    });

  it("forwards a requested cyber Access program and keeps null as inheritance", async () => {
    const tool = createTool();
    expect(tool.parameters).toMatchObject({
      properties: {
        cyberAccessProgram: { enum: ["standard", "daybreak_blue", "daybreak_red"] },
      },
    });
    await tool.execute("blue", { task: "triage", cyberAccessProgram: "daybreak_blue" });
    await tool.execute("strict-null", { task: "triage", cyberAccessProgram: null });
    expect(hoisted.spawnSubagentDirectMock.mock.calls.map(([params]) => params)).toEqual([
      expect.objectContaining({ cyberAccessProgram: "daybreak_blue" }),
      expect.objectContaining({ cyberAccessProgram: undefined }),
    ]);
  });

  it.each([
    [{ cyberAccessProgram: "gpt-daybreak-blue-latest" }, "must be one of"],
    [{ cyberAccessProgram: "daybreak_red", runtime: "acp" }, 'requires runtime="subagent"'],
    [{ cyberAccessProgram: "standard", runtime: "acp" }, 'requires runtime="subagent"'],
  ])("rejects unusable cyber Access %j before spawning", async (request, error) => {
    registerAcpBackendForTest();
    await expect(createTool().execute("access", { task: "triage", ...request })).rejects.toThrow(
      error,
    );
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it("creates a visible child with the requested cyber Access program", async () => {
    const callGateway = mockGateway(visibleCreated);
    const result = await makeVisibleTool({ callGateway }).execute("visible-access", {
      task: "triage",
      visible: true,
      cyberAccessProgram: "daybreak_blue",
    });
    expect(result.details).toMatchObject({
      status: "accepted",
      cyberAccessProgram: "daybreak_blue",
    });
    expect(callGateway).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({ cyberAccessProgram: "daybreak_blue" }),
    );
  });

  it.each([
    [undefined, "daybreak_red"],
    ["openai/other-model", undefined],
  ])("visible child with model override %s gets requester Access %s", async (model, expected) => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: "agent:main:main", storePath },
      { sessionId: "parent", updatedAt: 1, cyberAccessProgram: "daybreak_red" },
    );
    const callGateway = mockGateway(visibleCreated);
    await makeVisibleTool({
      callGateway,
      config: { session: { store: storePath }, agents: { entries: { main: {} } } },
    }).execute("visible-inherit", { task: "triage", visible: true, ...(model ? { model } : {}) });
    const [, createParams] = vi.mocked(callGateway).mock.calls[0] ?? [];
    expect(requireRecord(createParams, "sessions.create").cyberAccessProgram).toBe(expected);
  });
}
