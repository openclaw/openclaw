import { beforeEach, describe, expect, it } from "vitest";
import type { SkillSnapshot } from "../../agents/skills.js";
import type { CronJob } from "../types.js";
import {
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  runEmbeddedPiAgentMock,
} from "./run.test-harness.js";

const { createCronPromptExecutor } = await import("./run-executor.js");

type ExecutorParams = Parameters<typeof createCronPromptExecutor>[0];
type AgentTurnPayload = Extract<CronJob["payload"], { kind: "agentTurn" }>;

const agentPayload: AgentTurnPayload = { kind: "agentTurn", message: "do it" };

const job: CronJob = {
  id: "job-1",
  name: "silent delivery",
  enabled: true,
  createdAtMs: 0,
  updatedAtMs: 0,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: agentPayload,
  delivery: { mode: "none" },
  state: {},
};

function makeExecutorParams(
  overrides?: Partial<ExecutorParams>,
): ExecutorParams {
  return {
    cfg: {},
    cfgWithAgentDefaults: {},
    job,
    agentId: "agent-1",
    agentDir: "/tmp/agent",
    agentSessionKey: "agent:agent-1:main",
    runSessionKey: "agent:agent-1:cron:job-1:run:run-1",
    workspaceDir: "/tmp/workspace",
    lane: "cron",
    resolvedVerboseLevel: "off",
    thinkLevel: undefined,
    timeoutMs: 60_000,
    messageChannel: undefined,
    suppressExecNotifyOnExit: true,
    senderIsOwner: true,
    allowEmptyAssistantReplyAsSilent: true,
    resolvedDelivery: {},
    toolPolicy: {
      requireExplicitMessageTarget: false,
      disableMessageTool: true,
      forceMessageTool: false,
    },
    skillsSnapshot: { prompt: "", skills: [] } satisfies SkillSnapshot,
    agentPayload,
    liveSelection: { provider: "openai", model: "gpt-5.5" },
    cronSession: {
      storePath: "/tmp/store.json",
      store: {},
      systemSent: false,
      isNewSession: true,
      previousSessionId: undefined,
      sessionEntry: {
        sessionId: "run-1",
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: undefined,
      },
    },
    abortReason: () => "aborted",
    ...overrides,
  };
}

describe("createCronPromptExecutor silent delivery", () => {
  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    mockRunCronFallbackPassthrough();
  });

  it("passes delivery.mode none through as empty assistant silent success", async () => {
    const executor = createCronPromptExecutor(makeExecutorParams());

    await executor.runPrompt("do it");

    const call = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0] as
      | { allowEmptyAssistantReplyAsSilent?: boolean }
      | undefined;
    expect(call?.allowEmptyAssistantReplyAsSilent).toBe(true);
  });
});
