import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { compareCodeModeMatrixResults } from "../../scripts/lib/code-mode-matrix-comparison.js";
import * as gatewayFixtures from "../../scripts/lib/code-mode-matrix-gateway-fixtures.js";
import {
  collectGatewayMatrixTrace,
  createGatewayMatrixWorkload,
  evaluateGatewayMatrixInterview,
  evaluateGatewayMatrixTask,
  requireGatewayMatrixTools,
} from "../../scripts/lib/code-mode-matrix-gateway.js";
import type { NestedToolActivity } from "../../src/sessions/nested-tool-activity.js";

function assistantCall(id: string, code: string, checked = false) {
  return {
    type: "message",
    message: {
      role: "assistant",
      provider: "openai",
      model: "gpt-5.6-sol",
      content: [
        {
          type: "toolCall",
          id,
          name: "exec",
          arguments: { code, ...(checked ? { language: "typescript", typecheck: true } : {}) },
        },
      ],
    },
  };
}

function toolOutcome(id: string, details: Record<string, unknown>, isError = false, name = "exec") {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      isError,
      details,
      content: [{ type: "text", text: JSON.stringify(details) }],
    },
  };
}

function waitEvents(id: string, runId: string, details: Record<string, unknown>, isError = false) {
  return [
    {
      type: "message",
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.6-sol",
        content: [{ type: "toolCall", id, name: "wait", arguments: { runId } }],
      },
    },
    toolOutcome(id, details, isError, "wait"),
  ];
}

function nestedActivity(
  parentId: string,
  name: string,
  input: Record<string, unknown> = {},
  result: Record<string, unknown> = {},
  isError = false,
): NestedToolActivity {
  return {
    role: "custom",
    customType: "openclaw.nested-tool.v1",
    display: true,
    excludeFromContext: true,
    content: "",
    timestamp: 100,
    details: {
      runId: "run-1",
      scopeId: "scope-1",
      afterEntryId: null,
      startOrder: 0,
      parentToolCallId: parentId,
      toolCallId: `${parentId}-${name}`,
      toolName: name,
      input,
      result: { content: [], details: result },
      isError,
      startedAt: 100,
      timestamp: 101,
    },
  };
}

function receipt(kind: "call" | "effect", tool: string, facts: Record<string, unknown> = {}) {
  return { kind, tool, ...facts };
}

const SETTLEMENT = {
  nonce: "settlement-r1-v1",
  operationId: "matrix-settlement-1",
  effectCount: 1,
  totalCents: 6031,
};

function settlementEvidence() {
  const input = { operationId: SETTLEMENT.operationId };
  return {
    events: [
      assistantCall("settle", 'return await matrix_settle({operationId:"matrix-settlement-1"});'),
      nestedActivity("settle", "matrix_settle", input, {}, true),
      toolOutcome(
        "settle",
        {
          status: "failed",
          error: "Output contract: receipt must be a string; totalCents is required",
        },
        true,
      ),
      assistantCall(
        "inspect",
        'return await matrix_settlement_inspect({operationId:"matrix-settlement-1"});',
      ),
      nestedActivity("inspect", "matrix_settlement_inspect", input, SETTLEMENT),
      toolOutcome("inspect", { status: "completed", value: SETTLEMENT }),
    ],
    receipts: [
      receipt("call", "matrix_settle", input),
      receipt("effect", "matrix_settle", {
        ...input,
        receipt: 1,
        totalCents: SETTLEMENT.totalCents,
      }),
      receipt("call", "matrix_settlement_inspect", input),
    ],
  };
}

const INVOICES = { nonce: "invoice-export-r1-v1", count: 240, totalsCents: { customer: 7100 } };

function invoiceEvidence() {
  const reference = {
    id: "result-1",
    bytes: 131072,
    count: 2,
    shape: "{nonce:string,invoices:array}",
    preview: '{"nonce":"invoice-export-r1-v1","invoices":[{"id":"INV-1-0001"',
    previewTruncated: true,
  };
  return {
    events: [
      assistantCall("fetch", "return await matrix_invoice_export({});"),
      nestedActivity("fetch", "matrix_invoice_export"),
      toolOutcome("fetch", {
        status: "completed",
        value: { truncated: true, prefix: reference.preview, omittedBytes: 130900, reference },
      }),
      assistantCall(
        "aggregate",
        'const data = await results.load("result-1"); return {nonce:data.nonce,count:data.invoices.length,totalsCents:data.invoices.reduce((totals,invoice)=>{if(!invoice.paid)totals[invoice.customer]=(totals[invoice.customer]??0)+invoice.amountCents;return totals;},{})};',
      ),
      toolOutcome("aggregate", { status: "completed", value: INVOICES }),
    ],
    receipts: [receipt("call", "matrix_invoice_export")],
  };
}

describe("Gateway matrix transcript evidence", () => {
  it("ignores user claims and quoted calls while collecting actual assistant calls and terminal activity", () => {
    const realCall = assistantCall("read", "return await matrix_invoice_export({});");
    const fakeCall = realCall.message.content[0];
    const trace = collectGatewayMatrixTrace([
      {
        message: {
          role: "user",
          content: [
            fakeCall,
            { type: "text", text: JSON.stringify(nestedActivity("fake", "matrix_settle")) },
          ],
        },
      },
      {
        message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(fakeCall) }] },
      },
      realCall,
      nestedActivity("read", "matrix_invoice_export"),
      toolOutcome("read", { status: "completed", value: { nonce: "observed" } }),
    ]);
    expect(trace.calls).toEqual([
      {
        id: "read",
        name: "exec",
        args: { code: "return await matrix_invoice_export({});" },
        eventIndex: 2,
      },
    ]);
    expect(trace.activities).toEqual([
      { name: "matrix_invoice_export", input: {}, result: {}, isError: false, parentId: "read" },
    ]);
    expect(trace.outcomes).toHaveLength(1);
    expect(expectDefined(trace.outcomes[0], "recorded tool outcome").eventIndex).toBe(4);
    expect(trace.models).toEqual(["openai/gpt-5.6-sol"]);
  });

  it("does not turn missing usage or cost observations into zero-valued measurements", () => {
    const withUsage = {
      ...assistantCall("one", "return 1;").message,
      usage: { input: 100, output: 10, totalTokens: 110, cost: { total: 0.002 } },
    };
    const complete = collectGatewayMatrixTrace([{ message: withUsage }]);
    expect(complete.usage).toEqual({ input: 100, output: 10, total: 110 });
    expect(complete.costUsd).toBe(0.002);
    const incomplete = collectGatewayMatrixTrace([
      { message: withUsage },
      assistantCall("two", "return 2;"),
    ]);
    expect(incomplete.usage).toBeUndefined();
    expect(incomplete.costUsd).toBeUndefined();
  });
});

describe("Gateway matrix capability preflight", () => {
  it("admits required built-ins and tools registered by the fixture plugin", () => {
    const required = ["exec", "matrix_invoice_export"];
    const catalog = {
      groups: [
        {
          tools: [
            { id: "exec", source: "core" },
            { id: "matrix_invoice_export", source: "plugin", pluginId: "code-mode-matrix-fixture" },
          ],
        },
      ],
    };
    expect(requireGatewayMatrixTools(catalog, required)).toEqual(required);
  });

  it.each(["missing", "wrong-plugin"] as const)(
    "rejects a %s fixture capability before the model runs",
    (failure) => {
      const catalog = {
        groups: [
          {
            tools:
              failure === "missing"
                ? []
                : [{ id: "matrix_invoice_export", source: "plugin", pluginId: "unrelated-plugin" }],
          },
        ],
      };
      expect(() => requireGatewayMatrixTools(catalog, ["matrix_invoice_export"])).toThrow(
        "preflight failed before model call: matrix_invoice_export",
      );
    },
  );
});

describe("Gateway matrix task oracles", () => {
  it("accepts one persisted settlement followed by inspection despite a malformed post-dispatch reply", () => {
    const { events, receipts } = settlementEvidence();
    const checks = evaluateGatewayMatrixTask({
      task: "partial-failure",
      expected: SETTLEMENT,
      final: JSON.stringify(SETTLEMENT),
      trace: collectGatewayMatrixTrace(events),
      receipts,
    });
    expect(Object.values(checks).every(Boolean)).toBe(true);
  });

  it.each([
    { scenario: "completed-wait", accepted: true },
    { scenario: "multiple-waits", accepted: true },
    { scenario: "unrelated-run", accepted: false },
  ] as const)(
    "requires correlated settlement diagnostics through $scenario",
    ({ scenario, accepted }) => {
      const evidence = settlementEvidence();
      const events: unknown[] = [...evidence.events];
      const receipts = evidence.receipts;
      events[0] = assistantCall(
        "settle",
        'try { return await matrix_settle({operationId:"matrix-settlement-1"}); } catch (error) { return {error:String(error)}; }',
      );
      events[2] = toolOutcome("settle", { status: "waiting", runId: "settlement-run" });
      const waits: unknown[] = [];
      function wait(id: string, runId: string, details: Record<string, unknown>) {
        waits.push(...waitEvents(id, runId, details));
      }
      if (scenario === "multiple-waits") {
        wait("pending-settlement", "settlement-run", {
          status: "waiting",
          runId: "settlement-run",
        });
      }
      wait(
        "settlement-diagnostic",
        scenario === "unrelated-run" ? "another-run" : "settlement-run",
        {
          status: "completed",
          value: { error: "Output contract: receipt must be a string; totalCents is required" },
        },
      );
      events.splice(3, 0, ...waits);
      const checks = evaluateGatewayMatrixTask({
        task: "partial-failure",
        expected: SETTLEMENT,
        final: JSON.stringify(SETTLEMENT),
        trace: collectGatewayMatrixTrace(events),
        receipts,
      });
      expect(checks.answer).toBe(true);
      expect(checks.exactlyOneEffect).toBe(true);
      expect(checks.inspectedAfterFailure).toBe(true);
      expect(checks.observedPersistedState).toBe(true);
      expect(checks.actionableDiagnostics).toBe(accepted);
      expect(Object.values(checks).every(Boolean)).toBe(accepted);
    },
  );

  it.each(["initial-inspection", "caught-diagnostic"] as const)(
    "accepts safe settlement recovery with %s",
    (variant) => {
      const { events, receipts } = settlementEvidence();
      if (variant === "initial-inspection") {
        events.unshift(
          assistantCall(
            "initial",
            'return await matrix_settlement_inspect({operationId:"matrix-settlement-1"});',
          ),
          nestedActivity(
            "initial",
            "matrix_settlement_inspect",
            { operationId: SETTLEMENT.operationId },
            { ...SETTLEMENT, effectCount: 0, totalCents: 0 },
          ),
          toolOutcome("initial", {
            status: "completed",
            value: { ...SETTLEMENT, effectCount: 0, totalCents: 0 },
          }),
        );
        receipts.unshift(
          receipt("call", "matrix_settlement_inspect", { operationId: SETTLEMENT.operationId }),
        );
      } else {
        events[0] = assistantCall(
          "settle",
          'try { return await matrix_settle({operationId:"matrix-settlement-1"}); } catch (error) { return {error:String(error)}; }',
        );
        events[2] = toolOutcome("settle", {
          status: "completed",
          value: { error: "Output contract: receipt must be a string; totalCents is required" },
        });
      }
      const checks = evaluateGatewayMatrixTask({
        task: "partial-failure",
        expected: SETTLEMENT,
        final: JSON.stringify(SETTLEMENT),
        trace: collectGatewayMatrixTrace(events),
        receipts,
      });
      expect(Object.values(checks).every(Boolean)).toBe(true);
    },
  );

  it("rejects a blindly repeated settlement even if the final answer claims only one effect", () => {
    const { events, receipts } = settlementEvidence();
    receipts.splice(
      2,
      0,
      receipt("call", "matrix_settle", { operationId: SETTLEMENT.operationId }),
      receipt("effect", "matrix_settle", {
        operationId: SETTLEMENT.operationId,
        receipt: 2,
        totalCents: SETTLEMENT.totalCents,
      }),
    );
    const checks = evaluateGatewayMatrixTask({
      task: "partial-failure",
      expected: SETTLEMENT,
      final: JSON.stringify(SETTLEMENT),
      trace: collectGatewayMatrixTrace(events),
      receipts,
    });
    expect(checks.answer).toBe(true);
    expect(checks.exactlyOneEffect).toBe(false);
  });

  it("rejects the wrong persisted settlement amount despite a correct final claim", () => {
    const { events, receipts } = settlementEvidence();
    receipts[1] = receipt("effect", "matrix_settle", {
      operationId: SETTLEMENT.operationId,
      receipt: 1,
      totalCents: 1,
    });
    const checks = evaluateGatewayMatrixTask({
      task: "partial-failure",
      expected: SETTLEMENT,
      final: JSON.stringify(SETTLEMENT),
      trace: collectGatewayMatrixTrace(events),
      receipts,
    });
    expect(checks.answer).toBe(true);
    expect(Object.values(checks).every(Boolean)).toBe(false);
  });

  it("accepts an automatic retained descriptor and a later load with one upstream fetch", () => {
    const { events, receipts } = invoiceEvidence();
    const checks = evaluateGatewayMatrixTask({
      task: "invoices-auto-retention",
      expected: INVOICES,
      final: JSON.stringify(INVOICES),
      trace: collectGatewayMatrixTrace(events),
      receipts,
    });
    expect(Object.values(checks).every(Boolean)).toBe(true);
  });

  it.each(["refetch", "context-dump", "load-before-fetch"] as const)(
    "rejects %s while preserving the correct-answer observation",
    (violation) => {
      const { events, receipts } = invoiceEvidence();
      const trace = collectGatewayMatrixTrace(events);
      if (violation === "refetch") {
        receipts.push(receipt("call", "matrix_invoice_export"));
      } else if (violation === "context-dump") {
        expectDefined(trace.outcomes[1], "aggregate outcome").content = [
          {
            type: "text",
            text: JSON.stringify(
              Array.from({ length: 240 }, (_, index) => ({ id: `INV-1-${index + 1}` })),
            ),
          },
        ];
      } else {
        trace.calls.reverse();
      }
      const checks = evaluateGatewayMatrixTask({
        task: "invoices-auto-retention",
        expected: INVOICES,
        final: JSON.stringify(INVOICES),
        trace,
        receipts,
      });
      expect(checks.answer).toBe(true);
      expect(Object.values(checks).every(Boolean)).toBe(false);
    },
  );
});

const AUTOMATION = {
  jobName: "matrix-contracts-r1",
  updatedName: "matrix-contracts-r1-updated",
  payloadText: "Synthetic disabled automation 1",
  remainingOwnedJobs: 0,
};

function automationEvidence(
  terminal: "complete" | "stale" | "enabled-only" | "partial" | "changed-baseline",
) {
  const baselineJob = {
    id: "system-heartbeat",
    name: "System heartbeat",
    enabled: false,
    sessionTarget: "main",
    schedule: { kind: "every", everyMs: 1800000 },
    payload: { kind: "systemEvent", text: "Heartbeat" },
  };
  const job = {
    name: AUTOMATION.jobName,
    enabled: false,
    sessionTarget: "main",
    schedule: { kind: "at", at: "2035-01-01T00:00:00.000Z" },
    payload: { kind: "systemEvent", text: AUTOMATION.payloadText },
  };
  const firstJob = { ...job, id: "owned-1", createdAtMs: Date.parse("2034-12-31T00:00:00.000Z") };
  const updatedJob = { ...firstJob, name: AUTOMATION.updatedName };
  const inventory = { jobs: [baselineJob], total: 1, hasMore: false, nextOffset: null };
  const events: unknown[] = [];
  function action(input: Record<string, unknown>, result: Record<string, unknown>) {
    const id = `automation-${events.length}`;
    events.push(
      assistantCall(id, `return await automations(${JSON.stringify(input)});`, true),
      nestedActivity(id, "automations", input, result),
      toolOutcome(id, { status: "completed", value: result }),
    );
  }
  action({ action: "status" }, { enabled: false, jobs: 1 });
  action({ action: "list", includeDisabled: true }, inventory);
  action({ action: "list", includeDisabled: true }, inventory);
  action({ action: "add", job }, firstJob);
  action({ action: "get", jobId: firstJob.id }, firstJob);
  action(
    { action: "update", jobId: firstJob.id, patch: { name: AUTOMATION.updatedName } },
    updatedJob,
  );
  action({ action: "get", jobId: firstJob.id }, updatedJob);
  action({ action: "runs", jobId: firstJob.id }, { entries: [] });
  action({ action: "remove", jobId: firstJob.id }, { ok: true, removed: true });
  if (terminal !== "stale") {
    action(
      { action: "list", includeDisabled: terminal !== "enabled-only" },
      {
        ...inventory,
        hasMore: terminal === "partial",
        ...(terminal === "changed-baseline" ? { jobs: [{ ...baselineJob, enabled: true }] } : {}),
      },
    );
  }
  return collectGatewayMatrixTrace(events);
}

describe("terminal automation evidence", () => {
  it("accepts complete inventories surrounding all mutations and preserving the full baseline jobs", () => {
    const checks = evaluateGatewayMatrixTask({
      task: "automation-contracts",
      expected: AUTOMATION,
      final: JSON.stringify(AUTOMATION),
      trace: automationEvidence("complete"),
      receipts: [],
    });
    expect(Object.values(checks).every(Boolean)).toBe(true);
  });

  it("accepts ID-only history completing after creation and before the independent rename", () => {
    const trace = automationEvidence("complete");
    const created = expectDefined(
      trace.activities.find((item) => item.input.action === "add"),
      "created job",
    );
    const history = expectDefined(
      trace.activities.find((item) => item.input.action === "runs"),
      "job history read",
    );
    trace.activities.splice(trace.activities.indexOf(history), 1);
    trace.activities.splice(trace.activities.indexOf(created) + 1, 0, history);
    const checks = evaluateGatewayMatrixTask({
      task: "automation-contracts",
      expected: AUTOMATION,
      final: JSON.stringify(AUTOMATION),
      trace,
      receipts: [],
    });
    expect(Object.values(checks).every(Boolean)).toBe(true);
  });

  it("accepts independent updated-job and history reads completing in either order before removal", () => {
    const trace = automationEvidence("complete");
    const updatedRead = expectDefined(
      trace.activities.find(
        (item) => item.input.action === "get" && item.result.name === AUTOMATION.updatedName,
      ),
      "updated job read",
    );
    const history = expectDefined(
      trace.activities.find((item) => item.input.action === "runs"),
      "job history read",
    );
    const readIndex = trace.activities.indexOf(updatedRead);
    const historyIndex = trace.activities.indexOf(history);
    trace.activities[readIndex] = history;
    trace.activities[historyIndex] = updatedRead;
    const checks = evaluateGatewayMatrixTask({
      task: "automation-contracts",
      expected: AUTOMATION,
      final: JSON.stringify(AUTOMATION),
      trace,
      receipts: [],
    });
    expect(Object.values(checks).every(Boolean)).toBe(true);
  });

  it.each([
    "late-status",
    "missing-initial-read",
    "foreign-initial-read",
    "foreign-updated-read",
    "foreign-history",
    "initial-result-id",
    "updated-result-id",
    "update-before-initial-read",
    "updated-read-before-update",
    "history-after-remove",
  ] as const)("rejects %s despite a correct final answer and inventory", (violation) => {
    const trace = automationEvidence("complete");
    const initialRead = expectDefined(
      trace.activities.find(
        (item) => item.input.action === "get" && item.result.name === AUTOMATION.jobName,
      ),
      "pre-update job read",
    );
    const updatedRead = expectDefined(
      trace.activities.find(
        (item) => item.input.action === "get" && item.result.name === AUTOMATION.updatedName,
      ),
      "post-update job read",
    );
    const history = expectDefined(
      trace.activities.find((item) => item.input.action === "runs"),
      "job history read",
    );
    const update = expectDefined(
      trace.activities.find((item) => item.input.action === "update"),
      "job update",
    );
    const removal = expectDefined(
      trace.activities.find((item) => item.input.action === "remove"),
      "job removal",
    );
    if (violation === "late-status") {
      const status = expectDefined(
        trace.activities.find((item) => item.input.action === "status"),
        "scheduler status read",
      );
      trace.activities.splice(trace.activities.indexOf(status), 1);
      trace.activities.splice(
        trace.activities.findIndex((item) => item.input.action === "add") + 1,
        0,
        status,
      );
    } else if (violation === "missing-initial-read") {
      trace.activities.splice(trace.activities.indexOf(initialRead), 1);
      trace.calls = trace.calls.filter((call) => call.id !== initialRead.parentId);
      trace.outcomes = trace.outcomes.filter((outcome) => outcome.id !== initialRead.parentId);
    } else if (violation === "foreign-initial-read") {
      initialRead.input.jobId = "unrelated-job";
    } else if (violation === "foreign-updated-read") {
      updatedRead.input.jobId = "unrelated-job";
    } else if (violation === "foreign-history") {
      history.input.jobId = "unrelated-job";
    } else if (violation === "initial-result-id") {
      initialRead.result = { ...initialRead.result, id: "unrelated-job" };
    } else if (violation === "updated-result-id") {
      updatedRead.result = { ...updatedRead.result, id: "unrelated-job" };
    } else {
      const first = violation === "history-after-remove" ? history : update;
      const second =
        violation === "history-after-remove"
          ? removal
          : violation === "update-before-initial-read"
            ? initialRead
            : updatedRead;
      const firstIndex = trace.activities.indexOf(first);
      const secondIndex = trace.activities.indexOf(second);
      trace.activities[firstIndex] = second;
      trace.activities[secondIndex] = first;
    }
    const checks = evaluateGatewayMatrixTask({
      task: "automation-contracts",
      expected: AUTOMATION,
      final: JSON.stringify(AUTOMATION),
      trace,
      receipts: [],
    });
    expect(checks.answer).toBe(true);
    expect(checks.createdFacts).toBe(true);
    expect(checks.baselinePreserved).toBe(true);
    expect(checks.terminalInventoryComplete).toBe(true);
    expect(checks.createdRemoved).toBe(true);
    expect(Object.values(checks).every(Boolean)).toBe(false);
  });

  it("accepts the supported input.id alias throughout the correct job lifecycle", () => {
    const trace = automationEvidence("complete");
    for (const activity of trace.activities) {
      if (typeof activity.input.jobId === "string") {
        activity.input.id = activity.input.jobId;
        delete activity.input.jobId;
        expectDefined(
          trace.calls.find((call) => call.id === activity.parentId),
          "job lifecycle call",
        ).args.code = `return await automations(${JSON.stringify(activity.input)});`;
      }
    }
    const checks = evaluateGatewayMatrixTask({
      task: "automation-contracts",
      expected: AUTOMATION,
      final: JSON.stringify(AUTOMATION),
      trace,
      receipts: [],
    });
    expect(Object.values(checks).every(Boolean)).toBe(true);
  });

  it.each(["recurring", "past", "two-days-later", "isolated-session", "agent-payload"] as const)(
    "rejects a %s job even when its name and final cleanup match",
    (violation) => {
      const trace = automationEvidence("complete");
      const created = expectDefined(
        trace.activities.find((item) => item.input.action === "add"),
        "created automation",
      );
      if (violation === "recurring") {
        created.result.schedule = { kind: "every", everyMs: 86400000 };
      } else if (violation === "past") {
        created.result.schedule = { kind: "at", at: "2034-12-30T00:00:00.000Z" };
      } else if (violation === "two-days-later") {
        created.result.schedule = { kind: "at", at: "2035-01-02T00:00:00.000Z" };
      } else if (violation === "isolated-session") {
        created.result.sessionTarget = "isolated";
      } else {
        created.result.payload = { kind: "agentTurn", text: AUTOMATION.payloadText };
      }
      const checks = evaluateGatewayMatrixTask({
        task: "automation-contracts",
        expected: AUTOMATION,
        final: JSON.stringify(AUTOMATION),
        trace,
        receipts: [],
      });
      expect(checks.createdRemoved).toBe(true);
      expect(checks.createdFacts).toBe(false);
    },
  );

  it.each([false, true])("rejects an extra creation attempt with failure=%s", (failed) => {
    const trace = automationEvidence("complete");
    const created = expectDefined(
      trace.activities.find((item) => item.input.action === "add"),
      "created automation",
    );
    const input = {
      action: "add",
      job: {
        name: `${AUTOMATION.jobName}-extra`,
        enabled: false,
        sessionTarget: "main",
        schedule: { kind: "at", at: "2035-01-01T00:00:00.000Z" },
        payload: { kind: "systemEvent", text: AUTOMATION.payloadText },
      },
    };
    const extra = collectGatewayMatrixTrace([
      assistantCall("extra-create", `return await automations(${JSON.stringify(input)});`, true),
      nestedActivity(
        "extra-create",
        "automations",
        input,
        failed ? {} : { ...created.result, id: "owned-2" },
        failed,
      ),
      toolOutcome("extra-create", { status: failed ? "failed" : "completed" }, failed),
    ]);
    trace.calls.push(...extra.calls);
    trace.outcomes.push(...extra.outcomes);
    trace.activities.splice(trace.activities.indexOf(created) + 1, 0, ...extra.activities);
    const checks = evaluateGatewayMatrixTask({
      task: "automation-contracts",
      expected: AUTOMATION,
      final: JSON.stringify(AUTOMATION),
      trace,
      receipts: [],
    });
    expect(checks.answer).toBe(true);
    expect(checks.createdFacts).toBe(false);
  });

  it.each(["stale", "enabled-only", "partial"] as const)(
    "rejects %s inventories as proof that created jobs were removed",
    (terminal) => {
      const checks = evaluateGatewayMatrixTask({
        task: "automation-contracts",
        expected: AUTOMATION,
        final: JSON.stringify(AUTOMATION),
        trace: automationEvidence(terminal),
        receipts: [],
      });
      expect(checks.answer).toBe(true);
      expect(checks.terminalInventoryComplete).toBe(false);
      expect(checks.createdRemoved).toBe(false);
    },
  );

  it("rejects edits to a baseline job even when its ID remains present", () => {
    const checks = evaluateGatewayMatrixTask({
      task: "automation-contracts",
      expected: AUTOMATION,
      final: JSON.stringify(AUTOMATION),
      trace: automationEvidence("changed-baseline"),
      receipts: [],
    });
    expect(checks.terminalInventoryComplete).toBe(true);
    expect(checks.baselinePreserved).toBe(false);
  });

  it.each(["patch", "job", "raw", "update-result", "create-result"] as const)(
    "rejects an enabled job through the %s even after successful cleanup",
    (location) => {
      const trace = automationEvidence("complete");
      const operation = expectDefined(
        trace.activities.find(
          (item) => item.input.action === (location === "create-result" ? "add" : "update"),
        ),
        "automation lifecycle operation",
      );
      if (location === "patch" || location === "job") {
        operation.input[location] = { enabled: true };
      } else if (location === "raw") {
        operation.input.enabled = true;
      } else {
        operation.result.enabled = true;
      }
      const checks = evaluateGatewayMatrixTask({
        task: "automation-contracts",
        expected: AUTOMATION,
        final: JSON.stringify(AUTOMATION),
        trace,
        receipts: [],
      });
      expect(checks.createdRemoved).toBe(true);
      expect(location === "create-result" ? checks.createdDisabled : checks.remainedDisabled).toBe(
        false,
      );
    },
  );

  it.each(["run", "wake"] as const)(
    "rejects %s even after the final cleanup inventory",
    (action) => {
      const trace = automationEvidence("complete");
      const extra = collectGatewayMatrixTrace([
        assistantCall(
          "after-cleanup",
          `return await automations(${JSON.stringify({ action, jobId: "owned-1" })});`,
          true,
        ),
        nestedActivity("after-cleanup", "automations", { action, jobId: "owned-1" }, { ok: true }),
        toolOutcome("after-cleanup", { status: "completed", value: { ok: true } }),
      ]);
      trace.calls.push(...extra.calls);
      trace.outcomes.push(...extra.outcomes);
      trace.activities.push(...extra.activities);
      const checks = evaluateGatewayMatrixTask({
        task: "automation-contracts",
        expected: AUTOMATION,
        final: JSON.stringify(AUTOMATION),
        trace,
        receipts: [],
      });
      expect(checks.createdRemoved).toBe(true);
      expect(checks.remainedDisabled).toBe(false);
    },
  );

  it.each(["update", "remove"] as const)(
    "rejects a foreign-job %s despite a clean final inventory",
    (action) => {
      const trace = automationEvidence("complete");
      expectDefined(
        trace.activities.find((item) => item.input.action === action),
        "automation mutation",
      ).input.jobId = "system-heartbeat";
      const checks = evaluateGatewayMatrixTask({
        task: "automation-contracts",
        expected: AUTOMATION,
        final: JSON.stringify(AUTOMATION),
        trace,
        receipts: [],
      });
      expect(checks.baselinePreserved).toBe(true);
      expect(checks.onlyOwnedMutations).toBe(false);
    },
  );
});

const PROCESS = { marker: "MATRIX_PROCESS_R1_DONE", status: "completed", exitCode: 0 };

function processEvidence() {
  const events: unknown[] = [];
  function action(name: string, input: Record<string, unknown>, result: Record<string, unknown>) {
    const id = `process-${events.length}`;
    events.push(
      assistantCall(id, `return await ${name}(${JSON.stringify(input)});`, true),
      nestedActivity(id, name, input, result),
      toolOutcome(id, { status: "completed", value: result }),
    );
  }
  action(
    "exec",
    { command: "node ./process-probe.mjs", background: true },
    { status: "running", sessionId: "helper-1" },
  );
  action(
    "process",
    { action: "list" },
    { status: "completed", sessions: [{ sessionId: "helper-1", status: "running" }] },
  );
  action(
    "process",
    { action: "log", sessionId: "helper-1" },
    { status: "running", output: PROCESS.marker },
  );
  action(
    "process",
    { action: "poll", sessionId: "helper-1" },
    { status: "completed", exitCode: 0, aggregated: PROCESS.marker },
  );
  return collectGatewayMatrixTrace(events);
}

describe("process lifecycle evidence", () => {
  it("accepts exactly one helper launch followed by checked reads of its process", () => {
    const checks = evaluateGatewayMatrixTask({
      task: "process-contracts",
      expected: PROCESS,
      final: JSON.stringify(PROCESS),
      trace: processEvidence(),
      receipts: [],
    });
    expect(Object.values(checks).every(Boolean)).toBe(true);
  });

  it.each(["second-helper", "unrelated-shell", "failed-launch"] as const)(
    "rejects an extra %s even after observing the first helper finish",
    (violation) => {
      const trace = processEvidence();
      const input = {
        command:
          violation === "unrelated-shell" ? "node ./unrelated.mjs" : "node ./process-probe.mjs",
        background: true,
      };
      const failed = violation === "failed-launch";
      const extra = collectGatewayMatrixTrace([
        assistantCall("extra-launch", `return await exec(${JSON.stringify(input)});`, true),
        nestedActivity(
          "extra-launch",
          "exec",
          input,
          failed ? {} : { status: "running", sessionId: "helper-2" },
          failed,
        ),
        toolOutcome("extra-launch", { status: failed ? "failed" : "completed" }, failed),
      ]);
      trace.calls.push(...extra.calls);
      trace.outcomes.push(...extra.outcomes);
      trace.activities.push(...extra.activities);
      const checks = evaluateGatewayMatrixTask({
        task: "process-contracts",
        expected: PROCESS,
        final: JSON.stringify(PROCESS),
        trace,
        receipts: [],
      });
      expect(checks.observedCompletion).toBe(true);
      expect(checks.singleHelperLaunch).toBe(false);
    },
  );

  it.each([
    { action: "kill", sessionId: "unrelated" },
    { action: "write", sessionId: "unrelated", data: "unexpected input" },
    { action: "clear", sessionId: "unrelated" },
    { action: "poll", sessionId: "unrelated" },
    { action: "kill", sessionId: "helper-1" },
  ])("rejects extra process operation $action on $sessionId", (input) => {
    const trace = processEvidence();
    const extra = collectGatewayMatrixTrace([
      assistantCall("extra-process", `return await process(${JSON.stringify(input)});`, true),
      nestedActivity("extra-process", "process", input, { status: "completed" }),
      toolOutcome("extra-process", { status: "completed" }),
    ]);
    trace.calls.push(...extra.calls);
    trace.outcomes.push(...extra.outcomes);
    trace.activities.push(...extra.activities);
    const checks = evaluateGatewayMatrixTask({
      task: "process-contracts",
      expected: PROCESS,
      final: JSON.stringify(PROCESS),
      trace,
      receipts: [],
    });
    expect(checks.singleHelperLaunch).toBe(true);
    expect(checks.onlyHelperReads).toBe(false);
  });
});

describe("checked-cell cache evidence", () => {
  const expected = {
    cells: [
      { ordinal: 1, sum: 11 },
      { ordinal: 2, sum: 21 },
      { ordinal: 3, sum: 31 },
    ],
  };
  function cacheEvents(): unknown[] {
    return expected.cells.flatMap((cell) => {
      const id = `checked-${cell.ordinal}`;
      return [
        assistantCall(
          id,
          `const listed=await process({action:"list"}); if(!("sessions" in listed)) throw new Error("Missing sessions"); return {ordinal:${cell.ordinal},sum:1+${cell.ordinal}*10};`,
          true,
        ),
        nestedActivity(id, "process", { action: "list" }, { status: "completed", sessions: [] }),
        toolOutcome(id, { status: "completed", value: cell }),
      ];
    });
  }
  function cacheEvidence() {
    return collectGatewayMatrixTrace(cacheEvents());
  }
  it("accepts exactly three checked cells with only process-list reads", () => {
    const checks = evaluateGatewayMatrixTask({
      task: "checked-cell-cache",
      expected,
      final: JSON.stringify(expected),
      trace: cacheEvidence(),
      receipts: [],
    });
    expect(Object.values(checks).every(Boolean)).toBe(true);
  });
  it.each(["wrong", "missing"] as const)(
    "rejects a %s cell return even when the final answer is correct",
    (kind) => {
      const trace = cacheEvidence();
      const outcome = expectDefined(trace.outcomes[0], "first checked-cell outcome");
      if (kind === "wrong") {
        outcome.details.value = { ordinal: 1, sum: -1 };
      } else {
        delete outcome.details.value;
      }
      const checks = evaluateGatewayMatrixTask({
        task: "checked-cell-cache",
        expected,
        final: JSON.stringify(expected),
        trace,
        receipts: [],
      });
      expect(checks.answer).toBe(true);
      expect(Object.values(checks).every(Boolean)).toBe(false);
    },
  );
  it.each([true, false])(
    "requires exec→wait completion before starting the next checked cell: sequential=%s",
    (sequential) => {
      const events = cacheEvents();
      events[2] = toolOutcome("checked-1", { status: "waiting", runId: "suspended-first-cell" });
      const resumed = waitEvents("resume-first", "suspended-first-cell", {
        status: "completed",
        value: expectDefined(expected.cells[0], "first expected cell"),
      });
      events.splice(sequential ? 3 : events.length, 0, ...resumed);
      const checks = evaluateGatewayMatrixTask({
        task: "checked-cell-cache",
        expected,
        final: JSON.stringify(expected),
        trace: collectGatewayMatrixTrace(events),
        receipts: [],
      });
      expect(checks.answer).toBe(true);
      expect(Object.values(checks).every(Boolean)).toBe(sequential);
    },
  );
  it("rejects an extra unchecked exec even when three checked cells succeeded", () => {
    const trace = cacheEvidence();
    const extra = collectGatewayMatrixTrace([
      assistantCall("extra", "return 4;"),
      toolOutcome("extra", { status: "completed", value: 4 }),
    ]);
    trace.calls.push(...extra.calls);
    trace.outcomes.push(...extra.outcomes);
    const checks = evaluateGatewayMatrixTask({
      task: "checked-cell-cache",
      expected,
      final: JSON.stringify(expected),
      trace,
      receipts: [],
    });
    expect(checks.threeCheckedCells).toBe(false);
  });
  it.each([
    { name: "process", input: { action: "kill", sessionId: "unrelated" } },
    { name: "read", input: { path: "unrelated.txt" } },
  ])("rejects an additional $name operation inside a checked cell", ({ name, input }) => {
    const trace = cacheEvidence();
    expectDefined(trace.calls[0], "first checked cell").args.code =
      `await process({action:"list"}); await ${name}(${JSON.stringify(input)}); return {ordinal:1,sum:11};`;
    const extra = collectGatewayMatrixTrace([nestedActivity("checked-1", name, input, {})]);
    trace.activities.push(...extra.activities);
    const checks = evaluateGatewayMatrixTask({
      task: "checked-cell-cache",
      expected,
      final: JSON.stringify(expected),
      trace,
      receipts: [],
    });
    expect(checks.threeCheckedCells).toBe(true);
    expect(checks.onlyProcessListReads).toBe(false);
  });
});

describe("Gateway matrix interview evidence", () => {
  const answer = JSON.stringify({
    rationale: "The previous reference held a snapshot; this run observed that it expired.",
    facts: {
      priorRefAvailable: false,
      retainedDataFresh: false,
      sameRunOnly: true,
      previewComplete: false,
    },
  });

  const previewCases: {
    label: string;
    descriptors: { id: string; previewTruncated?: boolean }[];
    probedIds: string[];
    previewComplete: boolean | null;
    accepted: boolean;
  }[] = [
    {
      label: "full preview",
      descriptors: [{ id: "full", previewTruncated: false }],
      probedIds: ["full"],
      previewComplete: true,
      accepted: true,
    },
    {
      label: "truncated preview",
      descriptors: [{ id: "partial", previewTruncated: true }],
      probedIds: ["partial"],
      previewComplete: false,
      accepted: true,
    },
    {
      label: "incorrect full-preview claim",
      descriptors: [{ id: "full", previewTruncated: false }],
      probedIds: ["full"],
      previewComplete: false,
      accepted: false,
    },
    {
      label: "missing preview metadata",
      descriptors: [{ id: "unknown" }],
      probedIds: ["unknown"],
      previewComplete: null,
      accepted: true,
    },
    {
      label: "mixed selected previews",
      descriptors: [
        { id: "full", previewTruncated: false },
        { id: "partial", previewTruncated: true },
      ],
      probedIds: ["full", "partial"],
      previewComplete: null,
      accepted: true,
    },
    {
      label: "conflicting descriptors",
      descriptors: [
        { id: "same", previewTruncated: false },
        { id: "same", previewTruncated: true },
      ],
      probedIds: ["same"],
      previewComplete: null,
      accepted: true,
    },
    {
      label: "unprobed truncated preview",
      descriptors: [
        { id: "full", previewTruncated: false },
        { id: "partial", previewTruncated: true },
      ],
      probedIds: ["full"],
      previewComplete: true,
      accepted: true,
    },
    {
      label: "known and unknown selected previews",
      descriptors: [{ id: "full", previewTruncated: false }, { id: "unknown" }],
      probedIds: ["full", "unknown"],
      previewComplete: null,
      accepted: true,
    },
  ];
  it.each(previewCases)(
    "uses the actually probed descriptors for $label",
    ({ descriptors, probedIds, previewComplete, accepted }) => {
      const taskTrace = collectGatewayMatrixTrace([
        assistantCall("saved", "return await results.save({});"),
        toolOutcome("saved", {
          status: "completed",
          value: descriptors.map((descriptor) => ({
            bytes: 2,
            count: 0,
            shape: "object",
            preview: "{}",
            ...descriptor,
          })),
        }),
      ]);
      const interviewTrace = collectGatewayMatrixTrace(
        probedIds.flatMap((id, index) => [
          assistantCall(
            `probe-${index}`,
            `try { return await results.load(${JSON.stringify(id)}); } catch (error) { return {error:String(error)}; }`,
          ),
          toolOutcome(`probe-${index}`, {
            status: "completed",
            value: { error: `Result reference ${id} is unavailable or expired` },
          }),
        ]),
      );
      const final = JSON.stringify({
        rationale: "I inspected the descriptors and observed that the probed references expired.",
        facts: {
          priorRefAvailable: false,
          retainedDataFresh: false,
          sameRunOnly: true,
          previewComplete,
        },
      });
      const checks = evaluateGatewayMatrixInterview(
        "invoices-auto-retention",
        taskTrace,
        interviewTrace,
        final,
      );
      expect(checks.priorReferenceProbed).toBe(true);
      expect(checks.priorReferenceUnavailable).toBe(true);
      expect(Object.values(checks).every(Boolean)).toBe(accepted);
    },
  );

  it.each(["claim-only", "call-without-outcome", "observed-expiry", "external-action"] as const)(
    "requires actual expiry evidence for %s",
    (scenario) => {
      const taskTrace = collectGatewayMatrixTrace(invoiceEvidence().events);
      const events: unknown[] = [];
      if (scenario !== "claim-only") {
        events.push(
          assistantCall(
            "probe",
            'try { return await results.load("result-1"); } catch (error) { return {error:String(error)}; }',
          ),
        );
      }
      if (scenario === "observed-expiry" || scenario === "external-action") {
        events.push(
          toolOutcome("probe", {
            status: "completed",
            value: { error: "Result reference result-1 is unavailable or expired" },
          }),
        );
      }
      if (scenario === "external-action") {
        events.push(nestedActivity("probe", "matrix_invoice_export"));
      }
      const checks = evaluateGatewayMatrixInterview(
        "invoices-auto-retention",
        taskTrace,
        collectGatewayMatrixTrace(events),
        answer,
      );
      expect(checks.answered).toBe(true);
      expect(Object.values(checks).every(Boolean)).toBe(scenario === "observed-expiry");
      if (scenario === "claim-only" || scenario === "call-without-outcome") {
        expect(checks.priorReferenceUnavailable).toBe(false);
      }
      if (scenario === "external-action") {
        expect(checks.noExternalAction).toBe(false);
      }
    },
  );

  it.each([
    { scenario: "caught-expiry", accepted: true },
    { scenario: "uncaught-expiry", accepted: true },
    { scenario: "multiple-waits", accepted: true },
    { scenario: "unrelated-run-id", accepted: false },
    { scenario: "never-terminal", accepted: false },
    { scenario: "unrelated-expiry-text", accepted: false },
  ] as const)(
    "requires correlated terminal expiry evidence through $scenario",
    ({ scenario, accepted }) => {
      const taskTrace = collectGatewayMatrixTrace(invoiceEvidence().events);
      const events: unknown[] = [
        assistantCall(
          "probe",
          scenario === "uncaught-expiry"
            ? 'return await results.load("result-1");'
            : 'try { return await results.load("result-1"); } catch (error) { return {error:String(error)}; }',
        ),
        toolOutcome("probe", { status: "waiting", runId: "expiry-probe-run" }),
      ];
      function wait(id: string, runId: string, details: Record<string, unknown>, isError = false) {
        events.push(...waitEvents(id, runId, details, isError));
      }
      const expired = { error: "Result reference result-1 is unavailable or expired" };
      if (scenario === "never-terminal") {
        wait("resume-1", "expiry-probe-run", {
          status: "waiting",
          runId: "expiry-probe-run",
          output: [expired],
        });
      } else if (scenario === "unrelated-expiry-text") {
        wait("resume-1", "expiry-probe-run", {
          status: "completed",
          value: { data: "still available" },
        });
        events.push(
          assistantCall("unrelated", 'return "An unrelated label expired";'),
          toolOutcome("unrelated", { status: "completed", value: expired }),
        );
      } else {
        if (scenario === "multiple-waits") {
          wait("resume-1", "expiry-probe-run", { status: "waiting", runId: "expiry-probe-run" });
        }
        wait(
          "resume-final",
          scenario === "unrelated-run-id" ? "other-run" : "expiry-probe-run",
          scenario === "uncaught-expiry"
            ? { status: "failed", ...expired }
            : { status: "completed", value: expired },
          scenario === "uncaught-expiry",
        );
      }
      const checks = evaluateGatewayMatrixInterview(
        "invoices-auto-retention",
        taskTrace,
        collectGatewayMatrixTrace(events),
        answer,
      );
      expect(checks.priorReferenceProbed).toBe(true);
      expect(checks.priorReferenceUnavailable).toBe(accepted);
      expect(Object.values(checks).every(Boolean)).toBe(accepted);
    },
  );
});

function comparisonRow() {
  return {
    id: "invoice-code-r1",
    task: "invoices-auto-retention",
    model: "openai/gpt-5.6-sol",
    mode: "code",
    repetition: 1,
    gitSha: "baseline-sha",
    passed: true,
    elapsedMs: 20000,
    workload: {
      promptSha256: "fixed-prompt",
      fixtureSha256: "fixed-fixture",
      settings: { thinking: "off", timeoutSeconds: 120 },
    },
    gateway: {
      upstreamCalls: 1,
      taskElapsedMs: 10000,
    },
  };
}

it("includes the exact process-helper bytes in the fixed workload fingerprint", () => {
  const fixture = gatewayFixtures.createGatewayMatrixFixture("process-contracts", 1);
  const firstHelper = {
    ...fixture,
    processHelperSource: 'console.log("probe"); setTimeout(() => {}, 2000);\n',
  };
  const secondHelper = {
    ...fixture,
    processHelperSource: 'console.log("probe"); setTimeout(() => {}, 3000);\n',
  };
  const spy = vi.spyOn(gatewayFixtures, "createGatewayMatrixFixture");
  try {
    spy.mockReturnValue(firstHelper);
    const baseline = createGatewayMatrixWorkload("process-contracts", 1, "off", 120);
    spy.mockReturnValue(secondHelper);
    const candidate = createGatewayMatrixWorkload("process-contracts", 1, "off", 120);
    expect(candidate.promptSha256).toBe(baseline.promptSha256);
    expect(candidate.settings).toEqual(baseline.settings);
    expect(candidate.fixtureSha256).not.toBe(baseline.fixtureSha256);
  } finally {
    spy.mockRestore();
  }
});

describe("fixed Gateway matrix comparisons", () => {
  it.each(["prompt", "fixture", "thinking", "timeout"] as const)(
    "rejects a changed %s instead of comparing different workloads",
    (field) => {
      const baseline = comparisonRow();
      const candidate = comparisonRow();
      if (field === "prompt") {
        candidate.workload.promptSha256 = "changed";
      } else if (field === "fixture") {
        candidate.workload.fixtureSha256 = "changed";
      } else if (field === "thinking") {
        candidate.workload.settings.thinking = "high";
      } else {
        candidate.workload.settings.timeoutSeconds = 240;
      }
      expect(() => compareCodeModeMatrixResults([baseline], [candidate])).toThrow(
        "workload changed",
      );
    },
  );

  it("rejects duplicate or missing paired cells", () => {
    const row = comparisonRow();
    expect(() => compareCodeModeMatrixResults([row, row], [row])).toThrow("Duplicate");
    expect(() => compareCodeModeMatrixResults([row], [row, row])).toThrow("Duplicate");
    expect(() => compareCodeModeMatrixResults([row], [])).toThrow(
      "same model/mode/task/repetition",
    );
  });

  it("pairs a failed trial without Gateway metrics using its retained workload identity", () => {
    const { gateway: _gateway, ...failed } = comparisonRow();
    const compared = compareCodeModeMatrixResults(
      [{ ...failed, passed: false }],
      [comparisonRow()],
    );
    expect(expectDefined(compared.cells[0], "failed paired comparison")).toMatchObject({
      baselinePassed: false,
      candidatePassed: true,
      bothPassed: false,
      deltas: null,
    });
  });

  it("rejects legacy rows without workload fingerprints", () => {
    const { workload: _workload, ...legacy } = comparisonRow();
    expect(() => compareCodeModeMatrixResults([legacy], [comparisonRow()])).toThrow(
      "workload fingerprints",
    );
  });

  it.each(["baseline", "candidate"] as const)(
    "does not report a timing gain when the %s trial failed",
    (failed) => {
      const baseline = comparisonRow();
      const candidate = { ...comparisonRow(), gitSha: "candidate-sha", elapsedMs: 1 };
      candidate.gateway.taskElapsedMs = 1;
      if (failed === "baseline") {
        baseline.passed = false;
      } else {
        candidate.passed = false;
      }
      const compared = compareCodeModeMatrixResults([baseline], [candidate]);
      const cell = expectDefined(compared.cells[0], "paired comparison cell");
      expect(cell.bothPassed).toBe(false);
      expect(cell.deltas).toBeNull();
    },
  );

  it("compares task time separately from startup and leaves unobserved metrics null", () => {
    const baseline = comparisonRow();
    const candidate = { ...comparisonRow(), gitSha: "candidate-sha", elapsedMs: 30000 };
    candidate.gateway.taskElapsedMs = 8000;
    const compared = compareCodeModeMatrixResults([baseline], [candidate]);
    expect(expectDefined(compared.cells[0], "paired comparison cell").deltas).toEqual({
      taskElapsedMs: -2000,
      assistantTurns: null,
      upstreamCalls: 0,
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
  });
});

function comparisonRowWithOutcomes() {
  const row = comparisonRow();
  return {
    ...row,
    oracle: { identity: true },
    gateway: {
      ...row.gateway,
      traceAvailable: true,
      behavior: { answer: true, complete: true },
      interview: {
        traceAvailable: true,
        checks: { answered: true, priorReferenceUnavailable: true },
      },
    },
  };
}

describe("separate task and interview comparison outcomes", () => {
  it("retains overall failure while comparing successful task behavior separately from a failed interview", () => {
    const baseline = comparisonRowWithOutcomes();
    const candidate = comparisonRowWithOutcomes();
    candidate.passed = false;
    candidate.gateway.taskElapsedMs = 8000;
    candidate.gateway.interview.checks.priorReferenceUnavailable = false;
    const compared = compareCodeModeMatrixResults([baseline], [candidate]);
    const cell = expectDefined(compared.cells[0], "paired outcome comparison");
    expect(cell).toMatchObject({
      baselinePassed: true,
      candidatePassed: false,
      bothPassed: false,
      deltas: null,
    });
    expect(cell.taskBehavior).toEqual({
      baselinePassed: true,
      candidatePassed: true,
      bothPassed: true,
      modelsMatched: true,
      deltas: {
        taskElapsedMs: -2000,
        assistantTurns: null,
        upstreamCalls: 0,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      },
    });
    expect(cell.interviewConsistency).toEqual({ baselinePassed: true, candidatePassed: false });
    expect(compared.baselinePassed).toBe(1);
    expect(compared.candidatePassed).toBe(0);
    expect(compared.outcomes).toEqual({
      taskBehavior: {
        baseline: { passed: 1, failed: 0, unavailable: 0 },
        candidate: { passed: 1, failed: 0, unavailable: 0 },
      },
      interviewConsistency: {
        baseline: { passed: 1, failed: 0, unavailable: 0 },
        candidate: { passed: 0, failed: 1, unavailable: 0 },
      },
    });
  });

  it("withholds task timing deltas for failed task behavior even when the interview is consistent", () => {
    const baseline = comparisonRowWithOutcomes();
    const candidate = comparisonRowWithOutcomes();
    candidate.passed = false;
    candidate.gateway.taskElapsedMs = 1;
    candidate.gateway.behavior.answer = false;
    const compared = compareCodeModeMatrixResults([baseline], [candidate]);
    const cell = expectDefined(compared.cells[0], "failed task outcome comparison");
    expect(cell.deltas).toBeNull();
    expect(cell.taskBehavior).toEqual({
      baselinePassed: true,
      candidatePassed: false,
      bothPassed: false,
      modelsMatched: true,
      deltas: null,
    });
    expect(cell.interviewConsistency).toEqual({ baselinePassed: true, candidatePassed: true });
    expect(compared.outcomes.taskBehavior.candidate).toEqual({
      passed: 0,
      failed: 1,
      unavailable: 0,
    });
    expect(compared.outcomes.interviewConsistency.candidate).toEqual({
      passed: 1,
      failed: 0,
      unavailable: 0,
    });
  });

  it.each([
    {
      label: "missing trace flags",
      gateway: { behavior: { answer: true }, interview: { checks: { answered: true } } },
    },
    {
      label: "unavailable traces",
      gateway: {
        traceAvailable: false,
        behavior: { answer: false },
        interview: { traceAvailable: false, checks: { answered: false } },
      },
    },
    {
      label: "missing check maps",
      gateway: { traceAvailable: true, interview: { traceAvailable: true } },
    },
    {
      label: "empty check maps",
      gateway: {
        traceAvailable: true,
        behavior: {},
        interview: { traceAvailable: true, checks: {} },
      },
    },
    {
      label: "nonboolean check values",
      gateway: {
        traceAvailable: true,
        behavior: { answer: "true" },
        interview: { traceAvailable: true, checks: { answered: "false" } },
      },
    },
  ])(
    "counts $label as unavailable rather than a failed or zero-valued observation",
    ({ gateway }) => {
      const baseline = comparisonRowWithOutcomes();
      const candidate = { ...comparisonRow(), passed: false, gateway };
      const compared = compareCodeModeMatrixResults([baseline], [candidate]);
      const cell = expectDefined(compared.cells[0], "unavailable outcome comparison");
      expect(cell.deltas).toBeNull();
      expect(cell.taskBehavior).toEqual({
        baselinePassed: true,
        candidatePassed: null,
        bothPassed: false,
        modelsMatched: false,
        deltas: null,
      });
      expect(cell.interviewConsistency).toEqual({ baselinePassed: true, candidatePassed: null });
      expect(compared.outcomes.taskBehavior.candidate).toEqual({
        passed: 0,
        failed: 0,
        unavailable: 1,
      });
      expect(compared.outcomes.interviewConsistency.candidate).toEqual({
        passed: 0,
        failed: 0,
        unavailable: 1,
      });
    },
  );

  it.each(["task", "interview"] as const)(
    "keeps unavailable %s evidence independent of the other outcome",
    (missing) => {
      const baseline = comparisonRowWithOutcomes();
      const candidate = comparisonRowWithOutcomes();
      candidate.passed = false;
      if (missing === "task") {
        candidate.gateway.traceAvailable = false;
      } else {
        candidate.gateway.interview.traceAvailable = false;
      }
      const compared = compareCodeModeMatrixResults([baseline], [candidate]);
      const cell = expectDefined(compared.cells[0], "independent evidence comparison");
      expect(cell.taskBehavior.candidatePassed).toBe(missing === "task" ? null : true);
      expect(cell.interviewConsistency.candidatePassed).toBe(missing === "interview" ? null : true);
    },
  );

  it.each([
    { side: "baseline", identity: "mismatched" },
    { side: "candidate", identity: "mismatched" },
    { side: "baseline", identity: "missing" },
    { side: "candidate", identity: "missing" },
  ] as const)(
    "withholds task-only deltas when $side model identity is $identity",
    ({ side, identity }) => {
      const { oracle: _oracle, ...withoutIdentity } = comparisonRowWithOutcomes();
      const unverified = {
        ...withoutIdentity,
        passed: false,
        ...(identity === "mismatched" ? { oracle: { identity: false } } : {}),
      };
      const baseline = side === "baseline" ? unverified : comparisonRowWithOutcomes();
      const candidate = side === "candidate" ? unverified : comparisonRowWithOutcomes();
      const compared = compareCodeModeMatrixResults([baseline], [candidate]);
      const cell = expectDefined(compared.cells[0], "comparison with unverified model identity");
      expect(cell.deltas).toBeNull();
      expect(cell.taskBehavior).toEqual({
        baselinePassed: true,
        candidatePassed: true,
        bothPassed: true,
        modelsMatched: false,
        deltas: null,
      });
      expect(compared.outcomes.taskBehavior).toEqual({
        baseline: { passed: 1, failed: 0, unavailable: 0 },
        candidate: { passed: 1, failed: 0, unavailable: 0 },
      });
    },
  );
});
