import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { typeCheckSources } from "../../../test/helpers/typescript.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { clearCronJobActive, markCronJobActive } from "../../cron/active-jobs.js";
import { CronService } from "../../cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../../cron/service.test-harness.js";
import type { CronJob } from "../../cron/types.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { projectCronListJobs } from "../../gateway/server-methods/cron-list-projection.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  createCatalogCodeModeHarness,
  expectCompleted,
  resetCodeModeTestState,
  waitUntilCompleted,
} from "../code-mode.test-support.js";
import { createCronTool } from "./cron-tool.js";

const createJob = {
  name: "Check unpaid invoices",
  schedule: { kind: "every" as const, everyMs: 60_000 },
  sessionTarget: "main" as const,
  wakeMode: "next-heartbeat" as const,
  payload: { kind: "systemEvent" as const, text: "Check unpaid invoices" },
};
const job: CronJob = {
  ...createJob,
  id: "invoice-check",
  enabled: true,
  createdAtMs: 1_800_000_000_000,
  updatedAtMs: 1_800_000_000_000,
  state: { scheduleErrorCount: 3, lastError: "schedule error: bad cron expr" },
};
const page = { total: 1, offset: 0, limit: 50, hasMore: false, nextOffset: null };
async function createCronService() {
  const { storePath } = await makeStorePath();
  return new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: true,
    defaultAgentId: "main",
    sessionStorePath: path.join(path.dirname(storePath), "sessions.json"),
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}
function codeMode(gatewayCall: ReturnType<typeof vi.fn>) {
  const h = createCatalogCodeModeHarness([
    createCronTool(undefined, { callGatewayTool: gatewayCall }),
  ]);
  let call = 0;
  return async (code: string) =>
    waitUntilCompleted({
      details: await h.run(code, `automations-${call++}`),
      waitTool: expectDefined(h.tools[1], "Code Mode wait"),
    });
}
const { makeStorePath } = createCronStoreHarness({ prefix: "cron-code-mode-output-" });

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  onTestFinished(clearRuntimeConfigSnapshot);
});

it("accepts removal with pending session cleanup without retrying", async () => {
  onTestFinished(resetCodeModeTestState);
  const cron = await createCronService();
  const input = {
    ...createJob,
    id: "code-mode-cleanup-current",
    enabled: false,
    sessionTarget: "current" as const,
    sessionKey: "agent:main:cleanup-fixture",
    payload: { kind: "agentTurn" as const, message: "Synthetic pending cleanup" },
  };
  const activeJob = await cron.add(input);
  const marker = markCronJobActive(activeJob.id);
  const gatewayCall = vi.fn().mockImplementation(async () => await cron.remove(activeJob.id));
  const run = codeMode(gatewayCall);
  try {
    const result = await run(
      `return await automations({action:"remove",jobId:${JSON.stringify(activeJob.id)}});`,
    );
    expect(gatewayCall).toHaveBeenCalledOnce();
    expect(gatewayCall.mock.calls[0]?.[0]).toBe("cron.remove");
    expect(cron.getJob(activeJob.id)).toBeUndefined();
    expectCompleted(result, {
      ok: true,
      removed: true,
      activeRunCancellationRequested: true,
      sessionCleanup: "pending",
    });
  } finally {
    clearCronJobActive(activeJob.id, marker);
    // Reusing the id joins the owner's deferred cleanup before fixture teardown.
    await cron.add(input);
    cron.stop();
  }
});

it.each([
  [
    "list",
    "compact",
    {
      ...page,
      snapshotRevision: "old-inventory",
      jobs: [{ ...job, effectiveAgentId: "main" }],
      deliveryPreviews: {
        [job.id]: { label: "Current conversation", detail: "No external delivery" },
      },
    },
  ],
  ["run", "waitTimeoutMs", { ok: true, enqueued: true, runId: "manual:job:1" }],
] as const)("validates %s output after older Gateway rejects %s", async (action, field, reply) => {
  const gatewayCall = vi
    .fn()
    .mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: `invalid cron.${action} params: unexpected property '${field}'`,
      }),
    )
    .mockResolvedValueOnce(reply);
  const tool = createCronTool(undefined, { callGatewayTool: gatewayCall });
  const result = await tool.execute("fallback", {
    action,
    ...(action === "run" ? { jobId: "job", runMode: "force" } : {}),
  });
  expect(gatewayCall).toHaveBeenCalledTimes(2);
  if (action === "run") {
    expect(gatewayCall.mock.calls.map((call) => call[2])).toEqual([
      { id: "job", mode: "force", waitTimeoutMs: 60_000 },
      { id: "job", mode: "force" },
    ]);
    expect(result.details).toMatchObject({ runId: "manual:job:1", note: expect.any(String) });
  }
  expect(
    Value.Errors(expectDefined(tool.outputSchema, "automations output schema"), result.details),
  ).toEqual([]);
});

it("composes action results through generated declarations and JavaScript", async () => {
  onTestFinished(resetCodeModeTestState);
  const cron = await createCronService();
  onTestFinished(() => cron.stop());
  const compactJob = {
    ...job,
    agentId: "main",
    enabled: false,
    state: {
      runningAtMs: 0,
      autoDisabled: { reason: "consecutive-failures" as const, atMs: 0, consecutiveErrors: 3 },
    },
  };
  const source = {
    ...page,
    snapshotRevision: "inventory-revision",
    jobs: [freezeJsonSnapshot(structuredClone(compactJob))],
  };
  const replies: Record<string, unknown> = {
    "cron.list": { ...source, jobs: projectCronListJobs(cron, source, true) },
    "cron.status": { enabled: true, jobs: 1 },
    "cron.get": job,
    "cron.runs": {
      ...page,
      entries: [
        {
          ts: 1_800_000_000_000,
          jobId: job.id,
          action: "finished",
          status: "ok",
          summary: "Three unpaid invoices",
        },
      ],
    },
  };
  const gatewayCall = vi.fn().mockImplementation(async (method: string) => {
    if (!(method in replies)) {
      throw new Error(`Unexpected gateway method: ${method}`);
    }
    return replies[method];
  });
  const run = codeMode(gatewayCall);
  const result = await run('return await API.read("tools/automations.d.ts");');
  expect(result).toMatchObject({ status: "completed" });
  const file = result.value as { content: string };
  const composition = `
async function consume() {
  const listed = await automations({ action: "list" });
  const status = await automations({ action: "status" });
  const details = await automations({ action: "get", jobId: "invoice-check" });
  const runs = await automations({ action: "runs", jobId: details.id });
  return {
    names: listed.jobs.map(job => job.name), next: listed.nextOffset,
    enabled: status.enabled, jobCount: status.jobs,
    name: details.name, scheduleErrorCount: details.state.scheduleErrorCount,
    summaries: runs.entries.map(entry => entry.summary),
  };
}
`;
  const declarationSource =
    file.content +
    composition +
    `
async function checkContracts(action: "list" | "runs", input: Parameters<typeof automations>[0]) {
  const listed = await automations({ action: "list" });
  // @ts-expect-error Invented invoice fields are not part of an automation.
  listed.jobs[0].invoiceTotal;
  const removed = await automations({ action: "remove", jobId: "invoice-check" });
  if (removed.ok) {
    const cancellation: true | undefined = removed.activeRunCancellationRequested;
    const cleanup: "pending" | undefined = removed.sessionCleanup;
  }
  const added = await automations({ action: "add", job: ${JSON.stringify(createJob)} });
  // @ts-expect-error Add can return a direct job or a convergence envelope.
  added.id;
  const addedJob = "job" in added ? added.job : added;
  const id: string = addedJob.id;
  const updated = await automations({ action: "update", jobId: id, job: { enabled: false } });
  const warning: string | undefined = updated.deliveryPreview?.detail;
  const details = await automations({ action: "get", jobId: id });
  // @ts-expect-error Get does not return a write-time delivery preview.
  details.deliveryPreview;
  const run = await automations({ action: "run", jobId: id });
  if (!run.ok) {
    const instance: string | undefined = run.processInstanceId;
  }
  const selected = await automations({ action });
  // @ts-expect-error A dynamic action cannot promise a list result.
  selected.jobs.map(job => job.name);
  const dynamic = await automations(input);
  // @ts-expect-error Broad inputs retain all possible outputs.
  dynamic.entries.map(entry => entry.summary);
}
`;
  expect(typeCheckSources({ "/automations-consumer.ts": declarationSource })).toEqual([]);
  const composed = await run(`${composition}\nreturn await consume();`);
  expectCompleted(composed, {
    names: [job.name],
    next: null,
    enabled: true,
    jobCount: 1,
    name: job.name,
    scheduleErrorCount: 3,
    summaries: ["Three unpaid invoices"],
  });
  expect(gatewayCall).toHaveBeenCalledTimes(4);
});
