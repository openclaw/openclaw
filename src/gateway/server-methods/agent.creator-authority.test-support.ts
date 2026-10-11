import { expect, it } from "vitest";
import type { CronCreatorAuthorityCapability } from "../../agents/cron-creator-authority-context.js";
import {
  getAgentTestMocks,
  invokeAgent,
  operatorWriteCliClient,
  primeMainAgentRun,
  waitForAssertion,
  type AgentCommandCall,
  type AgentHandlerArgs,
} from "./agent.test-harness.js";

export function registerAgentCreatorAuthorityTests() {
  const mocks = getAgentTestMocks();
  it("carries exact cron creator authority through direct local agent RPC", async () => {
    const runId = "direct-agent-cron-authority";
    let capability: CronCreatorAuthorityCapability | undefined;
    primeMainAgentRun();
    mocks.agentCommand.mockImplementation(async (opts: AgentCommandCall) => {
      capability = opts.cronCreatorAuthorityCapability as
        | CronCreatorAuthorityCapability
        | undefined;
      expect(capability).toMatchObject({ active: true, runId });
      return { payloads: [{ text: "ok" }], meta: { durationMs: 100 } };
    });

    await invokeAgent(
      {
        message: "create an automation",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: runId,
      },
      {
        client: {
          ...operatorWriteCliClient(["operator.admin"]),
          internal: { isLocalClient: true },
        } as AgentHandlerArgs["client"],
      },
    );

    await waitForAssertion(() => expect(capability?.active).toBe(false));
  });
}
