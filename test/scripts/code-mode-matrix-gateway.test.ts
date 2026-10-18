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
  type GatewayMatrixTrace,
} from "../../scripts/lib/code-mode-matrix-gateway.js";
import type { NestedToolActivity } from "../../src/sessions/nested-tool-activity.js";

function evaluate(
  task: Parameters<typeof evaluateGatewayMatrixTask>[0]["task"],
  expected: Record<string, unknown>,
  trace: GatewayMatrixTrace,
  receipts: readonly unknown[] = [],
) {
  return evaluateGatewayMatrixTask({
    task,
    expected,
    final: JSON.stringify(expected),
    trace,
    receipts,
  });
}

function assistantCall(id: string, code: string) {
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
          arguments: { code },
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
  content: { type: "text"; text: string }[] = [],
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
      result: { content, details: result },
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
  it.each([{ surface: "direct", isError: true }] as const)(
    "counts one underlying shell outcome through $surface with error=$isError",
    ({ isError }) => {
      const input = { command: "node ./process-probe.mjs" };
      const result = {
        status: isError ? "failed" : "completed",
        exitCode: isError ? 1 : 0,
        aggregated: isError ? "synthetic process failure" : "synthetic process complete",
      };
      const name = "exec";
      const invocation = {
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "invoke",
              name,
              arguments: input,
            },
          ],
        },
      };
      const trace = collectGatewayMatrixTrace([
        invocation,
        toolOutcome("invoke", result, isError, name),
      ]);
      expect(trace.activities).toHaveLength(1);
      expect(trace.activities[0]).toMatchObject({
        name: "exec",
        input,
        result,
        isError,
        eventIndex: 1,
      });
      expect(trace.activities[0]?.parentId).toBe(undefined);
      expect(trace.calls.map((call) => call.name)).toEqual([name]);
      expect(trace.outcomes.map((outcome) => outcome.name)).toEqual([name]);
    },
  );

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

  it.each([
    { label: "zero placeholders", input: 0, output: 0, known: "none" },
    { label: "provisional counters", input: 20, output: 3, known: "none" },
    { label: "known then unavailable", input: 20, output: 3, known: "before" },
    { label: "unavailable then known", input: 20, output: 3, known: "after" },
  ])("does not qualify $label as measured savings", ({ input, output, known }) => {
    const unavailable = {
      message: {
        ...assistantCall("unavailable", "return await matrix_read({});").message,
        usage: {
          input,
          output,
          totalTokens: input + output,
          cost: { total: 0.5 },
          usageReport: { state: "unavailable" },
        },
      },
    };
    const observed = {
      message: {
        ...assistantCall("observed", "return 1;").message,
        usage: {
          input: 100,
          output: 10,
          totalTokens: 110,
          cost: { total: 0.002 },
          usageReport: { state: "available" },
        },
      },
    };
    const trace = collectGatewayMatrixTrace([
      ...(known === "before" ? [observed] : []),
      unavailable,
      nestedActivity("unavailable", "matrix_read", {}, { value: 1 }),
      toolOutcome("unavailable", { status: "completed", value: 1 }),
      ...(known === "after" ? [observed] : []),
    ]);
    expect(trace.assistantTurns).toBe(known === "none" ? 1 : 2);
    expect(trace.models).toEqual(["openai/gpt-5.6-sol"]);
    expect(trace.calls).toHaveLength(known === "none" ? 1 : 2);
    expect(trace.outcomes).toHaveLength(1);
    expect(trace.activities).toHaveLength(1);
    expect(trace.activities[0]).toMatchObject({ name: "matrix_read", result: { value: 1 } });
    expect(trace.usage).toBeUndefined();
    expect(trace.costUsd).toBeUndefined();

    const compared = compareCodeModeMatrixResults(
      [{ ...comparisonRow(), usage: { input: 100, output: 10 }, costUsd: 0.002 }],
      [
        {
          ...comparisonRow(),
          gitSha: "candidate-sha",
          usage: trace.usage,
          costUsd: trace.costUsd,
        },
      ],
    );
    expect(expectDefined(compared.cells[0], "paired comparison cell").deltas).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
  });

  it("retains genuinely measured zero usage and cost", () => {
    const trace = collectGatewayMatrixTrace([
      {
        message: {
          ...assistantCall("zero", "return 0;").message,
          usage: {
            input: 0,
            output: 0,
            totalTokens: 0,
            cost: { total: 0, totalOrigin: "provider-billed" },
            usageReport: { state: "available" },
          },
        },
      },
    ]);
    expect(trace.usage).toEqual({ input: 0, output: 0, total: 0 });
    expect(trace.costUsd).toBe(0);
    expect(trace.assistantTurns).toBe(1);
  });
});

describe("Gateway matrix capability preflight", () => {
  it.each(["registered", "wrong-plugin"] as const)(
    "requires the fixture's registered capability: %s",
    (registration) => {
      const required = ["exec", "matrix_invoice_export"];
      const tools = [
        { id: "exec", source: "core" },
        {
          id: "matrix_invoice_export",
          source: "plugin",
          pluginId: registration === "registered" ? "code-mode-matrix-fixture" : "unrelated-plugin",
        },
      ];
      const check = () => requireGatewayMatrixTools({ groups: [{ tools }] }, required);
      if (registration === "registered") {
        expect(check()).toEqual(required);
      } else {
        expect(check).toThrow("preflight failed before model call: matrix_invoice_export");
      }
    },
  );
});

describe("Gateway matrix task oracles", () => {
  it.each([
    ["multiple-waits", 2],
    ["unrelated-run", 1],
  ] as const)("requires correlated settlement diagnostics through %s", (scenario, waits) => {
    const { events: initialEvents, receipts } = settlementEvidence();
    const events: unknown[] = initialEvents;
    {
      events[0] = assistantCall(
        "settle",
        'try { return await matrix_settle({operationId:"matrix-settlement-1"}); } catch (error) { return {error:String(error)}; }',
      );
      const diagnostic = {
        status: "completed",
        value: {
          error: "Output contract: receipt must be a string; totalCents is required",
        },
      };
      const waiting = { status: "waiting", runId: "settlement-run" };
      events[2] = toolOutcome("settle", waits ? waiting : diagnostic);
      if (waits) {
        events.splice(
          3,
          0,
          ...(waits === 2 ? waitEvents("pending-settlement", "settlement-run", waiting) : []),
          ...waitEvents(
            "settlement-diagnostic",
            scenario === "unrelated-run" ? "another-run" : "settlement-run",
            diagnostic,
          ),
        );
      }
    }
    const checks = evaluate(
      "partial-failure",
      SETTLEMENT,
      collectGatewayMatrixTrace(events),
      receipts,
    );
    const accepted = scenario !== "unrelated-run";
    expect(checks.answer).toBe(true);
    expect(checks.exactlyOneEffect).toBe(true);
    expect(checks.inspectedAfterFailure).toBe(true);
    expect(checks.observedPersistedState).toBe(true);
    expect(checks.actionableDiagnostics).toBe(accepted);
    expect(Object.values(checks).every(Boolean)).toBe(accepted);
  });

  it("grades retained retention while preserving the correct-answer observation", () => {
    const { events, receipts } = invoiceEvidence();
    const trace = collectGatewayMatrixTrace(events);

    const checks = evaluate("invoices-auto-retention", INVOICES, trace, receipts);
    expect(checks.answer).toBe(true);
    expect(Object.values(checks).every(Boolean)).toBe(true);
  });
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
      assistantCall(id, `return await automations(${JSON.stringify(input)});`),
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

function automationActivity(trace: GatewayMatrixTrace, action: string, name?: string) {
  return expectDefined(
    trace.activities.find(
      (item) => item.input.action === action && (name === undefined || item.result.name === name),
    ),
    action,
  );
}

describe("terminal automation evidence", () => {
  it.each(["early-history", "history-before-read", "id-alias"] as const)(
    "accepts the %s lifecycle with complete inventories and preserved baseline jobs",
    (variant) => {
      const trace = automationEvidence("complete");
      if (variant === "id-alias") {
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
      } else {
        const history = automationActivity(trace, "runs");
        const anchor =
          variant === "early-history"
            ? automationActivity(trace, "add")
            : automationActivity(trace, "get", AUTOMATION.updatedName);
        trace.activities.splice(trace.activities.indexOf(history), 1);
        trace.activities.splice(
          trace.activities.indexOf(anchor) + Number(variant === "early-history"),
          0,
          history,
        );
      }
      expect(
        Object.values(evaluate("automation-contracts", AUTOMATION, trace)).every(Boolean),
      ).toBe(true);
    },
  );

  it.each([
    "late-status",
    "update-before-initial-read",
    "updated-read-before-update",
    "history-after-remove",
  ] as const)("rejects %s despite a correct final answer and inventory", (violation) => {
    const trace = automationEvidence("complete");
    const initialRead = automationActivity(trace, "get", AUTOMATION.jobName);
    const updatedRead = automationActivity(trace, "get", AUTOMATION.updatedName);
    const history = automationActivity(trace, "runs");
    const update = automationActivity(trace, "update");
    const removal = automationActivity(trace, "remove");
    if (violation === "late-status") {
      const status = automationActivity(trace, "status");
      trace.activities.splice(trace.activities.indexOf(status), 1);
      trace.activities.splice(
        trace.activities.findIndex((item) => item.input.action === "add") + 1,
        0,
        status,
      );
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
    const checks = evaluate("automation-contracts", AUTOMATION, trace);
    expect(checks.answer).toBe(true);
    expect(checks.createdFacts).toBe(true);
    expect(checks.baselinePreserved).toBe(true);
    expect(checks.terminalInventoryComplete).toBe(true);
    expect(checks.createdRemoved).toBe(true);
    expect(Object.values(checks).every(Boolean)).toBe(false);
  });

  it("rejects a recurring job even when its name and final cleanup match", () => {
    const trace = automationEvidence("complete");
    const created = automationActivity(trace, "add");
    created.result.schedule = { kind: "every", everyMs: 86400000 };
    const checks = evaluate("automation-contracts", AUTOMATION, trace);
    expect(checks.answer).toBe(true);
    expect(checks.createdRemoved).toBe(true);
    expect(checks.createdFacts).toBe(false);
  });

  it.each(["partial"] as const)(
    "rejects %s inventories as proof of clean, isolated removal",
    (terminal) => {
      const checks = evaluate("automation-contracts", AUTOMATION, automationEvidence(terminal));
      const complete = false;
      expect(checks.answer).toBe(true);
      expect(checks.terminalInventoryComplete).toBe(complete);
      expect(checks.createdRemoved).toBe(complete);
      expect(checks.baselinePreserved).toBe(false);
    },
  );

  it.each(["job", "wake"] as const)(
    "rejects an enabled job through the %s even after successful cleanup",
    (location) => {
      const trace = automationEvidence("complete");
      if (location === "wake") {
        const action = location;
        const extra = collectGatewayMatrixTrace([
          assistantCall(
            "after-cleanup",
            `return await automations(${JSON.stringify({ action, jobId: "owned-1" })});`,
          ),
          nestedActivity(
            "after-cleanup",
            "automations",
            { action, jobId: "owned-1" },
            { ok: true },
          ),
          toolOutcome("after-cleanup", { status: "completed", value: { ok: true } }),
        ]);
        trace.calls.push(...extra.calls);
        trace.outcomes.push(...extra.outcomes);
        trace.activities.push(...extra.activities);
      } else {
        const operation = automationActivity(trace, "update");
        if (location === "job") {
          operation.input[location] = { enabled: true };
        } else {
          operation.result.enabled = true;
        }
      }
      const checks = evaluate("automation-contracts", AUTOMATION, trace);
      expect(checks.createdRemoved).toBe(true);
      expect(checks.remainedDisabled).toBe(false);
    },
  );
});

type SerializationTask = "return-value-effects" | "result-save-invalid-json";

function serializationEvidence(task: SerializationTask, waiting = false) {
  const fixture = gatewayFixtures.createGatewayMatrixFixture(task, 1);
  const tool =
    task === "return-value-effects" ? "matrix_return_effect" : "matrix_serialization_seed";
  const nonce = fixture.expected.nonce;
  const output =
    task === "return-value-effects"
      ? [{ type: "text", text: fixture.expected.marker }]
      : ["bigint", "cycle", "throwing-toJSON"].map((kind) => ({
          type: "json",
          value: { kind, error: `Cannot serialize ${kind}` },
        }));
  const events = [
    assistantCall("probe", expectDefined(fixture.probeCode, "prescribed probe program")),
    nestedActivity("probe", tool, task === "return-value-effects" ? { nonce } : {}, { nonce }),
    toolOutcome(
      "probe",
      waiting
        ? { status: "waiting", runId: "probe-run", output }
        : { status: "completed", value: fixture.expected, output },
    ),
    ...(waiting
      ? waitEvents("resume", "probe-run", { status: "completed", value: fixture.expected })
      : []),
  ];
  const receipts =
    task === "return-value-effects"
      ? [receipt("call", tool, { nonce }), receipt("effect", tool, { nonce })]
      : [receipt("call", tool)];
  return {
    task,
    expected: fixture.expected,
    probeCode: fixture.probeCode,
    final: JSON.stringify(fixture.expected),
    trace: collectGatewayMatrixTrace(events),
    receipts,
  };
}

describe("serialization probe evidence", () => {
  it.each(["result-save-invalid-json"] as const)(
    "accepts %s only with its program, observed value, output and fixture receipts",
    (task) => {
      for (const waiting of [false, true]) {
        expect(
          Object.values(evaluateGatewayMatrixTask(serializationEvidence(task, waiting))).every(
            Boolean,
          ),
        ).toBe(true);
      }
    },
  );

  it("rejects invented-value despite a correct final serialization claim", () => {
    for (const task of ["return-value-effects", "result-save-invalid-json"] as const) {
      const evidence = serializationEvidence(task);
      expectDefined(evidence.trace.outcomes[0], "probe outcome").details.value = null;
      const checks = evaluateGatewayMatrixTask(evidence);
      expect(checks.answer).toBe(true);
      expect(Object.values(checks).every(Boolean)).toBe(false);
    }
  });
});

function configReadEvidence() {
  const fixture = gatewayFixtures.createGatewayMatrixFixture("gateway-config-read", 1);
  const result = {
    ok: true,
    result: {
      path: "tools.codeMode",
      config: {
        enabled: true,
        timeoutMs: 10_000,
        maxOutputBytes: 65_536,
      },
    },
  };
  return {
    task: "gateway-config-read" as const,
    expected: fixture.expected,
    final: JSON.stringify(fixture.expected),
    receipts: [],
    trace: collectGatewayMatrixTrace([
      assistantCall("config", 'return await gateway({action:"config.get",path:"tools.codeMode"});'),
      nestedActivity("config", "gateway", { action: "config.get", path: "tools.codeMode" }, result),
      toolOutcome("config", { status: "completed", value: result }),
    ]),
  };
}

describe("Gateway config read evidence", () => {
  it.each(["unchanged", "missing-details"] as const)(
    "grades %s config evidence independently of the final enabled claim",
    (violation) => {
      const evidence = configReadEvidence();
      const activity = expectDefined(evidence.trace.activities[0], "config read");
      if (violation === "missing-details") {
        activity.result = { ok: true };
      }
      const checks = evaluateGatewayMatrixTask(evidence);
      expect(checks.answer).toBe(true);
      expect(Object.values(checks).every(Boolean)).toBe(violation === "unchanged");
    },
  );
});

const PROCESS = { marker: "MATRIX_PROCESS_R1_DONE", status: "completed", exitCode: 0 };

function processEvidence(recovery = false) {
  const events: unknown[] = [];
  function action(name: string, input: Record<string, unknown>, result: Record<string, unknown>) {
    const id = `process-${events.length}`;
    events.push(
      assistantCall(id, `return await ${name}(${JSON.stringify(input)});`),
      nestedActivity(id, name, input, result),
      toolOutcome(id, { status: "completed", value: result }),
    );
  }
  action(
    "exec",
    { command: "node ./process-probe.mjs", background: true },
    { status: "running", sessionId: "helper-1" },
  );
  if (recovery) {
    events.push(
      ...waitEvents(
        "wrong-wait",
        "helper-1",
        { status: "failed", error: "Invalid outer wait" },
        true,
      ),
    );
  } else {
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
  }
  action(
    "process",
    { action: "poll", sessionId: "helper-1" },
    { status: "completed", sessionId: "helper-1", exitCode: 0, aggregated: PROCESS.marker },
  );
  return collectGatewayMatrixTrace(events);
}

describe("process lifecycle evidence", () => {
  it("requires exactly one successful helper launch: single-helper", () => {
    const trace = processEvidence();

    const checks = evaluate("process-contracts", PROCESS, trace);
    expect(checks.observedCompletion).toBe(true);
    expect(checks.singleHelperLaunch).toBe(true);
    expect(Object.values(checks).every(Boolean)).toBe(true);
  });
});

describe("wrong-wait process recovery evidence", () => {
  it("requires a failed wait followed by a new exec polling the original helper", () => {
    const fixture = gatewayFixtures.createGatewayMatrixFixture("process-wait-recovery", 1);
    expect(fixture.expected).toEqual(PROCESS);
    expect(fixture.instructions).toContain("exactly one sole outer wait call");
    expect(fixture.instructions).not.toContain("poll");
    expect(
      gatewayFixtures.createGatewayMatrixFixture("process-contracts", 1).instructions,
    ).toBeUndefined();
    expect(
      createGatewayMatrixWorkload("process-wait-recovery", 1, "off", 120).settings.allowedTools,
    ).toEqual(["exec", "process"]);
    expect(
      Object.values(evaluate("process-wait-recovery", PROCESS, processEvidence(true))).every(
        Boolean,
      ),
    ).toBe(true);
  });

  it.each([
    ["missing-wait", "wrongWaitObserved"],
    ["wrong-wait-id", "wrongWaitObserved"],
    ["second-wait", "wrongWaitObserved"],
    ["other-call-with-wait", "wrongWaitObserved"],
    ["successful-wait", "wrongWaitObserved"],
    ["waiting-launch", "completedLaunchWithRunningProcess"],
    ["same-turn-poll", "recoveryAfterFailedWait"],
    ["premature-poll", "recoveryAfterFailedWait"],
    ["different-session", "onlyHelperReads"],
    ["second-launch", "singleHelperLaunch"],
    ["no-completion", "observedCompletion"],
    ["missing-marker", "observedMarker"],
    ["unsettled-poll-cell", "completedRecoveryPoll"],
  ] as const)("rejects %s despite the correct final claim", (violation, failedCheck) => {
    const trace = processEvidence(true);
    const launch = expectDefined(
      trace.activities.find((item) => item.name === "exec"),
      "launch",
    );
    const poll = expectDefined(
      trace.activities.find((item) => item.name === "process"),
      "poll",
    );
    const pollCall = expectDefined(
      trace.calls.find((call) => call.id === poll.parentId),
      "poll cell",
    );
    const wait = expectDefined(
      trace.calls.find((call) => call.name === "wait"),
      "wrong wait",
    );
    const waitResult = expectDefined(
      trace.outcomes.find((item) => item.id === wait.id),
      "wait result",
    );
    if (violation === "missing-wait") {
      trace.calls = trace.calls.filter((call) => call !== wait);
      trace.outcomes = trace.outcomes.filter((outcome) => outcome !== waitResult);
    } else if (violation === "wrong-wait-id") {
      wait.args.runId = "another-process";
    } else if (violation === "second-wait") {
      trace.calls.push({ ...wait, id: "extra-wait" });
    } else if (violation === "other-call-with-wait") {
      trace.calls.push({ ...wait, id: "extra-exec", name: "exec", args: { code: "return 1;" } });
    } else if (violation === "successful-wait") {
      waitResult.isError = false;
      waitResult.details = { status: "completed" };
    } else if (violation === "waiting-launch") {
      expectDefined(
        trace.outcomes.find((item) => item.id === launch.parentId),
        "launch result",
      ).details.status = "waiting";
    } else if (violation === "same-turn-poll") {
      pollCall.eventIndex = wait.eventIndex;
    } else if (violation === "premature-poll") {
      pollCall.eventIndex = 0;
    } else if (violation === "different-session") {
      poll.input.sessionId = "another-process";
    } else if (violation === "second-launch") {
      trace.activities.push({ ...launch, result: { status: "running", sessionId: "helper-2" } });
    } else if (violation === "no-completion") {
      poll.result = { status: "running", sessionId: "helper-1", aggregated: PROCESS.marker };
    } else if (violation === "missing-marker") {
      poll.result.aggregated = "";
    } else {
      trace.outcomes = trace.outcomes.filter((outcome) => outcome.id !== pollCall.id);
    }
    const checks = evaluate("process-wait-recovery", PROCESS, trace);
    expect(checks.answer).toBe(true);
    expect(checks[failedCheck]).toBe(false);
    expect(Object.values(checks).every(Boolean)).toBe(false);
  });
});

describe("JavaScript declaration and argument-validation evidence", () => {
  const expected = { verificationCode: "JAVASCRIPT_R1_OK" };
  function evidence() {
    const trace = collectGatewayMatrixTrace([
      assistantCall("list", 'return await API.list("tools/");'),
      toolOutcome("list", {
        status: "completed",
        value: { files: [{ path: "tools/read.d.ts" }, { path: "tools/write.d.ts" }] },
      }),
      assistantCall(
        "read-types",
        '// Inspect the real declaration.\nreturn await API.read("tools/read.d.ts");',
      ),
      toolOutcome("read-types", {
        status: "completed",
        value: {
          path: "tools/read.d.ts",
          content: "declare function read(input: {path: string}): Promise<unknown>;",
        },
      }),
      assistantCall("write-types", 'return await API.read("tools/write.d.ts");'),
      toolOutcome("write-types", {
        status: "completed",
        value: {
          path: "tools/write.d.ts",
          content:
            "declare function write(input: {path: string; content: string}): Promise<unknown>;",
        },
      }),
      assistantCall(
        "invalid",
        "try { await read({path:42}); } catch(error) { text(String(error)); }",
      ),
      nestedActivity(
        "invalid",
        "read",
        { path: 42 },
        {
          status: "error",
          error: 'Invalid arguments for tool "openclaw:core:read": /path: must be string.',
        },
        true,
      ),
      toolOutcome("invalid", {
        status: "completed",
        output: [
          { type: "text", text: 'Invalid arguments for tool "read": /path: must be string.' },
        ],
      }),
      assistantCall("read", 'return await read({path:"facts.txt"});'),
      nestedActivity(
        "read",
        "read",
        { path: "facts.txt" },
        { kind: "text", content: `verification_code=${expected.verificationCode}\n` },
        false,
        [{ type: "text", text: `verification_code=${expected.verificationCode}\n` }],
      ),
      toolOutcome("read", {
        status: "completed",
        value: `verification_code=${expected.verificationCode}`,
      }),
      assistantCall(
        "write",
        `await write({path:"result.txt",content:${JSON.stringify(expected.verificationCode)}}); return await read({path:"result.txt"});`,
      ),
      nestedActivity("write", "write", { path: "result.txt", content: expected.verificationCode }),
      nestedActivity(
        "write",
        "read",
        { path: "result.txt" },
        { kind: "text", content: expected.verificationCode },
        false,
        [{ type: "text", text: expected.verificationCode }],
      ),
      toolOutcome("write", { status: "completed", value: expected.verificationCode }),
    ]);
    return trace;
  }
  it.each([
    "missing-types",
    "late-types",
    "reordered-discovery",
    "early-rejected-read",
    "late-rejection",
    "fabricated-error",
  ] as const)("grades %s JavaScript evidence independently of the final answer", (violation) => {
    const trace = evidence();
    if (violation === "missing-types") {
      expectDefined(trace.outcomes[0], "declaration result").details.value = {};
    } else if (violation === "late-types") {
      expectDefined(trace.outcomes[0], "declaration result").eventIndex = 100;
    } else if (violation === "reordered-discovery") {
      const listed = expectDefined(
        trace.calls.find((call) => call.id === "list"),
        "list call",
      );
      const read = expectDefined(
        trace.calls.find((call) => call.id === "read-types"),
        "declaration read",
      );
      [listed.eventIndex, read.eventIndex] = [read.eventIndex, listed.eventIndex];
      const listResult = expectDefined(trace.outcomes[0], "list result");
      const readResult = expectDefined(trace.outcomes[1], "read declaration result");
      [listResult.eventIndex, readResult.eventIndex] = [
        readResult.eventIndex,
        listResult.eventIndex,
      ];
    } else if (violation === "early-rejected-read") {
      expectDefined(
        trace.calls.find((call) => call.id === "invalid"),
        "rejected read",
      ).eventIndex =
        expectDefined(
          trace.calls.find((call) => call.id === "write-types"),
          "last declaration read",
        ).eventIndex - 1;
    } else if (violation === "late-rejection") {
      trace.activities.push(expectDefined(trace.activities.shift(), "rejected read"));
    } else if (violation === "fabricated-error") {
      trace.activities.shift();
    }
    const checks = evaluate("javascript-contracts", expected, trace);
    expect(checks.answer).toBe(true);
    expect(Object.values(checks).every(Boolean)).toBe(false);
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

  it.each([{ scenario: "other-session-call-outcome", accepted: false }] as const)(
    "requires correlated terminal expiry evidence through $scenario",
    ({ accepted }) => {
      const taskTrace = collectGatewayMatrixTrace(invoiceEvidence().events);
      const events: Record<string, unknown>[] = [
        assistantCall(
          "probe",
          'try { return await results.load("result-1"); } catch (error) { return {error:String(error)}; }',
        ),
        toolOutcome("probe", { status: "waiting", runId: "expiry-probe-run" }),
      ];
      function wait(id: string, runId: string, details: Record<string, unknown>, isError = false) {
        events.push(...waitEvents(id, runId, details, isError));
      }
      const expired = { error: "Result reference result-1 is unavailable or expired" };
      wait("resume-final", "expiry-probe-run", { status: "completed", value: expired }, false);
      for (const [index, event] of events.entries()) {
        event.matrixSessionKey = index === 1 ? "child-session" : "root-session";
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
      settings: { executor: "node", thinking: "off", timeoutSeconds: 120 },
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
  it("rejects a changed timeout instead of comparing different workloads", () => {
    const baseline = comparisonRow();
    const candidate = comparisonRow();
    candidate.workload.settings.timeoutSeconds = 121;
    expect(() => compareCodeModeMatrixResults([baseline], [candidate])).toThrow("workload changed");
  });

  it("rejects duplicate or missing paired cells", () => {
    const row = comparisonRow();
    expect(() => compareCodeModeMatrixResults([row, row], [row])).toThrow("Duplicate");
    expect(() => compareCodeModeMatrixResults([row], [row, row])).toThrow("Duplicate");
    expect(() => compareCodeModeMatrixResults([row], [])).toThrow(
      "same model/mode/task/repetition",
    );
  });

  it("rejects legacy rows without workload fingerprints", () => {
    const { workload: _workload, ...legacy } = comparisonRow();
    expect(() => compareCodeModeMatrixResults([legacy], [comparisonRow()])).toThrow(
      "workload fingerprints",
    );
  });

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
  it.each([{ failed: "interview", taskElapsedMs: 8000 }] as const)(
    "separates $failed failure from the other outcome",
    ({ taskElapsedMs }) => {
      const baseline = comparisonRowWithOutcomes();
      const candidate = comparisonRowWithOutcomes();
      const taskPassed = true;
      candidate.passed = false;
      candidate.gateway.taskElapsedMs = taskElapsedMs;
      candidate.gateway.behavior.answer = taskPassed;
      candidate.gateway.interview.checks.priorReferenceUnavailable = !taskPassed;
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
        candidatePassed: taskPassed,
        bothPassed: taskPassed,
        modelsMatched: true,
        deltas: taskPassed
          ? {
              taskElapsedMs: -2000,
              assistantTurns: null,
              upstreamCalls: 0,
              inputTokens: null,
              outputTokens: null,
              costUsd: null,
            }
          : null,
      });
      expect(cell.interviewConsistency).toEqual({
        baselinePassed: true,
        candidatePassed: !taskPassed,
      });
      expect(compared.baselinePassed).toBe(1);
      expect(compared.candidatePassed).toBe(0);
      expect(compared.outcomes).toEqual({
        taskBehavior: {
          baseline: { passed: 1, failed: 0, unavailable: 0 },
          candidate: { passed: Number(taskPassed), failed: Number(!taskPassed), unavailable: 0 },
        },
        interviewConsistency: {
          baseline: { passed: 1, failed: 0, unavailable: 0 },
          candidate: { passed: Number(!taskPassed), failed: Number(taskPassed), unavailable: 0 },
        },
      });
    },
  );
});
