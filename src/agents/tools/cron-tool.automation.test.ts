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
let ownedClaim: string | undefined;
type Invocation =
  NonNullable<AgentRunContext["cronRunsByJobId"]> extends Map<string, infer T> ? T : never;

function createInvocation(nextCheckEnabled = false) {
  const invocation: Invocation = { nextCheckEnabled, assertCurrent: () => {} };
  ownedClaim = claimAgentRunContext(
    runId,
    {
      sessionKey: "agent:main:main",
      cronRunsByJobId: new Map([[jobId, invocation]]),
    },
    { trackOwner: true, ownsContext: true },
  );
  return {
    invocation,
    tool: createTestCronTool({
      runId,
      selfRemoveOnlyJobId: jobId,
      agentSessionKey: "agent:main:main",
    }),
  };
}

describe("automation invocation tools", () => {
  installCronToolTestFixture();
  afterEach(() => {
    releaseAgentRunContext(runId, ownedClaim);
    clearAgentRunContext(runId);
    ownedClaim = undefined;
  });

  it.each(["inactive", "active", "paced"] as const)(
    "describes available invocation actions for a %s automation",
    (state) => {
      const invocation = state === "inactive" ? undefined : createInvocation(state === "paced");
      const tool = invocation?.tool ?? createTestCronTool({ runId, selfRemoveOnlyJobId: jobId });
      expect(tool.description.includes("scratch_get")).toBe(state !== "inactive");
      expect(tool.description.includes("record_result")).toBe(state !== "inactive");
      expect(tool.description.includes("next_check")).toBe(state === "paced");
    },
  );

  it("accepts one concise structured result without dispatching another turn", async () => {
    const { invocation, tool } = createInvocation();
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

  it("accepts no_change without boilerplate and rejects invalid meaningful summaries", async () => {
    const { invocation, tool } = createInvocation();
    for (const summary of [undefined, "   ", "x".repeat(2001)]) {
      await expect(
        tool.execute("invalid", { action: "record_result", outcome: "progress", summary }),
      ).rejects.toThrow();
      expect(invocation.result).toBeUndefined();
    }
    await expect(
      tool.execute("quiet", { action: "record_result", outcome: "no_change" }),
    ).resolves.toMatchObject({ details: { ok: true, outcome: "no_change" } });
    expect(invocation.result).toEqual({ outcome: "no_change" });
  });

  it.each(["closed", "replacement", "released"] as const)(
    "retires retained result and scratch tools when the invocation is %s",
    async (reason) => {
      const { invocation, tool } = createInvocation();
      if (reason === "closed") {
        invocation.closed = true;
      } else if (reason === "replacement") {
        registerAgentRunContext(runId, {
          cronRunsByJobId: new Map([[jobId, { ...invocation }]]),
        });
      } else {
        releaseAgentRunContext(runId, ownedClaim);
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
    const { invocation, tool } = createInvocation();
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
