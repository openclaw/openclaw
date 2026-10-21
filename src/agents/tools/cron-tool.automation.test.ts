import { afterEach, describe, expect, it } from "vitest";
import {
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunContext,
} from "../../infra/agent-run-registry.js";
import type { AgentRunContext } from "../../infra/agent-run-registry.types.js";
import {
  callGatewayMock,
  createTestCronTool,
  installCronToolTestFixture,
  readGatewayCall,
} from "./cron-tool.test-support.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";

const runId = "automation-result-run";
const jobId = "automation-result-job";
type Invocation =
  NonNullable<AgentRunContext["cronRunsByJobId"]> extends Map<string, infer T> ? T : never;

function createInvocation() {
  const invocation: Invocation = { nextCheckEnabled: false, assertCurrent: () => {} };
  const claim = claimAgentRunContext(
    runId,
    {
      sessionKey: "agent:main:main",
      cronRunsByJobId: new Map([[jobId, invocation]]),
    },
    { trackOwner: true, ownsContext: true },
  );
  return {
    invocation,
    claim,
    tool: createTestCronTool({
      runId,
      selfRemoveOnlyJobId: jobId,
      agentSessionKey: "agent:main:main",
    }),
  };
}

describe("automation invocation tools", () => {
  installCronToolTestFixture();
  let ownedClaim: string | undefined;
  afterEach(() => {
    releaseAgentRunContext(runId, ownedClaim);
    clearAgentRunContext(runId);
  });

  it("accepts one concise structured result without dispatching another turn", async () => {
    const { invocation, claim, tool } = createInvocation();
    ownedClaim = claim;
    await expect(
      tool.execute("result", {
        action: "record_result",
        outcome: "no_change",
        summary: "  Nothing new.  ",
      }),
    ).resolves.toMatchObject({
      details: { ok: true, outcome: "no_change", summary: "Nothing new." },
    });
    expect(invocation.result).toEqual({ outcome: "no_change", summary: "Nothing new." });
    await expect(
      tool.execute("duplicate", {
        action: "record_result",
        outcome: "done",
        summary: "Changed my mind.",
      }),
    ).rejects.toThrow("record_result already accepted");
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it.each(["closed", "replacement", "released"] as const)(
    "retires retained result and scratch tools when the invocation is %s",
    async (reason) => {
      const { invocation, claim, tool } = createInvocation();
      ownedClaim = claim;
      if (reason === "closed") {
        invocation.closed = true;
      } else if (reason === "replacement") {
        registerAgentRunContext(runId, {
          cronRunsByJobId: new Map([
            [
              jobId,
              {
                nextCheckEnabled: false,
                assertCurrent: () => {},
              },
            ],
          ]),
        });
      } else {
        releaseAgentRunContext(runId, claim);
      }
      await expect(
        tool.execute("stale-result", {
          action: "record_result",
          outcome: "done",
          summary: "Stale result.",
        }),
      ).rejects.toThrow("Automation invocation is no longer active");
      await expect(
        tool.execute("stale-scratch", {
          action: "scratch_set",
          content: "Stale checklist.",
          expectedRevision: 3,
        }),
      ).rejects.toThrow("Automation invocation is no longer active");
      expect(getAgentRunContext(runId)?.cronRunsByJobId?.get(jobId)?.result).toBeUndefined();
      expect(callGatewayMock).not.toHaveBeenCalled();
    },
  );

  it("carries the exact invocation fence and caller revision to the scratch owner", async () => {
    const { invocation, claim, tool } = createInvocation();
    ownedClaim = claim;
    let receiptAuthority: (() => boolean | void) | undefined;
    callGatewayMock.mockImplementationOnce(async () => {
      receiptAuthority = getGatewayToolCallerIdentity()?.receiptAuthority;
      expect(receiptAuthority?.()).not.toBe(false);
      return { ok: false, reason: "revision-conflict", currentRevision: 4 };
    });
    await expect(
      tool.execute("scratch", {
        action: "scratch_set",
        content: null,
        expectedRevision: 3,
      }),
    ).resolves.toMatchObject({
      details: { ok: false, reason: "revision-conflict", currentRevision: 4 },
    });
    expect(readGatewayCall()).toEqual({
      method: "cron.scratch.set",
      params: { id: jobId, content: null, expectedRevision: 3 },
    });
    expect(receiptAuthority).toBeDefined();
    invocation.closed = true;
    expect(receiptAuthority?.()).toBe(false);
  });
});
