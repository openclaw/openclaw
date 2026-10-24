import { Value } from "typebox/value";
import { beforeEach, expect, it, vi } from "vitest";
import { CronAddParamsSchema } from "../../../packages/gateway-protocol/src/schema/cron.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { CronJob, CronJobsListResult } from "../api/types.ts";
import {
  CI_AUTOMATION_OPTIONS,
  ciAutomationDeclarationKey as declarationKeyFor,
  ciAutomationJobMatches as matchesJob,
  ciAutomationJobSpec as jobSpec,
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
    ...jobSpec(target, option),
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

const request = vi.fn<GatewayBrowserClient["request"]>();
const client = { request } as unknown as GatewayBrowserClient;
beforeEach(() => request.mockReset());
const load = (currentTarget = target) =>
  loadCiAutomationJobs(client, currentTarget, new AbortController().signal);
const set = (
  option: CiAutomationOption,
  enabled: boolean,
  current?: CronJob,
  currentTarget = target,
) => setCiAutomationEnabled(client, currentTarget, option, enabled, current);
function expectList(call: number, params: Record<string, unknown>) {
  expect(request).toHaveBeenNthCalledWith(
    call,
    "cron.list",
    expect.objectContaining(params),
    expect.anything(),
  );
}

const recipe = (option: CiAutomationOption, overrides: Partial<CiAutomationTarget> = {}) =>
  jobSpec({ ...target, ...overrides }, option);
const declarationKey = (overrides: Partial<CiAutomationTarget> = {}) =>
  declarationKeyFor({ ...target, ...overrides }, "autoMerge");

it.each([target.sessionId, "replacement"])(
  "reads all scoped pages for %s without adopting another PR or stale archive",
  async (sessionId) => {
    const fix = job("autoFix");
    const merge = job("autoMerge", { enabled: false });
    const ignored = [
      job("autoMerge", {
        ...recipe("autoMerge", { number: 43 }),
        id: "other-pr",
      }),
      job("autoArchive", {
        ...recipe("autoArchive", { sessionId: "old-incarnation" }),
      }),
      job("autoFix", { declarationKey: "daily-briefing" }),
    ];
    request
      .mockResolvedValueOnce(page([fix], { total: 5, hasMore: true, nextOffset: 1 }))
      .mockResolvedValueOnce(page([merge, ...ignored], { total: 5, offset: 1 }));
    expect(await load({ ...target, sessionId })).toEqual({
      autoFix: fix,
      autoMerge: merge,
    });
    expectList(1, {
      sessionKey: target.sessionKey,
      sessionAgentId: target.agentId,
      includeDisabled: true,
      includeDeliveryPreviews: false,
      offset: 0,
    });
    expectList(2, { offset: 1 });
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
  for (const response of pages) {
    request.mockResolvedValueOnce(response);
  }
  await expect(load()).rejects.toThrow(error);
  expect(request.mock.calls.every(([method]) => method === "cron.list")).toBe(true);
});

it("creates the selected declarative job and keeps its returned identity", async () => {
  const created = job("autoArchive");
  request.mockResolvedValueOnce({ created: true, job: created });
  expect(await set("autoArchive", true)).toEqual(created);
  expect(request).toHaveBeenCalledExactlyOnceWith(
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
    const current = job(option);
    const resetTarget = { ...target, sessionId: "replacement" };
    const disabled = { ...current, enabled: false, configRevision: "revision-2" };
    request.mockResolvedValueOnce(disabled);
    expect(await set(option, false, current, resetTarget)).toEqual(disabled);
    expect(request).toHaveBeenCalledExactlyOnceWith("cron.update", {
      id: current.id,
      expectedConfigRevision: "revision-1",
      patch: { enabled: false },
    });
    request.mockRejectedValueOnce(new Error("config revision conflict"));
    await expect(set(option, true, disabled, resetTarget)).rejects.toThrow("conflict");
    expect(request).toHaveBeenCalledTimes(2);
  },
);

it("never creates a disabled row or retries an uncertain mutation", async () => {
  expect(await set("autoMerge", false)).toBeUndefined();
  expect(request).not.toHaveBeenCalled();
  request.mockRejectedValueOnce(new Error("connection lost after commit"));
  await expect(set("autoMerge", true)).rejects.toThrow("connection lost");
  expect(request).toHaveBeenCalledTimes(1);
});
it("bounds declaration keys and separates every ownership dimension and action", () => {
  const prefix = declarationKey();
  expect(declarationKey({ ...target })).toBe(prefix);
  expect(
    declarationKey({ owner: target.owner.toUpperCase(), repo: target.repo.toUpperCase() }),
  ).toBe(prefix);
  const variants: Partial<CiAutomationTarget>[] = [
    { agentId: "other" },
    { sessionKey: "agent:main:dashboard:task-b" },
    { owner: "other" },
    { repo: "other" },
    { number: 124 },
  ];
  const prefixes = [prefix, ...variants.map(declarationKey)];
  expect(new Set(prefixes).size).toBe(prefixes.length);
  const keys = CI_AUTOMATION_OPTIONS.map((option) =>
    recipe(option, { sessionKey: "long-session:".repeat(200) }),
  ).map((spec) => spec.declarationKey);
  expect(new Set(keys).size).toBe(3);
  for (const key of keys) {
    expect(key).toMatch(/^session-pr:v1:[a-f0-9]{64}:auto(?:Fix|Merge|Archive)$/u);
    expect(key?.length).toBeLessThanOrEqual(200);
  }
  expect(declarationKey({ owner: "a:b", repo: "c" })).not.toBe(
    declarationKey({ owner: "a", repo: "b:c" }),
  );
});

const instructions = {
  autoFix: ["must not merge or close the PR"],
  autoMerge: [
    "must not fix code or comments",
    "A passing CI rollup alone is not readiness",
    "neither authorize merging them nor block this PR",
  ],
  autoArchive: [
    JSON.stringify(target.sessionId),
    "never archive the replacement",
    "expectedSessionId set to the captured sessionId above",
    "If a repair or other work is active, defer rather than interrupt it",
    "A scheduled or uncertain result is not confirmed archive",
  ],
};
it.each(["autoFix", "autoMerge", "autoArchive"] as const)(
  "binds %s to its execution owner and permitted actions",
  (option) => {
    const spec = jobSpec(target, option);
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
    expect(matchesJob(spec, target, option)).toBe(true);
    for (const other of CI_AUTOMATION_OPTIONS.filter((value) => value !== option)) {
      expect(matchesJob(spec, target, other)).toBe(false);
    }
    const edited = {
      ...spec,
      enabled: false,
      name: "User-edited label",
      payload: { kind: "agentTurn" as const, message: "User-edited instructions" },
    };
    expect(matchesJob(edited, target, option)).toBe(true);
    const otherTarget: CronJob["sessionTarget"] =
      option === "autoArchive" ? `session:${target.sessionKey}` : "isolated";
    const mismatches = [
      { ...spec, agentId: "other" },
      { ...spec, sessionKey: "agent:main:other" },
      { ...spec, owner: undefined },
      { ...spec, owner: { agentId: "other", sessionKey: target.sessionKey } },
      { ...spec, owner: { agentId: target.agentId, sessionKey: "agent:main:other" } },
      { ...spec, sessionTarget: otherTarget },
      { ...spec, declarationKey: undefined },
      { ...spec, payload: { kind: "systemEvent" as const, text: "not an agent turn" } },
    ];
    for (const mismatch of mismatches) {
      expect(matchesJob(mismatch, target, option)).toBe(false);
    }
    expect(matchesJob(spec, { ...target, number: 124 }, option)).toBe(false);
    expect(matchesJob(spec, { ...target, sessionId: "replacement-session" }, option)).toBe(
      option !== "autoArchive",
    );
    for (const instruction of instructions[option]) {
      expect(spec.payload.message).toContain(instruction);
    }
    if (option !== "autoArchive") {
      expect(spec.payload.message).not.toContain(JSON.stringify(target.sessionId));
      expect(spec.payload.message).toContain(
        "A conversation reset does not change the selected PR",
      );
    }
  },
);
