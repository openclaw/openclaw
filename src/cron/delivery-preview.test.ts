import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "./types.js";

const resolveDeliveryTarget = vi.hoisted(() =>
  vi.fn(async () => ({ ok: true as const, channel: "slack", to: "D0ACC24QT0U" })),
);
const resolveDefaultAgentId = vi.hoisted(() => vi.fn(() => "main"));

vi.mock("./isolated-agent/delivery-target.js", () => ({
  resolveDeliveryTarget,
}));

vi.mock("../agents/agent-scope-config.js", () => ({
  resolveDefaultAgentId,
}));

import { resolveCronDeliveryPreviews } from "./delivery-preview.js";

function createJob(id: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello" },
    delivery: { mode: "announce", channel: "slack", to: "D0ACC24QT0U" },
    state: {},
    ...overrides,
  };
}

describe("resolveCronDeliveryPreviews", () => {
  beforeEach(() => {
    resolveDeliveryTarget.mockClear().mockResolvedValue({
      ok: true,
      channel: "slack",
      to: "D0ACC24QT0U",
    });
    resolveDefaultAgentId.mockClear().mockReturnValue("main");
  });

  it("dedupes identical delivery target lookups within a page", async () => {
    const previews = await resolveCronDeliveryPreviews({
      cfg: {} as OpenClawConfig,
      defaultAgentId: "main",
      jobs: [createJob("job-1"), createJob("job-2")],
    });

    expect(resolveDeliveryTarget).toHaveBeenCalledTimes(1);
    expect(previews["job-1"]).toEqual(previews["job-2"]);
  });

  it("reuses the cached preview on a subsequent call", async () => {
    const firstJob = createJob("job-1", {
      delivery: { mode: "announce", channel: "slack", to: "D0CACHE1" },
    });
    const secondJob = createJob("job-2", {
      delivery: { mode: "announce", channel: "slack", to: "D0CACHE1" },
    });

    await resolveCronDeliveryPreviews({
      cfg: {} as OpenClawConfig,
      defaultAgentId: "main",
      jobs: [firstJob],
    });
    await resolveCronDeliveryPreviews({
      cfg: {} as OpenClawConfig,
      defaultAgentId: "main",
      jobs: [secondJob],
    });

    expect(resolveDeliveryTarget).toHaveBeenCalledTimes(1);
  });
});
