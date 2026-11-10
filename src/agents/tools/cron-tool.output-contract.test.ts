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
  runUntilCompleted,
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
const page = { total: 1, offset: 0, limit: 50, hasMore: false, nextOffset: null };
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

function mockGateway(call: typeof gatewayModule.callGatewayTool) {
  const spy = vi.spyOn(gatewayModule, "callGatewayTool").mockImplementation(call);
  onTestFinished(() => spy.mockRestore());
}

function codeMode(tool: ReturnType<typeof createCronTool>) {
  onTestFinished(resetCodeModeTestState);
  const h = createCodeModeHarness();
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });
  return {
    toolCall: expectDefined(
      createToolSearchTools(h.ctx).find((entry) => entry.name === TOOL_CALL_RAW_TOOL_NAME),
      "Tool Search call",
    ),
    run: (code: string) =>
      runUntilCompleted({
        execTool: expectDefined(h.tools[0], "Code Mode exec"),
        waitTool: expectDefined(h.tools[1], "Code Mode wait"),
        code,
      }),
  };
}

function expectOutput(tool: ReturnType<typeof createCronTool>, details: unknown) {
  expect(
    Value.Errors(expectDefined(tool.outputSchema, "automations output schema"), details),
  ).toEqual([]);
}

describe("automations output contract", () => {
  const { makeStorePath } = createCronStoreHarness({ prefix: "cron-code-mode-output-" });

  beforeEach(() => {
    setRuntimeConfigSnapshot({});
    onTestFinished(clearRuntimeConfigSnapshot);
  });

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
    mockGateway(gatewayCall);
    const tool = createCronTool();
    const result = await tool.execute("call-full", { action: "list" });
    expect(gatewayCall).toHaveBeenCalledTimes(2);
    expect(result.details).toMatchObject({
      includeDisabled: false,
      inventoryHint: expect.stringContaining("Disabled automations are omitted"),
    });
    expectOutput(tool, result.details);
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
    mockGateway(gatewayCall);
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
    expectOutput(tool, result.details);
  });

  it("preserves terminal approval outcomes through direct tools, Tool Search, and Code Mode", async () => {
    let refusal: Record<string, unknown>;
    const gatewayCall = vi.fn().mockImplementation(async () => {
      throw new GatewayClientRequestError({
        code: "FORBIDDEN",
        message: "Approval ended",
        details: refusal,
        retryable: false,
      });
    });
    mockGateway(gatewayCall);
    const tool = createCronTool();
    const { toolCall, run } = codeMode(tool);
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
        expectOutput(tool, direct.details);
        const searched = await toolCall.execute("searched-refusal", { id: "automations", args });
        expect(searched.details).toMatchObject({ result: { details: refusal } });
        expect(await run(`return await automations(${JSON.stringify(args)});`)).toMatchObject({
          status: "completed",
          value: refusal,
        });
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
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    onTestFinished(() => cron.stop());
    const source = {
      ...page,
      jobs: [freezeJsonSnapshot(structuredClone(compactSourceJob))],
      snapshotRevision: "inventory-revision",
    };
    const list = { ...source, jobs: projectCronListJobs(cron, source, true) };
    const replies: Record<string, unknown> = {
      "cron.list": list,
      "cron.status": { enabled: true, jobs: 1 },
      "cron.get": job,
      "cron.runs": history,
      "cron.remove": {
        ok: true,
        removed: true,
        activeRunCancellationRequested: true,
        sessionCleanup: "pending",
      },
    };
    const gatewayCall = vi.fn().mockImplementation(async (method: string) => {
      if (!(method in replies)) {
        throw new Error(`Unexpected gateway method: ${method}`);
      }
      return replies[method];
    });
    mockGateway(gatewayCall);
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
    const { run } = codeMode(tool);
    const result = await run('return await API.read("tools/automations.d.ts");');
    expect(result).toMatchObject({ status: "completed" });
    const file = result.value as { content: string };
    const composition = `
async function consume() {
  const listed = await automations({ action: "list" });
  const status = await automations({ action: "status" });
  const details = await automations({ action: "get", jobId: "invoice-check" });
  const runs = await automations({ action: "runs", jobId: details.id });
  const direct = await automations({ action: "add", job: ${JSON.stringify(streamInput)} });
  const declarative = await automations({ action: "add", job: ${JSON.stringify({ ...streamInput, declarationKey: "watcher" })} });
  const updated = await automations({ action: "update", jobId: "invoice-check", job: { enabled: true } });
  const removed = await automations({ action: "remove", jobId: "invoice-check" });
  return {
    removed,
    names: listed.jobs.map(job => job.name), next: listed.nextOffset,
    includeDisabled: listed.includeDisabled, inventoryHint: listed.inventoryHint,
    enabled: status.enabled, jobCount: status.jobs, name: details.name,
    scheduleErrorCount: details.state.scheduleErrorCount, summaries: runs.entries.map(entry => entry.summary),
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
  const { includeDisabled, inventoryHint }: { includeDisabled: boolean; inventoryHint: string } = listed;
  // @ts-expect-error Invented invoice fields are not part of an automation.
  listed.jobs[0].invoiceTotal;
  const removed = await automations({ action: "remove", jobId: "invoice-check" });
  if (removed.ok) {
    const { activeRunCancellationRequested, sessionCleanup }: {
      activeRunCancellationRequested?: true; sessionCleanup?: "pending";
    } = removed;
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
    const receipt: { approvalId: string; decision: "allow-once"; source: "operator"; message: string } = approval;
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
    const composed = await run(`${composition}\nreturn await consume();`);
    expect(composed, JSON.stringify(composed)).toMatchObject({
      status: "completed",
      value: {
        removed: replies["cron.remove"],
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
    expect(gatewayCall).toHaveBeenCalledTimes(5);
  });
});
