import "./sessions-spawn-tool.mocks.test-support.js";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { supportedSpawnModelChoice } from "../subagents/spawn/subagent-spawn.test-helpers.js";

const { hoisted } = await import("./sessions-spawn-tool.mocks.test-support.js");
let createSessionsSpawnTool: typeof import("./sessions-spawn-tool.js").createSessionsSpawnTool;
let createSessionsCreateTool: typeof import("./sessions-create-tool.js").createSessionsCreateTool;

beforeAll(async () => {
  ({ createSessionsSpawnTool } = await import("./sessions-spawn-tool.js"));
  ({ createSessionsCreateTool } = await import("./sessions-create-tool.js"));
});
beforeEach(() => {
  setRuntimeConfigSnapshot({});
  hoisted.prepareModelChoiceMock.mockReset().mockImplementation(supportedSpawnModelChoice);
  hoisted.spawnSubagentDirectMock.mockReset().mockResolvedValue({
    status: "accepted",
    context: "isolated",
    childSessionKey: "agent:main:subagent:1",
    runId: "run-subagent",
  });
  hoisted.inProcessCreationMock.mockReset().mockResolvedValue({
    key: "agent:main:dashboard:created",
    sessionId: "created-session",
    runStarted: false,
  });
});
afterEach(() => clearRuntimeConfigSnapshot());

// A scheduled run's owner bit comes from its admission; a requester who later
// stops being an owner must not keep stamping owner spawn receipts.
it("records a retained owner bit only while the scheduled requester is still an owner", async () => {
  let owner = true;
  const tool = createSessionsSpawnTool({
    agentSessionKey: "agent:main:main",
    senderIsOwner: true,
    assertSenderOwnerCurrent: () => {
      if (!owner) {
        throw new Error("requester is no longer an owner");
      }
    },
  });
  await tool.execute("owner-child", { task: "owner work" });
  owner = false;
  await tool.execute("revoked-child", { task: "after revocation" });
  expect(hoisted.spawnSubagentDirectMock.mock.calls.map(([, ctx]) => ctx.senderIsOwner)).toEqual([
    true,
    false,
  ]);
});

// sessions_create shares the spawn tool's options and commit guard.
it("rechecks the scheduled requester's owner status for sessions_create", async () => {
  let owner = true;
  const tool = createSessionsCreateTool({
    agentSessionKey: "agent:main:main",
    countActiveRuns: () => 0,
    senderIsOwner: true,
    assertSenderOwnerCurrent: () => {
      if (!owner) {
        throw new Error("requester is no longer an owner");
      }
    },
  });
  await tool.execute("owner-create", { label: "owner" });
  owner = false;
  await tool.execute("revoked-create", { label: "after revocation" });
  expect(
    hoisted.inProcessCreationMock.mock.calls.map((call) => call[2].requesterSenderIsOwner),
  ).toEqual([true, false]);
});
