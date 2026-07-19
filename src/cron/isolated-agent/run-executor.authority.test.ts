import { beforeEach, describe, expect, it } from "vitest";
import { createAuthorizationPrincipal } from "../../plugins/authorization-policy-context.js";
import type { TurnAuthoritySnapshot } from "../../plugins/authorization-policy.types.js";
import { createTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";
import type { SkillSnapshot } from "../../skills/types.js";
import type { CronJob } from "../types.js";
import type { MutableCronSession } from "./run-session-state.js";
import {
  isCliProviderMock,
  makeCronSession,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  runCliAgentMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";
import { createCronTurnAuthoritySnapshot } from "./turn-authority.js";

const { executeCronRun } = await import("./run-executor.js");

const JOB_ID = "authority-job";
const AGENT_ID = "default";
const SESSION_ID = "test-session-id";
const SESSION_KEY = `agent:${AGENT_ID}:cron:${JOB_ID}:run:${SESSION_ID}`;

const emptySkillsSnapshot: SkillSnapshot = {
  prompt: "",
  skills: [],
  resolvedSkills: [],
  version: 1,
};

function makeJob(id = JOB_ID): CronJob {
  return {
    id,
    name: "Authority Job",
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "test" },
    delivery: { mode: "none" },
    state: {},
  } as CronJob;
}

function createValidAuthority(): TurnAuthoritySnapshot {
  return createCronTurnAuthoritySnapshot({
    jobId: JOB_ID,
    agentId: AGENT_ID,
    sessionKey: SESSION_KEY,
    sessionId: SESSION_ID,
    runId: SESSION_ID,
  });
}

function createSenderAuthority(): TurnAuthoritySnapshot {
  return createTurnAuthoritySnapshot({
    principal: createAuthorizationPrincipal({
      provider: "discord",
      senderId: "maintainer",
      isAuthorizedSender: true,
    }),
    agentId: AGENT_ID,
    sessionKey: SESSION_KEY,
    sessionId: SESSION_ID,
    runId: SESSION_ID,
    conversationId: SESSION_KEY,
    trigger: "cron",
    controllerKey: `service:cron:${JOB_ID}`,
  });
}

function makeExecuteParams(
  turnAuthority: TurnAuthoritySnapshot,
): Parameters<typeof executeCronRun>[0] {
  return {
    cfg: {},
    cfgWithAgentDefaults: {},
    job: makeJob(),
    agentId: AGENT_ID,
    agentDir: "/tmp/agent-dir",
    agentSessionKey: `agent:${AGENT_ID}:cron:${JOB_ID}`,
    runSessionKey: SESSION_KEY,
    turnAuthority,
    workspaceDir: "/tmp/workspace",
    resolvedDelivery: {},
    resolvedDeliveryOk: false,
    messageToolPromptEnabled: false,
    deliveryRequested: false,
    skillsSnapshot: emptySkillsSnapshot,
    agentPayload: null,
    useSubagentFallbacks: false,
    agentVerboseDefault: undefined,
    liveSelection: { provider: "openai", model: "gpt-5.4" },
    cronSession: makeCronSession() as MutableCronSession,
    commandBody: "run a task",
    persistSessionEntry: async () => {},
    abortReason: () => "aborted",
    isAborted: () => false,
    thinkLevel: undefined,
    timeoutMs: 60_000,
    suppressExecNotifyOnExit: true,
  };
}

const foreignAuthorities: Array<{ label: string; authority: TurnAuthoritySnapshot }> = [
  { label: "sender principal", authority: createSenderAuthority() },
  {
    label: "another cron job",
    authority: createCronTurnAuthoritySnapshot({
      jobId: "other-job",
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      runId: SESSION_ID,
    }),
  },
  {
    label: "another agent",
    authority: createCronTurnAuthoritySnapshot({
      jobId: JOB_ID,
      agentId: "other-agent",
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      runId: SESSION_ID,
    }),
  },
  {
    label: "another session key",
    authority: createCronTurnAuthoritySnapshot({
      jobId: JOB_ID,
      agentId: AGENT_ID,
      sessionKey: `${SESSION_KEY}:other`,
      sessionId: SESSION_ID,
      runId: SESSION_ID,
    }),
  },
  {
    label: "another session id",
    authority: createCronTurnAuthoritySnapshot({
      jobId: JOB_ID,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      sessionId: "other-session",
      runId: SESSION_ID,
    }),
  },
  {
    label: "another run id",
    authority: createCronTurnAuthoritySnapshot({
      jobId: JOB_ID,
      agentId: AGENT_ID,
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      runId: "other-run",
    }),
  },
];

describe.each(["embedded", "cli"] as const)("executeCronRun %s authority", (runtime) => {
  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    isCliProviderMock.mockReturnValue(runtime === "cli");
    mockRunCronFallbackPassthrough();
    runCliAgentMock.mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: { agentMeta: {} },
    });
  });

  it.each(foreignAuthorities)("rejects $label before runner start", async ({ authority }) => {
    await expect(executeCronRun(makeExecuteParams(authority))).rejects.toThrow(
      "cron execution requires matching scheduler-issued turn authority",
    );

    expect(runEmbeddedAgentMock).not.toHaveBeenCalled();
    expect(runCliAgentMock).not.toHaveBeenCalled();
  });

  it("accepts the exact scheduler authority for the run", async () => {
    const authority = createValidAuthority();

    await expect(executeCronRun(makeExecuteParams(authority))).resolves.toEqual(
      expect.objectContaining({ fallbackProvider: "openai", fallbackModel: "gpt-5.4" }),
    );

    const selectedRunner = runtime === "cli" ? runCliAgentMock : runEmbeddedAgentMock;
    const otherRunner = runtime === "cli" ? runEmbeddedAgentMock : runCliAgentMock;
    expect(selectedRunner).toHaveBeenCalledOnce();
    expect(selectedRunner.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ turnAuthority: authority }),
    );
    expect(otherRunner).not.toHaveBeenCalled();
  });
});
