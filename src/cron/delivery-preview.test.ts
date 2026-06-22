// Delivery preview tests cover dry-run delivery plan output for cron jobs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCronJob } from "./delivery.test-helpers.js";

const mocks = vi.hoisted(() => ({
  resolveDeliveryTarget: vi.fn(),
}));

vi.mock("./isolated-agent/delivery-target.js", () => ({
  resolveDeliveryTarget: mocks.resolveDeliveryTarget,
}));

const { resolveCronDeliveryPreview } = await import("./delivery-preview.js");

describe("resolveCronDeliveryPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("previews explicit message-tool targets on no-delivery jobs", async () => {
    const job = makeCronJob({
      agentId: "avery",
      delivery: {
        mode: "none",
        channel: "topicchat",
        to: "room#42",
        threadId: 42,
        accountId: "ops",
      },
      sessionTarget: "isolated",
    });

    const preview = await resolveCronDeliveryPreview({
      cfg: {} as never,
      job,
    });

    expect(mocks.resolveDeliveryTarget).toHaveBeenCalledWith(
      {},
      "avery",
      {
        channel: "topicchat",
        to: "room#42",
        threadId: 42,
        accountId: "ops",
        sessionKey: undefined,
      },
      { dryRun: true },
    );
    expect(preview).toEqual({
      label: "none -> telegram:direct-123",
      detail: "explicit",
    });
  });

  it("does not describe unresolved no-delivery message-tool targets as fail-closed", async () => {
    mocks.resolveDeliveryTarget.mockResolvedValueOnce({
      ok: false,
      mode: "implicit",
      error: new Error("no route"),
    });
    const job = makeCronJob({
      agentId: "avery",
      delivery: {
        mode: "none",
        threadId: 0,
      },
      sessionTarget: "isolated",
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
        threadId: 0,
        accountId: undefined,
        sessionKey: undefined,
      },
      { dryRun: true },
    );
    expect(preview).toEqual({
      label: "none -> last",
      detail: "message tool target unresolved: no route",
    });
  });

  it("previews implicit no-channel announce-to-last as silent ok, not fail-closed", async () => {
    // #56078: an implicit announce-to-`last` with no resolvable channel never had
    // a sendable target, so runtime downgrades it to a silent ok (delivered=false)
    // instead of failing the run. The preview must match instead of threatening a
    // fail-closed that never happens.
    mocks.resolveDeliveryTarget.mockResolvedValueOnce({
      ok: false,
      mode: "implicit",
      error: new Error("Channel is required when delivery.channel=last has no previous channel"),
    });
    const job = makeCronJob({
      agentId: "avery",
      delivery: undefined,
    });

    const preview = await resolveCronDeliveryPreview({
      cfg: {} as never,
      job,
    });

    expect(preview.detail).toBe(
      "last -> no route, will skip delivery (ok, not delivered): Channel is required when delivery.channel=last has no previous channel",
    );
  });

  it("previews channel-resolved-but-stale last targets as fail-closed", async () => {
    // #56078 codex P1: when a channel resolves but its remembered route is
    // stale/invalid (ok:false WITH channel), that is a real delivery failure the
    // runtime keeps visible (fail-closed) — only the no-channel case is silent.
    mocks.resolveDeliveryTarget.mockResolvedValueOnce({
      ok: false,
      channel: "telegram",
      mode: "implicit",
      error: new Error("stale route"),
    });
    const job = makeCronJob({
      agentId: "avery",
      delivery: undefined,
    });

    const preview = await resolveCronDeliveryPreview({
      cfg: {} as never,
      job,
    });

    expect(preview.detail).toBe("last -> no route, will fail-closed: stale route");
  });
});
