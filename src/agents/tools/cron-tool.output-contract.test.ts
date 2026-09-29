import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { typeCheckSources } from "../../../test/helpers/typescript.js";
import { clearCronJobActive, markCronJobActive } from "../../cron/active-jobs.js";
import { CronService } from "../../cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../../cron/service.test-harness.js";
import type { CronJob } from "../../cron/types.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { compactCronListJob } from "../../gateway/server-methods/cron-list-projection.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { applyCodeModeCatalog } from "../code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  resultDetails,
  runUntilCompleted,
  waitUntilCompleted,
} from "../code-mode.test-support.js";
import { createCronTool } from "./cron-tool.js";

const job: CronJob = {
  id: "invoice-check",
  name: "Check unpaid invoices",
  enabled: true,
  createdAtMs: 1_800_000_000_000,
  updatedAtMs: 1_800_000_000_000,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "main",
  wakeMode: "next-heartbeat",
  payload: { kind: "systemEvent", text: "Check unpaid invoices" },
  state: {},
};
const compactJob = {
  ...compactCronListJob({
    ...job,
    agentId: "main",
    enabled: false,
    state: {
      runningAtMs: 0,
      autoDisabled: { reason: "consecutive-failures", atMs: 0, consecutiveErrors: 3 },
    },
  }),
  effectiveAgentId: "main",
};
const page = {
  total: 1,
  offset: 0,
  limit: 50,
  hasMore: false,
  nextOffset: null,
};
const list = { ...page, jobs: [compactJob], snapshotRevision: "inventory-revision" };
const deliveryPreview = { label: "Current conversation", detail: "No external delivery" };
const createJob = {
  name: job.name,
  schedule: job.schedule,
  sessionTarget: job.sessionTarget,
  wakeMode: job.wakeMode,
  payload: job.payload,
};
const history = {
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
};

describe("automations output contract", () => {
  const { makeStorePath } = createCronStoreHarness({ prefix: "cron-code-mode-output-" });
  it("accepts stored scheduler diagnostics (#157477)", async () => {
    const tool = createCronTool(undefined, {
      callGatewayTool: vi.fn().mockResolvedValue({
        ...job,
        state: { scheduleErrorCount: 3, lastError: "schedule error: bad cron expr" },
      }),
    });
    const result = await tool.execute("diagnostics", { action: "get", jobId: job.id });
    expect(Value.Errors(expectDefined(tool.outputSchema, "output schema"), result.details)).toEqual(
      [],
    );
  });

  it.each(["current"] as const)(
    "accepts successful removal with pending %s session cleanup without retrying",
    async (sessionTarget) => {
      onTestFinished(resetCodeModeTestState);
      const { storePath } = await makeStorePath();
      const cron = new CronService({
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
      const input = {
        ...createJob,
        id: `code-mode-cleanup-${sessionTarget}`,
        enabled: false,
        sessionTarget,
        sessionKey: "agent:main:cleanup-fixture",
        payload: { kind: "agentTurn" as const, message: "Synthetic pending cleanup" },
      };
      const activeJob = await cron.add(input);
      const marker = markCronJobActive(activeJob.id);
      const gatewayCall = vi.fn().mockImplementation(async () => await cron.remove(activeJob.id));
      const tool = createCronTool(undefined, { callGatewayTool: gatewayCall });
      const h = createCodeModeHarness();
      applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });
      try {
        const result = await runUntilCompleted({
          execTool: expectDefined(h.tools[0], "Code Mode exec"),
          waitTool: expectDefined(h.tools[1], "Code Mode wait"),
          code: `return await automations({action:"remove",jobId:${JSON.stringify(activeJob.id)}});`,
        });
        expect(gatewayCall).toHaveBeenCalledOnce();
        expect(gatewayCall.mock.calls[0]?.[0]).toBe("cron.remove");
        expect(cron.getJob(activeJob.id)).toBeUndefined();
        expect(result, JSON.stringify(result)).toMatchObject({
          status: "completed",
          value: { ok: true, removed: true, sessionCleanup: "pending" },
        });
      } finally {
        clearCronJobActive(activeJob.id, marker);
        // Reusing the id joins the owner's deferred cleanup before fixture teardown.
        await cron.add(input);
        cron.stop();
      }
    },
  );

  it("keeps older full inventories valid after compact fallback", async () => {
    const gatewayCall = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "invalid cron.list params: unexpected property 'compact'",
        }),
      )
      .mockResolvedValueOnce({
        ...page,
        snapshotRevision: "old-inventory",
        jobs: [{ ...job, effectiveAgentId: "main" }],
        deliveryPreviews: { [job.id]: deliveryPreview },
      });
    const tool = createCronTool(undefined, { callGatewayTool: gatewayCall });
    const result = await tool.execute("call-full", { action: "list" });
    expect(gatewayCall).toHaveBeenCalledTimes(2);
    expect(
      Value.Errors(expectDefined(tool.outputSchema, "automations output schema"), result.details),
    ).toEqual([]);
  });

  it("composes action results through generated declarations and JavaScript", async () => {
    onTestFinished(resetCodeModeTestState);
    const h = createCodeModeHarness();
    const replies: Record<string, unknown> = {
      "cron.list": list,
      "cron.status": { enabled: true, jobs: 1 },
      "cron.get": job,
      "cron.runs": history,
    };
    const gatewayCall = vi.fn().mockImplementation(async (method: string) => {
      if (!(method in replies)) {
        throw new Error(`Unexpected gateway method: ${method}`);
      }
      return replies[method];
    });
    const tool = createCronTool(undefined, { callGatewayTool: gatewayCall });
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });
    const result = await runUntilCompleted({
      execTool: expectDefined(h.tools[0], "Code Mode exec"),
      waitTool: expectDefined(h.tools[1], "Code Mode wait"),
      code: 'return await API.read("tools/automations.d.ts");',
    });
    expect(result).toMatchObject({ status: "completed" });
    const file = result.value as { content: string };
    const composition = `
async function consume() {
  const listed = await automations({ action: "list" });
  const names = listed.jobs.map(job => job.name);
  const next = listed.nextOffset;
  const status = await automations({ action: "status" });
  const enabled = status.enabled;
  const jobCount = status.jobs;
  const details = await automations({ action: "get", jobId: "invoice-check" });
  const name = details.name;
  const runs = await automations({ action: "runs", jobId: details.id });
  const summaries = runs.entries.map(entry => entry.summary);
  return { names, next, enabled, jobCount, name, summaries };
}
`;
    const fileName = "/automations-consumer.ts";
    const source =
      file.content +
      composition +
      `
async function checkContracts(action: "list" | "runs", input: Parameters<typeof automations>[0]) {
  const listed = await automations({ action: "list" });
  // @ts-expect-error Invented invoice fields are not part of an automation.
  listed.jobs[0].invoiceTotal;
  const removed = await automations({ action: "remove", jobId: "invoice-check" });
  if (removed.ok) {
    const cleanup: "pending" | undefined = removed.sessionCleanup;
  }
  const added = await automations({ action: "add", job: ${JSON.stringify(createJob)} });
  // @ts-expect-error Add can return a direct job or a convergence envelope.
  added.id;
  const addedJob = "job" in added ? added.job : added;
  const id: string = addedJob.id;
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
    expect(typeCheckSources({ [fileName]: source })).toEqual([]);
    const composed = await waitUntilCompleted({
      details: resultDetails(
        await expectDefined(h.tools[0], "Code Mode exec").execute("compose-automations", {
          code: `${composition}\nreturn await consume();`,
        }),
      ),
      waitTool: expectDefined(h.tools[1], "Code Mode wait"),
    });
    expect(composed, JSON.stringify(composed)).toMatchObject({
      status: "completed",
      value: {
        names: [job.name],
        next: null,
        enabled: true,
        jobCount: 1,
        name: job.name,
        summaries: ["Three unpaid invoices"],
      },
    });
    expect(gatewayCall).toHaveBeenCalledTimes(4);
  });
});
