import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { assert, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import type { CronJobCreate } from "../cron/types.js";
import {
  addAgentTurnJob,
  createCronConfig,
  loadCronService,
  resetGatewayCronMocks,
  runCronIsolatedAgentTurnMock,
  runCronSessionTurnMock,
} from "./server-cron.test-support.js";
import { cronHandlers } from "./server-methods/cron.js";

let state: ReturnType<typeof loadCronService>;
let cfg: ReturnType<typeof createCronConfig>;
beforeEach(({ task }) => {
  resetGatewayCronMocks();
  cfg = createCronConfig(`server-cron-session-target-${task.id}`);
  cfg.agents = { defaults: { systemAgent: { agentId: "main" } }, entries: { main: {}, ops: {} } };
  state = loadCronService(cfg);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  assert(typeof state.cron.stopAndDrain === "function", "Gateway cron drain is unavailable");
  await state.cron.stopAndDrain();
});

const opaqueKey = "agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==";
it.each([
  [undefined, opaqueKey, "main", opaqueKey, "per-sender"],
  ["ops", "agent:main:main", "ops", "agent:ops:main", "per-sender"],
  ["main", "global", "main", "global", "global"],
  ["ops", "global", "ops", "global", "global"],
  ["main", "main", "main", "global", "global"],
  ["main", "global", "main", "agent:main:global", "per-sender"],
  ["main", "agent:main:global", "main", "agent:main:global", "global"],
] as const)(
  "routes agent=%s session=%s to %s/%s under %s scope",
  async (agentId, sessionKey, expectedAgentId, expectedSessionKey, scope) => {
    cfg.session = { ...cfg.session, scope };
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
      cronStorePath: state.storePath,
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

/** Creates a job through the shipped `cron.add` admission handler instead of the service. */
async function addJobThroughGateway(job: CronJobCreate) {
  const respond = vi.fn();
  await expectDefined(
    cronHandlers["cron.add"],
    "cron.add",
  )({
    req: { type: "req", id: "operator-create", method: "cron.add", params: job },
    params: job,
    respond,
    context: {
      cron: state.cron,
      cronStorePath: state.storePath,
      logGateway: createInfoWarnErrorLogger(),
      getRuntimeConfig: () => cfg,
    } as never,
    client: null,
    isWebchatConnect: () => false,
  } as never);
  const [ok, payload, error] = expectDefined(respond.mock.calls[0], "cron.add response");
  assert(ok, `cron.add was refused: ${(error as { message?: string } | undefined)?.message}`);
  const view = payload as { id?: string; job?: { id: string } };
  const createdId = expectDefined((view.job ?? view).id, "created job id");
  return expectDefined(state.cron.getJob(createdId), "stored job");
}

it("runs an operator-created job under the agent its session target names", async () => {
  // Admission captures inference for the execution agent, so that agent needs a routable
  // credential in the state directory the fixture cron store lives in.
  const stateDir = path.dirname(
    expectDefined((cfg.cron as { store?: string } | undefined)?.store, "fixture cron store"),
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  await persistAuthProfileBatch({
    stateDir,
    profiles: [
      {
        profileId: "openai:session-target-fixture",
        credential: { type: "api_key", provider: "openai", key: "synthetic-session-target-key" },
      },
    ],
  });
  // The reported shape: no --agent, but a session that belongs to another agent.
  const job = await addJobThroughGateway({
    name: "operator-cross-agent",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "session:agent:ops:scheduled-report",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello" },
    delivery: { mode: "none" },
  });
  expect(job.agentId).toBe("ops");

  await state.cron.run(job.id, "force");

  expect(state.cron.getJob(job.id)?.state).toMatchObject({ lastRunStatus: "ok" });
  expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
  const [options] = expectDefined(runCronSessionTurnMock.mock.calls[0], "session turn");
  expect(options).toMatchObject({
    agentId: "ops",
    sessionKey: "agent:ops:scheduled-report",
  });
});
