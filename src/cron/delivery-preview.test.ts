import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCronJob } from "./delivery.test-helpers.js";

const mocks = vi.hoisted(() => ({
  resolveDeliveryTarget: vi.fn(),
}));

vi.mock("./isolated-agent/delivery-target.js", () => ({
  resolveDeliveryTarget: mocks.resolveDeliveryTarget,
}));

const { clearCronDeliveryPreviewsCache, resolveCronDeliveryPreview, resolveCronDeliveryPreviews } =
  await import("./delivery-preview.js");

describe("resolveCronDeliveryPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCronDeliveryPreviewsCache();
    mocks.resolveDeliveryTarget.mockResolvedValue({
      ok: true,
      channel: "telegram",
      to: "direct-123",
      mode: "implicit",
    });
  });

  it("prefers sessionTarget session context over creator sessionKey", async () => {
    const job = makeCronJob({
      agentId: "avery",
      sessionTarget: "session:agent:avery:telegram:direct:direct-123",
      sessionKey: "agent:avery:telegram:group:ops:sender:direct-123",
      delivery: undefined,
    });

    const preview = await resolveCronDeliveryPreview({
      cfg: {} as never,
      job,
    });

    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledWith(
      {},
      "avery",
      {
        channel: "last",
        to: undefined,
        threadId: undefined,
        accountId: undefined,
        sessionKey: "agent:avery:telegram:direct:direct-123",
      },
      { dryRun: true },
    );
    expect(preview.detail).toBe(
      "resolved from last, session agent:avery:telegram:direct:direct-123",
    );
  });

  it("does not resolve routes for explicit no-delivery jobs", async () => {
    const job = makeCronJob({
      delivery: { mode: "none" },
      sessionTarget: "isolated",
    });

    const preview = await resolveCronDeliveryPreview({
      cfg: {} as never,
      job,
    });

    expect(preview).toEqual({ label: "not requested", detail: "not requested" });
    expect(mocks.resolveDeliveryTarget).not.toHaveBeenCalled();
  });

  it("reuses in-flight delivery preview resolution for identical job lists", async () => {
    let release!: () => void;
    const pending = new Promise((resolve) => {
      release = () =>
        resolve({
          ok: true,
          channel: "telegram",
          to: "direct-123",
          mode: "implicit",
        });
    });
    mocks.resolveDeliveryTarget.mockReturnValueOnce(pending);
    const job = makeCronJob({
      id: "job-1",
      agentId: "avery",
      delivery: undefined,
    });

    const first = resolveCronDeliveryPreviews({ cfg: {} as never, jobs: [job] });
    const second = resolveCronDeliveryPreviews({ cfg: {} as never, jobs: [job] });

    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toEqual({
      "job-1": {
        detail: "resolved from last, main session",
        label: "announce -> telegram:direct-123",
      },
    });
    await expect(second).resolves.toEqual({
      "job-1": {
        detail: "resolved from last, main session",
        label: "announce -> telegram:direct-123",
      },
    });
  });

  it("clears cached delivery preview results on demand", async () => {
    const job = makeCronJob({ id: "job-1", delivery: undefined });

    await resolveCronDeliveryPreviews({ cfg: {} as never, jobs: [job] });
    await resolveCronDeliveryPreviews({ cfg: {} as never, jobs: [job] });
    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledTimes(1);

    clearCronDeliveryPreviewsCache();
    await resolveCronDeliveryPreviews({ cfg: {} as never, jobs: [job] });
    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledTimes(2);
  });
});
