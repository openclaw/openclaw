import { describe, expect, it, vi } from "vitest";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";
import { beginGatewayCronConfigAdoption } from "./server-reload-cron-adoption.js";

function createCron() {
  let owner = "current";
  const rejectConfigAdoption = vi.fn(async () => {
    owner = "current";
  });
  const cron = {
    reloadForConfigAdoption: vi.fn(async () => {
      owner = "candidate";
    }),
    completeConfigAdoption: vi.fn(() => {
      owner = "committed";
    }),
    rejectConfigAdoption,
  } as unknown as GatewayCronServiceContract;
  return { cron, owner: () => owner, rejectConfigAdoption };
}

describe("Gateway cron config adoption", () => {
  it("restores the current scheduler owner when preparation is rejected", async () => {
    const fixture = createCron();
    const adoption = await beginGatewayCronConfigAdoption({
      cron: fixture.cron,
      enabled: true,
      nextConfig: { agents: { ownership: "explicit", entries: { ops: {}, research: {} } } },
      failureLabel: "test reload failed",
      isCurrent: () => true,
    });

    expect(fixture.owner()).toBe("candidate");
    const failure = new Error("secret preparation failed");
    await expect(adoption?.reject(failure)).resolves.toBe(failure);
    expect(fixture.owner()).toBe("current");
    expect(fixture.rejectConfigAdoption).toHaveBeenCalledOnce();
  });

  it("commits the candidate without rollback after the acceptance edge", async () => {
    const fixture = createCron();
    const adoption = await beginGatewayCronConfigAdoption({
      cron: fixture.cron,
      enabled: true,
      nextConfig: { agents: { entries: { ops: {} } } },
      failureLabel: "test reload failed",
      isCurrent: () => true,
    });

    adoption?.complete();
    await adoption?.reject(new Error("late failure"));
    expect(fixture.owner()).toBe("committed");
    expect(fixture.rejectConfigAdoption).not.toHaveBeenCalled();
  });

  it("does not let a superseded candidate roll back a newer adoption", async () => {
    let releaseFirstReload!: () => void;
    const firstReload = new Promise<void>((resolve) => {
      releaseFirstReload = resolve;
    });
    let owner = "current";
    const reloadForConfigAdoption = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstReload;
        owner = "candidate-a";
      })
      .mockImplementationOnce(async () => {
        owner = "candidate-b";
      });
    const cron = {
      reloadForConfigAdoption,
      completeConfigAdoption: vi.fn(() => {
        owner = "committed-b";
      }),
      rejectConfigAdoption: vi.fn(async () => {
        owner = "current";
      }),
    } as unknown as GatewayCronServiceContract;

    const candidateA = beginGatewayCronConfigAdoption({
      cron,
      enabled: true,
      nextConfig: { agents: { entries: { ops: {} } } },
      failureLabel: "candidate A failed",
      isCurrent: () => true,
    });
    const candidateB = beginGatewayCronConfigAdoption({
      cron,
      enabled: true,
      nextConfig: { agents: { entries: { research: {} } } },
      failureLabel: "candidate B failed",
      isCurrent: () => true,
    });
    await vi.waitFor(() => {
      expect(reloadForConfigAdoption).toHaveBeenCalledTimes(1);
    });

    releaseFirstReload();
    const adoptionA = await candidateA;
    await adoptionA?.reject(new Error("superseded"));
    const adoptionB = await candidateB;
    adoptionB?.complete();

    expect(reloadForConfigAdoption).toHaveBeenCalledTimes(2);
    expect(owner).toBe("committed-b");
  });

  it("skips a candidate superseded while waiting for the scheduler tail", async () => {
    let releaseFirstReload!: () => void;
    const firstReload = new Promise<void>((resolve) => {
      releaseFirstReload = resolve;
    });
    let candidateBCurrent = true;
    const reloadForConfigAdoption = vi
      .fn()
      .mockImplementationOnce(async () => await firstReload)
      .mockImplementationOnce(async () => {});
    const cron = {
      reloadForConfigAdoption,
      completeConfigAdoption: vi.fn(),
      rejectConfigAdoption: vi.fn(async () => {}),
    } as unknown as GatewayCronServiceContract;
    const candidateA = beginGatewayCronConfigAdoption({
      cron,
      enabled: true,
      nextConfig: { agents: { entries: { ops: {} } } },
      failureLabel: "candidate A failed",
      isCurrent: () => true,
    });
    const candidateB = beginGatewayCronConfigAdoption({
      cron,
      enabled: true,
      nextConfig: { agents: { entries: { research: {} } } },
      failureLabel: "candidate B failed",
      isCurrent: () => candidateBCurrent,
    });
    await vi.waitFor(() => {
      expect(reloadForConfigAdoption).toHaveBeenCalledTimes(1);
    });

    candidateBCurrent = false;
    releaseFirstReload();
    const adoptionA = await candidateA;
    await adoptionA?.reject(new Error("superseded by B"));

    await expect(candidateB).resolves.toBeNull();
    expect(reloadForConfigAdoption).toHaveBeenCalledTimes(1);
  });

  it("rolls back and releases the tail when completion throws", async () => {
    let owner = "current";
    const reloadForConfigAdoption = vi.fn(async () => {
      owner = "candidate";
    });
    const rejectConfigAdoption = vi.fn(async () => {
      owner = "current";
    });
    const cron = {
      reloadForConfigAdoption,
      completeConfigAdoption: vi.fn(() => {
        throw new Error("completion failed");
      }),
      rejectConfigAdoption,
    } as unknown as GatewayCronServiceContract;
    const adoption = await beginGatewayCronConfigAdoption({
      cron,
      enabled: true,
      nextConfig: { agents: { entries: { ops: {} } } },
      failureLabel: "candidate failed",
      isCurrent: () => true,
    });

    expect(() => adoption?.complete()).toThrow("completion failed");
    await adoption?.reject(new Error("commit rejected"));
    expect(owner).toBe("current");
    expect(rejectConfigAdoption).toHaveBeenCalledOnce();

    const nextAdoption = await beginGatewayCronConfigAdoption({
      cron,
      enabled: true,
      nextConfig: { agents: { entries: { research: {} } } },
      failureLabel: "next candidate failed",
      isCurrent: () => true,
    });
    expect(reloadForConfigAdoption).toHaveBeenCalledTimes(2);
    await nextAdoption?.reject(new Error("test cleanup"));
  });
});
