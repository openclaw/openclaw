import { describe, expect, it, vi } from "vitest";
import type { ApplicationGateway } from "../../app/context.ts";
import {
  createSkillWorkshopHistoryScanState,
  loadSkillWorkshopHistoryScanStatus,
  runSkillWorkshopHistoryScan,
  type SkillWorkshopHistoryScanResult,
} from "./history-scan.ts";

function result(overrides: Partial<SkillWorkshopHistoryScanResult> = {}) {
  return {
    schema: "openclaw.skill-workshop.history-scan.v1" as const,
    hasScanned: false,
    reviewedSessions: 0,
    ideasFound: 0,
    hasMore: false,
    lastScanReviewed: 0,
    lastScanIdeas: 0,
    ...overrides,
  };
}

function gateway(request: ReturnType<typeof vi.fn>): ApplicationGateway {
  return {
    snapshot: {
      connected: true,
      client: { request },
    },
  } as unknown as ApplicationGateway;
}

describe("Skill Workshop history scan controller", () => {
  it("loads status and starts with the newest window", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ hasScanned: true, hasMore: true, reviewedSessions: 20 }));
    const state = createSkillWorkshopHistoryScanState();
    const appGateway = gateway(request);

    await loadSkillWorkshopHistoryScanStatus({ agentId: "main", gateway: appGateway, state });
    expect(state.loaded).toBe(true);

    await expect(
      runSkillWorkshopHistoryScan({ agentId: "main", gateway: appGateway, state }),
    ).resolves.toBe(true);
    expect(request).toHaveBeenLastCalledWith("skills.proposals.historyScan", {
      agentId: "main",
      direction: "older",
    });
  });

  it("switches to new work after older history is exhausted", async () => {
    const request = vi.fn().mockResolvedValue(result({ hasScanned: true }));
    const state = createSkillWorkshopHistoryScanState();
    state.loaded = true;
    state.result = result({ hasScanned: true, hasMore: false });

    await runSkillWorkshopHistoryScan({ agentId: "main", gateway: gateway(request), state });

    expect(request).toHaveBeenCalledWith("skills.proposals.historyScan", {
      agentId: "main",
      direction: "newer",
    });
  });

  it("latches a failed status load until an explicit retry", async () => {
    const request = vi.fn(async () => {
      throw new Error("status unavailable");
    });
    const state = createSkillWorkshopHistoryScanState();
    const appGateway = gateway(request);

    await loadSkillWorkshopHistoryScanStatus({ agentId: "main", gateway: appGateway, state });
    expect(state.loaded).toBe(true);
    expect(state.error).toBe("status unavailable");

    await loadSkillWorkshopHistoryScanStatus({ agentId: "main", gateway: appGateway, state });
    expect(request).toHaveBeenCalledTimes(1);

    await loadSkillWorkshopHistoryScanStatus({
      agentId: "main",
      gateway: appGateway,
      state,
      force: true,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not race a scan against status loading", async () => {
    let resolveStatus: ((value: SkillWorkshopHistoryScanResult) => void) | undefined;
    const request = vi.fn(
      () =>
        new Promise<SkillWorkshopHistoryScanResult>((resolve) => {
          resolveStatus = resolve;
        }),
    );
    const state = createSkillWorkshopHistoryScanState();
    const appGateway = gateway(request);
    const statusLoad = loadSkillWorkshopHistoryScanStatus({
      agentId: "main",
      gateway: appGateway,
      state,
    });

    await expect(
      runSkillWorkshopHistoryScan({ agentId: "main", gateway: appGateway, state }),
    ).resolves.toBe(false);
    expect(request).toHaveBeenCalledTimes(1);

    resolveStatus?.(result());
    await statusLoad;
    expect(state.loaded).toBe(true);
  });

  it("reloads committed coverage after a scan returns an error", async () => {
    const committed = result({
      hasScanned: true,
      hasMore: false,
      reviewedSessions: 4,
      ideasFound: 1,
    });
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("late review failure"))
      .mockResolvedValueOnce(committed);
    const state = createSkillWorkshopHistoryScanState();
    state.loaded = true;
    state.result = result();

    await expect(
      runSkillWorkshopHistoryScan({ agentId: "main", gateway: gateway(request), state }),
    ).resolves.toBe(false);

    expect(request).toHaveBeenNthCalledWith(2, "skills.proposals.historyStatus", {
      agentId: "main",
    });
    expect(state.result).toEqual(committed);
    expect(state.error).toBe("late review failure");
  });
});
