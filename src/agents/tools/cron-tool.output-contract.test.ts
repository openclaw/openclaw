import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { typeCheckSources } from "../../../test/helpers/typescript.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { clearCronJobActive, markCronJobActive } from "../../cron/active-jobs.js";
import { cronJobReadView } from "../../cron/job-read-view.js";
import { CronService } from "../../cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../../cron/service.test-harness.js";
import type { CronJob } from "../../cron/types.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { projectCronListJobs } from "../../gateway/server-methods/cron-list-projection.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { applyCodeModeCatalog } from "../code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  resultDetails,
  runUntilCompleted,
  waitUntilCompleted,
} from "../code-mode.test-support.js";
import { createToolSearchTools, TOOL_CALL_RAW_TOOL_NAME } from "../tool-search.js";
import { createCronTool } from "./cron-tool.js";
import * as gatewayModule from "./gateway.js";
import { jsonResult } from "./tool-results.js";

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
  state: { scheduleErrorCount: 3, lastError: "schedule error: bad cron expr" },
};
const compactSourceJob: CronJob = {
  ...job,
  agentId: "main",
  enabled: false,
  state: {
    runningAtMs: 0,
    autoDisabled: { reason: "consecutive-failures", atMs: 0, consecutiveErrors: 3 },
  },
};
const page = {
  total: 1,
  offset: 0,
  limit: 50,
  hasMore: false,
  nextOffset: null,
};
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

function createCronService(storePath: string) {
  return new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: true,
    defaultAgentId: "main",
    sessionStorePath: path.join(path.dirname(storePath), "sessions.json"),
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

describe("automations output contract", () => {
  const { makeStorePath } = createCronStoreHarness({ prefix: "cron-code-mode-output-" });

  beforeEach(() => {
    setRuntimeConfigSnapshot({});
    onTestFinished(clearRuntimeConfigSnapshot);
  });

  it.each(["current"] as const)(
    "accepts successful removal with pending %s session cleanup without retrying",
    async (sessionTarget) => {
      onTestFinished(resetCodeModeTestState);
      const { storePath } = await makeStorePath();
      const cron = createCronService(storePath);
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
      const gatewaySpy = vi.spyOn(gatewayModule, "callGatewayTool").mockImplementation(gatewayCall);
      onTestFinished(() => gatewaySpy.mockRestore());
      const tool = createCronTool();
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
          value: {
            ok: true,
            removed: true,
            activeRunCancellationRequested: true,
            sessionCleanup: "pending",
          },
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
    const gatewaySpy = vi.spyOn(gatewayModule, "callGatewayTool").mockImplementation(gatewayCall);
    onTestFinished(() => gatewaySpy.mockRestore());
    const tool = createCronTool();
    const result = await tool.execute("call-full", { action: "list" });
    expect(gatewayCall).toHaveBeenCalledTimes(2);
    expect(result.details).toMatchObject({
      includeDisabled: false,
      inventoryHint: expect.stringContaining("Disabled automations are omitted"),
    });
    expect(
      Value.Errors(expectDefined(tool.outputSchema, "automations output schema"), result.details),
    ).toEqual([]);
  });

  it("accepts the reauthorization flags that Gateway projections emit", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    onTestFinished(() => cron.stop());
    const ownerSessionKey = "agent:main:telegram:direct:creator";
    const blocked: CronJob = {
      ...job,
      id: "dm-capped-watcher",
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "Check the queue", toolsAllow: ["read"] },
      owner: { sessionKey: ownerSessionKey, accountId: "work" },
      scheduledToolPolicy: { version: 1, mode: "account", ownerSessionKey, ownerAccountId: "work" },
    };
    const source = {
      ...page,
      jobs: [freezeJsonSnapshot(structuredClone(blocked))],
      snapshotRevision: "blocked-inventory",
    };
    const compactList = { ...source, jobs: projectCronListJobs(cron, source, true) };
    const details = cronJobReadView(blocked);
    expect(compactList.jobs[0]).toMatchObject({ reauthorizationRequired: true });
    expect(details).toMatchObject({ reauthorizationRequired: true });
    const gatewayCall = vi
      .fn()
      .mockResolvedValueOnce(await cron.status())
      .mockResolvedValueOnce(details)
      .mockResolvedValueOnce(compactList)
      .mockResolvedValueOnce({ ...source, jobs: projectCronListJobs(cron, source, false) });
    const gatewaySpy = vi.spyOn(gatewayModule, "callGatewayTool").mockImplementation(gatewayCall);
    onTestFinished(() => gatewaySpy.mockRestore());
    const tool = createCronTool();
    const outputSchema = expectDefined(tool.outputSchema, "automations output schema");
    for (const args of [
      { action: "status" },
      { action: "get", jobId: blocked.id },
      { action: "list" },
      { action: "list" },
    ]) {
      const result = await tool.execute(`reauthorization-${args.action}`, args);
      expect(Value.Errors(outputSchema, result.details), args.action).toEqual([]);
    }
    expect(gatewayCall).toHaveBeenCalledTimes(4);
  });

  it("still runs on a shipped Gateway that rejects the run wait", async () => {
    const gatewayCall = vi
      .fn()
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "invalid cron.run params: unexpected property 'waitTimeoutMs'",
        }),
      )
      .mockResolvedValueOnce({ ok: true, enqueued: true, runId: "manual:job:1" });
    const gatewaySpy = vi.spyOn(gatewayModule, "callGatewayTool").mockImplementation(gatewayCall);
    onTestFinished(() => gatewaySpy.mockRestore());
    const tool = createCronTool();
    const result = await tool.execute("call-run", {
      action: "run",
      jobId: "job",
      runMode: "force",
    });
    expect(gatewayCall.mock.calls.map((call) => call[2])).toEqual([
      { id: "job", mode: "force", waitTimeoutMs: 60_000 },
      { id: "job", mode: "force" },
    ]);
    expect(result.details).toMatchObject({ runId: "manual:job:1", note: expect.any(String) });
    expect(
      Value.Errors(expectDefined(tool.outputSchema, "automations output schema"), result.details),
    ).toEqual([]);
  });

  it("preserves terminal approval outcomes through direct tools, Tool Search, and Code Mode", async () => {
    onTestFinished(resetCodeModeTestState);
    let refusal: Record<string, unknown>;
    const gatewayCall = vi.fn().mockImplementation(async () => {
      throw new GatewayClientRequestError({
        code: "FORBIDDEN",
        message: "Approval ended",
        details: refusal,
        retryable: false,
      });
    });
    const gatewaySpy = vi.spyOn(gatewayModule, "callGatewayTool").mockImplementation(gatewayCall);
    onTestFinished(() => gatewaySpy.mockRestore());
    const tool = createCronTool();
    const h = createCodeModeHarness();
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });
    const toolCall = expectDefined(
      createToolSearchTools(h.ctx).find((entry) => entry.name === TOOL_CALL_RAW_TOOL_NAME),
      "Tool Search call",
    );
    for (const outcome of ["operator-denied", "expired", "cancelled"] as const) {
      for (const action of ["add", "update"] as const) {
        refusal = {
          code: "CRON_STREAM_APPROVAL_ENDED",
          saved: false,
          action,
          approvalId: "cron-stream:output-contract",
          outcome,
          message: "The proposal was not saved. Wait for a new user instruction.",
        };
        const args =
          action === "add"
            ? { action, job: createJob }
            : { action, jobId: job.id, job: { name: "Changed name" } };
        const direct = await tool.execute("direct-refusal", args);
        expect(direct.details).toEqual(refusal);
        expect(
          Value.Errors(expectDefined(tool.outputSchema, "output schema"), direct.details),
        ).toEqual([]);
        const searched = await toolCall.execute("searched-refusal", { id: "automations", args });
        expect(searched.details).toMatchObject({ result: { details: refusal } });
        const codeMode = await runUntilCompleted({
          execTool: expectDefined(h.tools[0], "Code Mode exec"),
          waitTool: expectDefined(h.tools[1], "Code Mode wait"),
          code: `return await automations(${JSON.stringify(args)});`,
        });
        expect(codeMode).toMatchObject({ status: "completed", value: refusal });
      }
    }
    // Similar error text cannot turn a validation failure into a native decision.
    gatewayCall.mockRejectedValueOnce(
      new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "An operator declined this watcher proposal.",
      }),
    );
    await expect(tool.execute("invalid", { action: "add", job: createJob })).rejects.toThrow();
  });

  it("composes action results through generated declarations and JavaScript", async () => {
    onTestFinished(resetCodeModeTestState);
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    onTestFinished(() => cron.stop());
    const source = {
      ...page,
      jobs: [freezeJsonSnapshot(structuredClone(compactSourceJob))],
      snapshotRevision: "inventory-revision",
    };
    const list = { ...source, jobs: projectCronListJobs(cron, source, true) };
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
    const gatewaySpy = vi.spyOn(gatewayModule, "callGatewayTool").mockImplementation(gatewayCall);
    onTestFinished(() => gatewaySpy.mockRestore());
    const tool = createCronTool();
    const streamJob = {
      ...job,
      schedule: { kind: "stream", command: ["node", "events.mjs"] },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "Summarize the output" },
    };
    const streamInput = {
      name: streamJob.name,
      schedule: streamJob.schedule,
      sessionTarget: streamJob.sessionTarget,
      payload: streamJob.payload,
    };
    const receipt = {
      approvalId: "cron-stream:output-contract",
      decision: "allow-once",
      source: "operator",
      message:
        "A human operator approved this watcher and its automatic restarts. The approver's identity is not supplied.",
    } as const;
    const approvedResults = {
      direct: { ...streamJob, streamExecutionApproval: receipt },
      declarative: { created: true, job: streamJob, streamExecutionApproval: receipt },
      update: { ...streamJob, streamExecutionApproval: receipt },
    };
    const execute = tool.execute;
    // Approval integration owns receipt production. These accepted result samples
    // exercise the strict model-facing schema and both result projections.
    tool.execute = async (...args) => {
      const input = args[1];
      if (isRecord(input) && input.action === "add") {
        return jsonResult(
          isRecord(input.job) && input.job.declarationKey
            ? approvedResults.declarative
            : approvedResults.direct,
        );
      }
      if (isRecord(input) && input.action === "update") {
        return jsonResult(approvedResults.update);
      }
      return await execute(...args);
    };
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });
    const toolCall = expectDefined(
      createToolSearchTools(h.ctx).find((entry) => entry.name === TOOL_CALL_RAW_TOOL_NAME),
      "Tool Search call",
    );
    for (const [variant, args] of [
      ["direct", { action: "add", job: streamInput }],
      ["declarative", { action: "add", job: { ...streamInput, declarationKey: "watcher" } }],
      ["update", { action: "update", jobId: job.id, job: { enabled: true } }],
    ] as const) {
      const result = await toolCall.execute(`approval-${variant}`, { id: "automations", args });
      expect(result.details).toMatchObject({ result: { details: approvedResults[variant] } });
      const content = expectDefined(result.content[0], "model-visible dispatch result");
      if (content.type !== "text") {
        throw new Error("Expected model-visible dispatch text");
      }
      const envelope = JSON.parse(content.text);
      expect(envelope).toMatchObject({
        tool: { name: "automations" },
        result: { content: [{ type: "text", text: expect.any(String) }] },
      });
      expect(JSON.parse(envelope.result.content[0].text)).toMatchObject({
        streamExecutionApproval: receipt,
      });
    }
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
  const includeDisabled = listed.includeDisabled;
  const inventoryHint = listed.inventoryHint;
  const names = listed.jobs.map(job => job.name);
  const next = listed.nextOffset;
  const status = await automations({ action: "status" });
  const enabled = status.enabled;
  const jobCount = status.jobs;
  const details = await automations({ action: "get", jobId: "invoice-check" });
  const name = details.name;
  const scheduleErrorCount = details.state.scheduleErrorCount;
  const runs = await automations({ action: "runs", jobId: details.id });
  const summaries = runs.entries.map(entry => entry.summary);
  const direct = await automations({ action: "add", job: ${JSON.stringify(streamInput)} });
  const declarative = await automations({ action: "add", job: ${JSON.stringify({ ...streamInput, declarationKey: "watcher" })} });
  const updated = await automations({ action: "update", jobId: "invoice-check", job: { enabled: true } });
  return {
    names, next, enabled, jobCount, name, scheduleErrorCount, summaries, includeDisabled, inventoryHint,
    approvals: [direct, declarative, updated].map(result => "saved" in result ? undefined : result.streamExecutionApproval),
  };
}
`;
    const fileName = "/automations-consumer.ts";
    const declarationSource =
      file.content +
      composition +
      `
async function checkContracts(action: "list" | "runs", input: Parameters<typeof automations>[0]) {
  const listed = await automations({ action: "list" });
  const includeDisabled: boolean = listed.includeDisabled;
  const inventoryHint: string = listed.inventoryHint;
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
  if ("saved" in added) {
    const saved: false = added.saved;
    const outcome: "operator-denied" | "expired" | "cancelled" = added.outcome;
    return;
  }
  const addedJob = "job" in added ? added.job : added;
  const id: string = addedJob.id;
  const approval = added.streamExecutionApproval;
  if (approval) {
    const approvalId: string = approval.approvalId;
    const decision: "allow-once" = approval.decision;
    const source: "operator" = approval.source;
    const attribution: string = approval.message;
    // @ts-expect-error A successful stream receipt never represents a denial.
    const denied: "deny" = approval.decision;
  }
  const updated = await automations({ action: "update", jobId: id, job: { enabled: true } });
  const updateApproval: typeof approval = "saved" in updated ? undefined : updated.streamExecutionApproval;
  const warning: string | undefined = "saved" in updated ? undefined : updated.deliveryPreview?.detail;
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
    expect(typeCheckSources({ [fileName]: declarationSource })).toEqual([]);
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
        includeDisabled: false,
        inventoryHint: expect.stringContaining("get jobId"),
        next: null,
        enabled: true,
        jobCount: 1,
        name: job.name,
        scheduleErrorCount: 3,
        summaries: ["Three unpaid invoices"],
        approvals: [receipt, receipt, receipt],
      },
    });
    expect(gatewayCall).toHaveBeenCalledTimes(4);
  });
});
