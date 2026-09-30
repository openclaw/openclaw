import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { CronJob, CronJobsListResult } from "../api/types.ts";
import {
  ciAutomationJobSpec,
  type CiAutomationOption,
  type CiAutomationTarget,
} from "./session-pr-automation-spec.ts";
import { loadCiAutomationJobs, setCiAutomationEnabled } from "./session-pr-automation.ts";

const target: CiAutomationTarget = {
  agentId: "main",
  sessionKey: "agent:main:dashboard:ci",
  sessionId: "ci-incarnation",
  owner: "example",
  repo: "project",
  number: 42,
};

function job(option: CiAutomationOption, overrides: Partial<CronJob> = {}): CronJob {
  return {
    ...ciAutomationJobSpec(target, option),
    id: option,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    state: {},
    configRevision: "revision-1",
    ...overrides,
  };
}

function page(jobs: CronJob[], overrides: Partial<CronJobsListResult> = {}): CronJobsListResult {
  return {
    jobs,
    snapshotRevision: "inventory-1",
    total: jobs.length,
    limit: 200,
    offset: 0,
    nextOffset: null,
    hasMore: false,
    ...overrides,
  };
}

function client() {
  const request = vi.fn<GatewayBrowserClient["request"]>();
  return { request, client: { request } as unknown as GatewayBrowserClient };
}

const signal = () => new AbortController().signal;

describe("CI automation API adapter", () => {
  it("reads all session-scoped pages and retains authoritative disabled state", async () => {
    const rpc = client();
    const fix = job("autoFix");
    const merge = job("autoMerge", { enabled: false });
    rpc.request
      .mockResolvedValueOnce(page([fix], { total: 2, hasMore: true, nextOffset: 1 }))
      .mockResolvedValueOnce(page([merge], { total: 2, offset: 1 }));
    expect(await loadCiAutomationJobs(rpc.client, target, signal())).toEqual({
      autoFix: fix,
      autoMerge: merge,
    });
    expect(rpc.request).toHaveBeenNthCalledWith(
      1,
      "cron.list",
      expect.objectContaining({
        sessionKey: target.sessionKey,
        sessionAgentId: target.agentId,
        includeDisabled: true,
        includeDeliveryPreviews: false,
        offset: 0,
      }),
      expect.anything(),
    );
    expect(rpc.request).toHaveBeenNthCalledWith(
      2,
      "cron.list",
      expect.objectContaining({ offset: 1 }),
      expect.anything(),
    );
  });

  it("does not infer an absent automation from a changed or incomplete inventory", async () => {
    const rpc = client();
    rpc.request
      .mockResolvedValueOnce(page([job("autoFix")], { total: 2, hasMore: true, nextOffset: 1 }))
      .mockResolvedValueOnce(page([], { snapshotRevision: "inventory-2", total: 1, offset: 1 }));
    await expect(loadCiAutomationJobs(rpc.client, target, signal())).rejects.toThrow(
      "inventory changed",
    );
    rpc.request.mockResolvedValueOnce(page([], { total: 1, hasMore: true, nextOffset: 0 }));
    await expect(loadCiAutomationJobs(rpc.client, target, signal())).rejects.toThrow(
      "invalid inventory page",
    );
  });

  it("rejects duplicate declarations and retargeted jobs without changing them", async () => {
    const rpc = client();
    rpc.request.mockResolvedValueOnce(page([job("autoFix"), job("autoFix", { id: "duplicate" })]));
    await expect(loadCiAutomationJobs(rpc.client, target, signal())).rejects.toThrow("was changed");
    rpc.request.mockResolvedValueOnce(page([job("autoMerge", { sessionTarget: "session:other" })]));
    await expect(loadCiAutomationJobs(rpc.client, target, signal())).rejects.toThrow("was changed");
    expect(rpc.request.mock.calls.every(([method]) => method === "cron.list")).toBe(true);
  });

  it("leaves unrelated session automations alone", async () => {
    const rpc = client();
    rpc.request.mockResolvedValueOnce(page([job("autoFix", { declarationKey: "daily-briefing" })]));
    expect(await loadCiAutomationJobs(rpc.client, target, signal())).toEqual({});
  });

  it("creates the selected declarative job and keeps its returned identity", async () => {
    const rpc = client();
    const created = job("autoArchive");
    rpc.request.mockResolvedValueOnce({ created: true, job: created });
    expect(
      await setCiAutomationEnabled(rpc.client, target, "autoArchive", true, undefined),
    ).toEqual(created);
    expect(rpc.request).toHaveBeenCalledExactlyOnceWith(
      "cron.add",
      expect.objectContaining({
        agentId: "main",
        sessionKey: target.sessionKey,
        sessionTarget: "isolated",
        owner: { agentId: "main", sessionKey: target.sessionKey },
        enabled: true,
        payload: { kind: "agentTurn", message: expect.stringContaining(target.sessionId) },
      }),
    );
  });

  it("uses the exact job revision for enable/disable, without replacing its spec", async () => {
    const rpc = client();
    const current = job("autoFix");
    const disabled = { ...current, enabled: false, configRevision: "revision-2" };
    rpc.request.mockResolvedValueOnce(disabled);
    expect(await setCiAutomationEnabled(rpc.client, target, "autoFix", false, current)).toEqual(
      disabled,
    );
    expect(rpc.request).toHaveBeenCalledExactlyOnceWith("cron.update", {
      id: current.id,
      expectedConfigRevision: "revision-1",
      patch: { enabled: false },
    });
    rpc.request.mockRejectedValueOnce(new Error("config revision conflict"));
    await expect(
      setCiAutomationEnabled(rpc.client, target, "autoFix", true, disabled),
    ).rejects.toThrow("conflict");
    expect(rpc.request).toHaveBeenCalledTimes(2);
  });

  it("never creates a disabled row or retries an uncertain mutation", async () => {
    const rpc = client();
    expect(
      await setCiAutomationEnabled(rpc.client, target, "autoMerge", false, undefined),
    ).toBeUndefined();
    expect(rpc.request).not.toHaveBeenCalled();
    rpc.request.mockRejectedValueOnce(new Error("connection lost after commit"));
    await expect(
      setCiAutomationEnabled(rpc.client, target, "autoMerge", true, undefined),
    ).rejects.toThrow("connection lost");
    expect(rpc.request).toHaveBeenCalledTimes(1);
  });
});
