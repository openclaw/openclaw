import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimAgentRunContext,
  getAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunContext,
  resetAgentRunRegistryForTest,
  rotateAgentRunRegistryLifecycleGeneration,
} from "../../infra/agent-run-registry.js";
import { createCronTool } from "./cron-tool.js";

const runId = "automation-invocation";
const jobId = "automation-job";

afterEach(resetAgentRunRegistryForTest);

function registerRun(pacingEnabled = false) {
  const state = { current: true };
  const invocation = {
    pacingEnabled,
    closed: false,
    assertCurrent() {
      if (!state.current) {
        throw new Error("Automation source is no longer active");
      }
    },
  };
  const claim = claimAgentRunContext(
    runId,
    { cronRunsByJobId: new Map([[jobId, invocation]]) },
    { trackOwner: true, ownsContext: true },
  );
  return { invocation, claim, state };
}

function scopedTool(callGatewayTool = vi.fn()) {
  return createCronTool({ selfRemoveOnlyJobId: jobId, runId }, { callGatewayTool });
}

describe("automation invocation actions", () => {
  it.each([false, true])("advertises only admitted run capabilities (paced=%s)", (pacing) => {
    const unscoped = createCronTool();
    const inactive = scopedTool();
    registerRun(pacing);
    const active = scopedTool();
    for (const action of ["scratch_get", "scratch_set", "record_result", "next_check"]) {
      const args = { action };
      expect(Value.Check(unscoped.parameters, args)).toBe(false);
      expect(Value.Check(inactive.parameters, args)).toBe(false);
      expect(Value.Check(active.parameters, args)).toBe(action !== "next_check" || pacing);
    }
    expect(unscoped.parameters).not.toHaveProperty("properties.mode");
    expect(unscoped.parameters).not.toHaveProperty("properties.job.properties.wakeMode");
  });

  it("keeps scratch reads and CAS writes bound to the current job", async () => {
    registerRun();
    const callGateway = vi.fn().mockResolvedValue({
      scratch: { content: "before", revision: 7, updatedAtMs: 1 },
      currentRevision: 7,
      maxBytes: 262144,
    });
    const tool = scopedTool(callGateway);
    const read = await tool.execute("read", { action: "scratch_get" });
    expect(read.details).toMatchObject({ currentRevision: 7 });
    await tool.execute("write", {
      action: "scratch_set",
      content: "after",
      expectedRevision: 7,
    });
    expect(callGateway.mock.calls.map(([method, , params]) => ({ method, params }))).toEqual([
      { method: "cron.scratch.get", params: { id: jobId } },
      { method: "cron.scratch.set", params: { id: jobId, content: "after", expectedRevision: 7 } },
    ]);
    await expect(
      tool.execute("no-cas", { action: "scratch_set", content: "stale" }),
    ).rejects.toThrow("expectedRevision");
    await expect(tool.execute("other", { action: "scratch_get", jobId: "other" })).rejects.toThrow(
      "restricted to the current automation",
    );
    expect(callGateway).toHaveBeenCalledTimes(2);
  });

  it("rejects scratch replies after awaited work retires the invocation", async () => {
    const { invocation } = registerRun();
    const tool = scopedTool(
      vi.fn().mockImplementation(async () => {
        invocation.closed = true;
        return { scratch: null, currentRevision: 0, maxBytes: 262144 };
      }),
    );
    await expect(tool.execute("read", { action: "scratch_get" })).rejects.toThrow(
      "no longer active",
    );
  });

  it("records one concise result on the current invocation without a Gateway mutation", async () => {
    registerRun();
    const gateway = vi.fn();
    const tool = scopedTool(gateway);
    await expect(
      tool.execute("empty", { action: "record_result", outcome: "done", summary: " " }),
    ).rejects.toThrow();
    await expect(
      tool.execute("long", { action: "record_result", outcome: "done", summary: "x".repeat(2001) }),
    ).rejects.toThrow("1–2000");
    const result = await tool.execute("result", {
      action: "record_result",
      outcome: "progress",
      summary: "  Checked the queue  ",
    });
    expect(result.details).toEqual({ ok: true, outcome: "progress", summary: "Checked the queue" });
    expect(getAgentRunContext(runId)?.cronRunsByJobId?.get(jobId)?.result).toEqual({
      outcome: "progress",
      summary: "Checked the queue",
    });
    await expect(
      tool.execute("duplicate", { action: "record_result", outcome: "done", summary: "Again" }),
    ).rejects.toThrow("already accepted");
    expect(gateway).not.toHaveBeenCalled();
  });

  it.each(["closed", "source", "replaced", "released", "rotated"] as const)(
    "rejects retained tools after invocation authority is %s",
    async (transition) => {
      const { invocation, claim, state } = registerRun();
      const gateway = vi.fn();
      const tool = scopedTool(gateway);
      switch (transition) {
        case "closed":
          invocation.closed = true;
          break;
        case "source":
          state.current = false;
          break;
        case "replaced":
          registerRun();
          break;
        case "released":
          releaseAgentRunContext(runId, claim);
          registerAgentRunContext(runId, { cronRunsByJobId: new Map([[jobId, invocation]]) });
          break;
        case "rotated":
          rotateAgentRunRegistryLifecycleGeneration();
          break;
      }
      await expect(
        tool.execute("late", { action: "record_result", outcome: "done", summary: "Late result" }),
      ).rejects.toThrow("no longer active");
      await expect(
        tool.execute("late-write", { action: "scratch_set", content: "late", expectedRevision: 0 }),
      ).rejects.toThrow("no longer active");
      expect(getAgentRunContext(runId)?.cronRunsByJobId?.get(jobId)?.result).toBeUndefined();
      expect(gateway).not.toHaveBeenCalled();
    },
  );
});
