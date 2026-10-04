import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import type { CronServiceContract } from "../cron/service-contract.js";
import {
  applyLegacyHeartbeatPromptContribution,
  setLegacyHeartbeatsEnabled,
} from "./heartbeat-compat.js";

const fixture = vi.hoisted(() => ({
  receipt: { phase: "complete", jobId: "converted" } as
    | { phase: string; jobId: string }
    | undefined,
  hook: vi.fn(),
  hasHooks: true,
  readReceipts: vi.fn(),
}));
// mock-isolation: Bind receipt selection to the fixture main agent without loading runtime session and workspace scope.
vi.mock("../agents/agent-scope.js", () => ({ listAgentIds: () => ["main"] }));
// mock-isolation: Use controlled completed or missing receipts without opening the shared-state database reader.
vi.mock("../cron/proactive-job-receipt.js", () => ({
  readDefaultProactiveJobReceiptsAsync: fixture.readReceipts,
}));
// mock-isolation: Use the fixture hook runner without attaching to process-global plugin registry state.
vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: () => fixture.hasHooks,
    runHeartbeatPromptContribution: fixture.hook,
  }),
}));

beforeEach(() => {
  fixture.receipt = { phase: "complete", jobId: "converted" };
  fixture.hook.mockReset();
  fixture.hasHooks = true;
  fixture.readReceipts
    .mockReset()
    .mockImplementation(async () => (fixture.receipt ? { main: fixture.receipt } : {}));
});

describe("deprecated heartbeat wire and hook contracts", () => {
  it("controls receipt-owned jobs only and never recreates a deleted job", async () => {
    const update = vi.fn();
    const list = vi
      .fn()
      .mockResolvedValue([makeCronJob({ id: "converted" }), makeCronJob({ id: "unrelated" })]);
    const cron = {
      list,
      update,
    } as unknown as CronServiceContract;
    await setLegacyHeartbeatsEnabled({}, cron, false);
    expect(update).toHaveBeenCalledExactlyOnceWith(
      "converted",
      { enabled: false },
      { commitGuard: undefined },
    );
    list.mockResolvedValue([]);
    await expect(setLegacyHeartbeatsEnabled({}, cron, true)).rejects.toThrow(
      "deleted jobs are not recreated",
    );
    expect(update).toHaveBeenCalledOnce();
  });

  it("invokes the historical prompt hook only for a converted/default job and caps its contribution", async () => {
    const params = {
      cfg: {},
      jobId: "unrelated",
      name: "check",
      agentId: "main",
      sessionKey: "agent:main:main",
      prompt: "check",
      assertCurrent: vi.fn(),
    };
    expect(await applyLegacyHeartbeatPromptContribution(params)).toBe("check");
    expect(fixture.hook).not.toHaveBeenCalled();
    fixture.hook.mockResolvedValue({ appendContext: "x".repeat(20_000) });
    const prompt = await applyLegacyHeartbeatPromptContribution({ ...params, jobId: "converted" });
    expect(fixture.hook).toHaveBeenCalledOnce();
    expect(prompt).toContain("check");
    expect(prompt.length).toBeLessThan(5000);

    fixture.hasHooks = false;
    fixture.readReceipts.mockReset().mockRejectedValue(new Error("receipt store unavailable"));
    expect(await applyLegacyHeartbeatPromptContribution(params)).toBe("check");
    expect(fixture.readReceipts).not.toHaveBeenCalled();
  });
});
