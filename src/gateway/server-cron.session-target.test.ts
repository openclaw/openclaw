import { expectDefined } from "@openclaw/normalization-core";
import { assert, afterEach, beforeEach, expect, it } from "vitest";
import {
  addAgentTurnJob,
  createCronConfig,
  loadCronService,
  resetGatewayCronMocks,
  runCronIsolatedAgentTurnMock,
  runCronSessionTurnMock,
} from "./server-cron.test-support.js";

let state: ReturnType<typeof loadCronService>;
beforeEach(({ task }) => {
  resetGatewayCronMocks();
  const cfg = createCronConfig(`server-cron-session-target-${task.id}`);
  cfg.agents = { defaults: { systemAgent: { agentId: "main" } }, entries: { main: {}, ops: {} } };
  state = loadCronService(cfg);
});
afterEach(async () => {
  assert(typeof state.cron.stopAndDrain === "function", "Gateway cron drain is unavailable");
  await state.cron.stopAndDrain();
});

const opaqueKey = "agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==";
it.each([
  [undefined, opaqueKey, "main", opaqueKey],
  ["ops", "agent:main:main", "ops", "agent:ops:main"],
])(
  "routes agent=%s session=%s through to controller-owned cron turns",
  async (agentId, sessionKey, expectedAgentId, expectedSessionKey) => {
    const job = await addAgentTurnJob(state, "custom-session", "hello", {
      agentId,
      sessionTarget: `session:${sessionKey}`,
    });

    await state.cron.run(job.id, "force");

    expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
    const [options] = expectDefined(runCronSessionTurnMock.mock.calls[0], "session turn");
    expect(options).toMatchObject({
      agentId: expectedAgentId,
      sessionKey: expectedSessionKey,
    });
  },
);

it("refuses a stored job whose explicit session belongs to another agent", async () => {
  const job = await addAgentTurnJob(state, "mismatched-session", "hello", {
    agentId: "main",
    sessionTarget: "session:agent:ops:scheduled-report",
    deleteAfterRun: false,
  });

  await state.cron.run(job.id, "force");

  expect(state.cron.getJob(job.id)?.state).toMatchObject({
    lastRunStatus: "error",
    lastError: expect.stringMatching(/session target belongs to another agent/i),
  });
  expect(runCronSessionTurnMock).not.toHaveBeenCalled();
  expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
});

it.each(["current", "isolated"] as const)(
  "keeps %s turns on detached execution despite a captured result conversation",
  async (sessionTarget) => {
    const job = await addAgentTurnJob(state, "detached", "hello", {
      sessionTarget,
      sessionKey: "agent:main:captured-result",
    });
    await state.cron.run(job.id, "force");
    expect(runCronSessionTurnMock).not.toHaveBeenCalled();
    const [options] = expectDefined(runCronIsolatedAgentTurnMock.mock.calls[0], "detached turn");
    expect(options).toMatchObject({ trigger: "cron", sessionKey: `cron:${job.id}` });
  },
);
