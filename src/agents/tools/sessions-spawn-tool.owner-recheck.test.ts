import "./sessions-spawn-tool.mocks.test-support.js";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { supportedSpawnModelChoice } from "../subagents/spawn/subagent-spawn.test-helpers.js";

const { hoisted } = await import("./sessions-spawn-tool.mocks.test-support.js");
let createSessionsSpawnTool: typeof import("./sessions-spawn-tool.js").createSessionsSpawnTool;

beforeAll(async () => {
  ({ createSessionsSpawnTool } = await import("./sessions-spawn-tool.js"));
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
