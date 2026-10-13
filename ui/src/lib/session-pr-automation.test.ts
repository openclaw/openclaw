import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { CronAddParamsSchema } from "../../../packages/gateway-protocol/src/schema/cron.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { CronJob, CronJobsListResult } from "../api/types.ts";
import {
  CI_AUTOMATION_OPTIONS,
  ciAutomationDeclarationKey,
  ciAutomationJobMatches,
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
  it.each([target.sessionId, "replacement"])(
    "reads all scoped pages for %s without adopting another PR or stale archive",
    async (sessionId) => {
      const rpc = client();
      const fix = job("autoFix");
      const merge = job("autoMerge", { enabled: false });
      const ignored = [
        job("autoMerge", {
          ...ciAutomationJobSpec({ ...target, number: 43 }, "autoMerge"),
          id: "other-pr",
        }),
        job("autoArchive", {
          ...ciAutomationJobSpec({ ...target, sessionId: "old-incarnation" }, "autoArchive"),
        }),
        job("autoFix", { declarationKey: "daily-briefing" }),
      ];
      rpc.request
        .mockResolvedValueOnce(page([fix], { total: 5, hasMore: true, nextOffset: 1 }))
        .mockResolvedValueOnce(page([merge, ...ignored], { total: 5, offset: 1 }));
      expect(await loadCiAutomationJobs(rpc.client, { ...target, sessionId }, signal())).toEqual({
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
    },
  );

  it.each([
    {
      pages: [
        page([job("autoFix")], { total: 2, hasMore: true, nextOffset: 1 }),
        page([], { snapshotRevision: "inventory-2", total: 1, offset: 1 }),
      ],
      error: "inventory changed",
    },
    {
      pages: [page([], { total: 1, hasMore: true, nextOffset: 0 })],
      error: "invalid inventory page",
    },
    { pages: [page([job("autoFix"), job("autoFix", { id: "duplicate" })])], error: "was changed" },
    { pages: [page([job("autoMerge", { sessionTarget: "session:other" })])], error: "was changed" },
  ])("rejects unsafe inventory: $error", async ({ pages, error }) => {
    const rpc = client();
    for (const response of pages) {
      rpc.request.mockResolvedValueOnce(response);
    }
    await expect(loadCiAutomationJobs(rpc.client, target, signal())).rejects.toThrow(error);
    expect(rpc.request.mock.calls.every(([method]) => method === "cron.list")).toBe(true);
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

  it.each(["autoFix", "autoMerge"] as const)(
    "updates %s across reset using its exact revision",
    async (option) => {
      const rpc = client();
      const current = job(option);
      const resetTarget = { ...target, sessionId: "replacement" };
      const disabled = { ...current, enabled: false, configRevision: "revision-2" };
      rpc.request.mockResolvedValueOnce(disabled);
      expect(await setCiAutomationEnabled(rpc.client, resetTarget, option, false, current)).toEqual(
        disabled,
      );
      expect(rpc.request).toHaveBeenCalledExactlyOnceWith("cron.update", {
        id: current.id,
        expectedConfigRevision: "revision-1",
        patch: { enabled: false },
      });
      rpc.request.mockRejectedValueOnce(new Error("config revision conflict"));
      await expect(
        setCiAutomationEnabled(rpc.client, resetTarget, option, true, disabled),
      ).rejects.toThrow("conflict");
      expect(rpc.request).toHaveBeenCalledTimes(2);
    },
  );

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

describe("PR automation recipes", () => {
  it("bounds declaration keys and separates every ownership dimension and action", () => {
    const prefix = ciAutomationDeclarationKey(target, "autoMerge");
    expect(ciAutomationDeclarationKey({ ...target }, "autoMerge")).toBe(prefix);
    expect(
      ciAutomationDeclarationKey(
        { ...target, owner: target.owner.toUpperCase(), repo: target.repo.toUpperCase() },
        "autoMerge",
      ),
    ).toBe(prefix);
    const variants: CiAutomationTarget[] = [
      { ...target, agentId: "other" },
      { ...target, sessionKey: "agent:main:dashboard:task-b" },
      { ...target, owner: "other" },
      { ...target, repo: "other" },
      { ...target, number: 124 },
    ];
    const prefixes = [
      prefix,
      ...variants.map((variant) => ciAutomationDeclarationKey(variant, "autoMerge")),
    ];
    expect(new Set(prefixes).size).toBe(prefixes.length);
    const keys = CI_AUTOMATION_OPTIONS.map((option) =>
      ciAutomationJobSpec({ ...target, sessionKey: "long-session:".repeat(200) }, option),
    ).map((spec) => spec.declarationKey);
    expect(new Set(keys).size).toBe(3);
    for (const key of keys) {
      expect(key).toMatch(/^session-pr:v1:[a-f0-9]{64}:auto(?:Fix|Merge|Archive)$/u);
      expect(key?.length).toBeLessThanOrEqual(200);
    }
    expect(
      ciAutomationDeclarationKey({ ...target, owner: "a:b", repo: "c" }, "autoMerge"),
    ).not.toBe(ciAutomationDeclarationKey({ ...target, owner: "a", repo: "b:c" }, "autoMerge"));
  });

  it.each([
    ["autoFix", ["must not merge or close the PR"]],
    [
      "autoMerge",
      [
        "must not fix code or comments",
        "A passing CI rollup alone is not readiness",
        "neither authorize merging them nor block this PR",
      ],
    ],
    [
      "autoArchive",
      [
        JSON.stringify(target.sessionId),
        "never archive the replacement",
        "expectedSessionId set to the captured sessionId above",
        "If a repair or other work is active, defer rather than interrupt it",
        "A scheduled or uncertain result is not confirmed archive",
      ],
    ],
  ] as const)("binds %s to its execution owner and permitted actions", (option, instructions) => {
    const spec = ciAutomationJobSpec(target, option);
    expect(Value.Check(CronAddParamsSchema, spec)).toBe(true);
    expect(spec).toMatchObject({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      owner: { agentId: target.agentId, sessionKey: target.sessionKey },
      enabled: true,
      sessionTarget: option === "autoArchive" ? "isolated" : `session:${target.sessionKey}`,
      schedule: { kind: "every", everyMs: 300_000 },
      payload: { kind: "agentTurn" },
      delivery: { mode: "none" },
    });
    expect(ciAutomationJobMatches(spec, target, option)).toBe(true);
    for (const other of CI_AUTOMATION_OPTIONS.filter((value) => value !== option)) {
      expect(ciAutomationJobMatches(spec, target, other)).toBe(false);
    }
    const edited = {
      ...spec,
      enabled: false,
      name: "User-edited label",
      payload: { kind: "agentTurn" as const, message: "User-edited instructions" },
    };
    expect(ciAutomationJobMatches(edited, target, option)).toBe(true);
    for (const instruction of instructions) {
      expect(spec.payload.message).toContain(instruction);
    }
    if (option !== "autoArchive") {
      expect(spec.payload.message).not.toContain(JSON.stringify(target.sessionId));
      expect(spec.payload.message).toContain(
        "A conversation reset does not change the selected PR",
      );
    }
  });

  it("rejects retargeted or unowned rows even if their declaration key was copied", () => {
    const spec = ciAutomationJobSpec(target, "autoFix");
    const mismatches = [
      { ...spec, agentId: "other" },
      { ...spec, sessionKey: "agent:main:other" },
      { ...spec, owner: undefined },
      { ...spec, owner: { agentId: "other", sessionKey: target.sessionKey } },
      { ...spec, owner: { agentId: target.agentId, sessionKey: "agent:main:other" } },
      { ...spec, sessionTarget: "isolated" as const },
      { ...spec, declarationKey: undefined },
      { ...spec, payload: { kind: "systemEvent" as const, text: "not an agent turn" } },
    ];
    for (const mismatch of mismatches) {
      expect(ciAutomationJobMatches(mismatch, target, "autoFix")).toBe(false);
    }
    expect(ciAutomationJobMatches(spec, { ...target, number: 124 }, "autoFix")).toBe(false);
    expect(
      ciAutomationJobMatches(spec, { ...target, sessionId: "replacement-session" }, "autoFix"),
    ).toBe(true);
    expect(
      ciAutomationJobMatches(
        ciAutomationJobSpec(target, "autoArchive"),
        { ...target, sessionId: "replacement-session" },
        "autoArchive",
      ),
    ).toBe(false);
    const archive = ciAutomationJobSpec(target, "autoArchive");
    expect(
      ciAutomationJobMatches(
        { ...archive, sessionTarget: `session:${target.sessionKey}` },
        target,
        "autoArchive",
      ),
    ).toBe(false);
  });
});
