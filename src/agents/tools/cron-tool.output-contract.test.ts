import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import ts from "typescript";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { clearCronJobActive, markCronJobActive } from "../../cron/active-jobs.js";
import { CronService } from "../../cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../../cron/service.test-harness.js";
import type { CronJob } from "../../cron/types.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { claimAgentRunContext, clearAgentRunContext } from "../../infra/agent-run-registry.js";
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
  id: job.id,
  name: job.name,
  enabled: true,
  scheduleKind: "every",
  schedule: job.schedule,
  effectiveAgentId: "main",
  nextRunAt: null,
  nextRunAtMs: null,
  lastRunAt: null,
  lastRunAtMs: null,
  lastRunStatus: null,
  lastRunError: null,
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
  it.each([
    {
      name: "scheduler status",
      args: { action: "status" },
      reply: {
        enabled: true,
        triggersEnabled: true,
        storePath: "/synthetic/state.sqlite",
        storage: "sqlite",
        sqlitePath: "/synthetic/state.sqlite",
        jobs: 1,
        nextWakeAtMs: null,
      },
    },
    { name: "compact inventory", args: { action: "list" }, reply: list },
    { name: "job details", args: { action: "get", jobId: job.id }, reply: job },
    {
      name: "creation",
      args: { action: "add", job: createJob },
      reply: { ...job, deliveryPreview },
    },
    {
      name: "declarative convergence",
      args: { action: "add", job: { ...createJob, declarationKey: "invoices" } },
      reply: { created: false, updated: true, job, deliveryPreview },
    },
    {
      name: "update",
      args: { action: "update", jobId: job.id, job: { name: "Check invoices" } },
      reply: job,
    },
    {
      name: "removal",
      args: { action: "remove", jobId: job.id },
      reply: { ok: true, removed: true },
    },
    {
      name: "unsuccessful removal",
      args: { action: "remove", jobId: job.id },
      reply: { ok: false, removed: false },
    },
    {
      name: "queued run",
      args: { action: "run", jobId: job.id },
      reply: { ok: true, enqueued: true, runId: "run-invoices", processInstanceId: "gateway-1" },
    },
    {
      name: "skipped run",
      args: { action: "run", jobId: job.id },
      reply: { ok: true, ran: false, reason: "already-running", processInstanceId: "gateway-1" },
    },
    { name: "rejected run", args: { action: "run", jobId: job.id }, reply: { ok: false } },
    {
      name: "run history",
      args: { action: "runs", jobId: job.id },
      reply: history,
    },
    { name: "wake", args: { action: "wake", text: "Review invoices" }, reply: { ok: true } },
    {
      name: "unsuccessful wake",
      args: { action: "wake", text: "Review invoices" },
      reply: { ok: false, reason: "unwakeable-session-key" },
    },
  ])("describes $name through the real tool", async ({ args, reply }) => {
    const tool = createCronTool(undefined, { callGatewayTool: vi.fn().mockResolvedValue(reply) });
    const result = await tool.execute("call-contract", args);
    const schema = expectDefined(tool.outputSchema, "automations output schema");
    expect(Value.Errors(schema, result.details)).toEqual([]);
  });

  it.each(["isolated", "current"] as const)(
    "accepts successful removal with pending %s session cleanup without retrying",
    async (sessionTarget) => {
      onTestFinished(resetCodeModeTestState);
      const { storePath } = await makeStorePath();
      const cron = new CronService({
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

  it("describes self-scoped status, inventory, and paced proposals", async () => {
    const runId = "automation-output-run";
    claimAgentRunContext(runId, {
      sessionKey: `agent:main:cron:${job.id}`,
      cronRunsByJobId: new Map([[job.id, { pacingEnabled: true }]]),
    });
    onTestFinished(() => clearAgentRunContext(runId));
    const tool = createCronTool(
      { selfRemoveOnlyJobId: job.id, runId },
      {
        callGatewayTool: vi
          .fn()
          .mockResolvedValueOnce({ enabled: true, jobs: 10 })
          .mockResolvedValueOnce(list),
      },
    );
    const schema = expectDefined(tool.outputSchema, "automations output schema");
    const status = await tool.execute("call-status", { action: "status" });
    expect(status.details).toEqual({ enabled: true });
    const inventory = await tool.execute("call-list", { action: "list" });
    expect(inventory.details).not.toHaveProperty("snapshotRevision");
    const proposal = await tool.execute("call-next", { action: "next_check", in: "30m" });
    for (const result of [status, inventory, proposal]) {
      expect(Value.Errors(schema, result.details)).toEqual([]);
    }
  });

  it("composes action results through generated declarations and a typechecked cell", async () => {
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
  const names: string[] = listed.jobs.map(job => job.name);
  const next: number | null = listed.nextOffset;
  const status = await automations({ action: "status" });
  const enabled: boolean = status.enabled;
  const jobCount: number | undefined = status.jobs;
  const details = await automations({ action: "get", jobId: "invoice-check" });
  const name: string = details.name;
  const runs = await automations({ action: "runs", jobId: details.id });
  const summaries: (string | undefined)[] = runs.entries.map(entry => entry.summary);
  return { names, next, enabled, jobCount, name, summaries };
}
`;
    const fileName = "/automations-consumer.ts";
    const source = ts.createSourceFile(
      fileName,
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
`,
      ts.ScriptTarget.ESNext,
      true,
    );
    const options = { noEmit: true, strict: true, types: [], target: ts.ScriptTarget.ESNext };
    const host = ts.createCompilerHost(options);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, ...args) => (name === fileName ? source : original(name, ...args));
    const program = ts.createProgram([fileName], options, host);
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
    ).toEqual([]);
    const composed = await waitUntilCompleted({
      details: resultDetails(
        await expectDefined(h.tools[0], "Code Mode exec").execute("compose-automations", {
          code: `${composition}\nreturn await consume();`,
          language: "typescript",
          typecheck: true,
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
