import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { compareCodeModeMatrixResults } from "../../scripts/lib/code-mode-matrix-comparison.js";
import * as gatewayFixtures from "../../scripts/lib/code-mode-matrix-gateway-fixtures.js";
import {
  collectGatewayMatrixTrace,
  createGatewayMatrixWorkload,
  evaluateGatewayMatrixActivation,
  evaluateGatewayMatrixInterview,
  evaluateGatewayMatrixTask,
  parseGatewayMatrixActivationDiagnostic,
  requireGatewayMatrixTools,
  type GatewayMatrixTrace,
} from "../../scripts/lib/code-mode-matrix-gateway.js";

function activationDiagnostic(overrides: Record<string, unknown> = {}) {
  return expectDefined(
    parseGatewayMatrixActivationDiagnostic(
      `code-mode diagnostic ${JSON.stringify({
        boundary: "activation",
        runId: "root-run",
        active: true,
        toolsEnabled: true,
        toolsDisabled: false,
        rawRun: false,
        fallbackActive: false,
        modelProvider: "anthropic",
        modelId: "fixture-model",
        modelCodeMode: "preferred",
        ...overrides,
      })}`,
    ),
    "activation diagnostic",
  );
}

it.each([
  ["preferred", true, true],
  ["preferred", false, false],
  ["capable", false, true],
  ["capable", true, false],
  [null, false, true],
  [null, true, false],
] as const)(
  "checks Gateway auto against selected tier %s, active=%s",
  (tier, active, engagement) => {
    expect(
      evaluateGatewayMatrixActivation({
        diagnostics: [activationDiagnostic({ modelCodeMode: tier, active })],
        rootRunId: "root-run",
        childRunIds: [],
        expectedEnabled: "auto",
        expectedModel: "anthropic/fixture-model",
      }),
    ).toMatchObject({ activationComplete: true, engagement, actualCodeMode: active });
  },
);

it.each([
  ["preferred", "preferred", true, true],
  ["preferred", null, false, false],
  ["preferred", "capable", false, false],
  ["preferred", "preferred", false, false],
  ["capable", "capable", false, true],
  ["unflagged", null, false, true],
] as const)(
  "binds independent auto expectation %s to observed tier %s, active=%s",
  (expectedAutoTier, tier, active, engagement) => {
    expect(
      evaluateGatewayMatrixActivation({
        diagnostics: [activationDiagnostic({ modelCodeMode: tier, active })],
        rootRunId: "root-run",
        childRunIds: [],
        expectedEnabled: "auto",
        expectedModel: "anthropic/fixture-model",
        expectedAutoTier,
      }),
    ).toMatchObject({ activationComplete: true, engagement, actualCodeMode: active });
  },
);

it.each([
  { modelCodeMode: undefined },
  { modelCodeMode: "unknown" },
  { modelProvider: undefined },
  { modelId: undefined },
  { modelId: "different-model" },
  { fallbackActive: true },
  { toolsEnabled: false },
  { toolsDisabled: true },
  { rawRun: true },
])("withholds Gateway default proof for incomplete or ineligible activation: %j", (overrides) => {
  expect(
    evaluateGatewayMatrixActivation({
      diagnostics: [activationDiagnostic(overrides)],
      rootRunId: "root-run",
      childRunIds: [],
      expectedEnabled: "auto",
      expectedModel: "anthropic/fixture-model",
    }),
  ).toMatchObject({ activationComplete: false, engagement: false });
});

it.each([false, true])(
  "preserves explicit Gateway activation=%s without catalog metadata",
  (active) => {
    expect(
      evaluateGatewayMatrixActivation({
        diagnostics: [
          activationDiagnostic({
            active,
            modelProvider: undefined,
            modelId: undefined,
            modelCodeMode: undefined,
          }),
        ],
        rootRunId: "root-run",
        childRunIds: [],
        expectedEnabled: active,
      }),
    ).toMatchObject({ activationComplete: true, engagement: true, actualCodeMode: active });
  },
);

function evaluate(
  task: Parameters<typeof evaluateGatewayMatrixTask>[0]["task"],
  expected: Record<string, unknown>,
  trace: GatewayMatrixTrace,
  receipts: readonly unknown[] = [],
) {
  const final = JSON.stringify(expected);
  return evaluateGatewayMatrixTask({ task, expected, final, trace, receipts });
}

function message<T extends object>(role: string, fields: T) {
  return { type: "message", message: { role, ...fields } };
}

function callEvent(id: string, name: string, args: Record<string, unknown>) {
  const content = [{ type: "toolCall", id, name, arguments: args }];
  return message("assistant", { provider: "openai", model: "gpt-5.6-sol", content });
}

function assistantCall(id: string, code: string) {
  return callEvent(id, "exec", { code });
}

function usageEvent(id: string, usage: Record<string, unknown>, code = "return 1;") {
  return { message: { ...assistantCall(id, code).message, usage } };
}

function toolOutcome(id: string, details: Record<string, unknown>, isError = false, name = "exec") {
  const content = [{ type: "text", text: JSON.stringify(details) }];
  return message("toolResult", { toolCallId: id, toolName: name, isError, details, content });
}

function waitEvents(id: string, runId: string, details: Record<string, unknown>, isError = false) {
  return [callEvent(id, "wait", { runId }), toolOutcome(id, details, isError, "wait")];
}

function nestedActivity(
  parentToolCallId: string,
  toolName: string,
  input: Record<string, unknown> = {},
  value: Record<string, unknown> = {},
  isError = false,
  content: { type: "text"; text: string }[] = [],
) {
  const result = { content, details: value };
  const details = { parentToolCallId, toolName, input, result, isError };
  return { customType: "openclaw.nested-tool.v1", details };
}

function textRead(id: string, path: string, text: string) {
  return nestedActivity(id, "read", { path }, { kind: "text", content: text }, false, [
    { type: "text", text },
  ]);
}

function receipt(kind: "call" | "effect", tool: string, facts: Record<string, unknown> = {}) {
  return { kind, tool, ...facts };
}

function activityEvents(
  id: string,
  name: string,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
) {
  return [
    assistantCall(id, `return await ${name}(${JSON.stringify(input)});`),
    nestedActivity(id, name, input, result),
    completed(id, result),
  ];
}

function completedEvents(id: string, code: string, value: unknown) {
  return [assistantCall(id, code), completed(id, value)];
}

function completed(id: string, value: unknown) {
  return toolOutcome(id, { status: "completed", value });
}

function allChecks(checks: Record<string, boolean>, accepted = true) {
  expect(Object.values(checks).every(Boolean)).toBe(accepted);
}

function traceCall(trace: GatewayMatrixTrace, id: string) {
  const call = trace.calls.find((item) => item.id === id);
  return expectDefined(call, id);
}

function traceOutcome(trace: GatewayMatrixTrace, id: string) {
  const outcome = trace.outcomes.find((item) => item.id === id);
  return expectDefined(outcome, id);
}

function recoveryEvidence() {
  const trace = processEvidence(true);
  const activity = (name: string) =>
    expectDefined(
      trace.activities.find((item) => item.name === name),
      name,
    );
  const launch = activity("exec");
  const poll = activity("process");
  const wait = traceCall(trace, "wrong-wait");
  return {
    trace,
    launch,
    poll,
    wait,
    pollCall: traceCall(trace, expectDefined(poll.parentId, "poll parent")),
    waitResult: traceOutcome(trace, wait.id),
    launchResult: traceOutcome(trace, expectDefined(launch.parentId, "launch parent")),
  };
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
      ...activityEvents("inspect", "matrix_settlement_inspect", input, SETTLEMENT),
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
const OBSERVED_USAGE = { input: 100, output: 10, totalTokens: 110, cost: { total: 0.002 } };

function invoiceEvidence() {
  const reference = {
    id: "result-1",
    bytes: 131072,
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
      completed("aggregate", INVOICES),
    ],
    receipts: [receipt("call", "matrix_invoice_export")],
  };
}

it("counts one underlying shell outcome through direct exec with error=true", () => {
  const input = { command: "node ./process-probe.mjs" };
  const result = { status: "failed", exitCode: 1, aggregated: "synthetic process failure" };
  const trace = collectGatewayMatrixTrace([
    message("assistant", {
      content: [{ type: "toolCall", id: "invoke", name: "exec", arguments: input }],
    }),
    toolOutcome("invoke", result, true),
  ]);
  expect(trace.activities).toEqual([
    expect.objectContaining({ name: "exec", input, result, isError: true, eventIndex: 1 }),
  ]);
  expect(trace.activities[0]?.parentId).toBeUndefined();
  expect(trace.calls.map((call) => call.name)).toEqual(["exec"]);
  expect(trace.outcomes.map((outcome) => outcome.name)).toEqual(["exec"]);
});

it("does not turn missing usage or cost observations into zero-valued measurements", () => {
  const withUsage = usageEvent("one", OBSERVED_USAGE);
  const complete = collectGatewayMatrixTrace([withUsage]);
  expect(complete.usage).toEqual({ input: 100, output: 10, total: 110 });
  expect(complete.costUsd).toBe(0.002);
  const incomplete = collectGatewayMatrixTrace([withUsage, assistantCall("two", "return 2;")]);
  expect(incomplete.usage).toBeUndefined();
  expect(incomplete.costUsd).toBeUndefined();
});

it.each([
  { label: "zero placeholders", input: 0, output: 0, known: "none" },
  { label: "provisional counters", input: 20, output: 3, known: "none" },
  { label: "known then unavailable", input: 20, output: 3, known: "before" },
  { label: "unavailable then known", input: 20, output: 3, known: "after" },
])("does not qualify $label as measured savings", ({ input, output, known }) => {
  const unavailable = usageEvent(
    "unavailable",
    {
      input,
      output,
      totalTokens: input + output,
      cost: { total: 0.5 },
      usageReport: { state: "unavailable" },
    },
    "return await matrix_read({});",
  );
  const observed = usageEvent("observed", {
    ...OBSERVED_USAGE,
    usageReport: { state: "available" },
  });
  const trace = collectGatewayMatrixTrace([
    ...(known === "before" ? [observed] : []),
    unavailable,
    nestedActivity("unavailable", "matrix_read", {}, { value: 1 }),
    completed("unavailable", 1),
    ...(known === "after" ? [observed] : []),
  ]);
  expect(trace).toMatchObject({
    assistantTurns: known === "none" ? 1 : 2,
    models: ["openai/gpt-5.6-sol"],
  });
  expect(trace.usage).toBeUndefined();
  expect(trace.costUsd).toBeUndefined();
  expect(trace.calls).toHaveLength(known === "none" ? 1 : 2);
  expect(trace.outcomes).toHaveLength(1);
  expect(trace.activities).toHaveLength(1);
  expect(trace.activities[0]).toMatchObject({ name: "matrix_read", result: { value: 1 } });

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
    usageEvent(
      "zero",
      {
        input: 0,
        output: 0,
        totalTokens: 0,
        cost: { total: 0, totalOrigin: "provider-billed" },
        usageReport: { state: "available" },
      },
      "return 0;",
    ),
  ]);
  expect(trace.usage).toEqual({ input: 0, output: 0, total: 0 });
  expect(trace.costUsd).toBe(0);
  expect(trace.assistantTurns).toBe(1);
});

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

it.each([
  ["multiple-waits", 2],
  ["unrelated-run", 1],
] as const)("requires correlated settlement diagnostics through %s", (scenario, waits) => {
  const { events: initialEvents, receipts } = settlementEvidence();
  const events: unknown[] = initialEvents;
  events[0] = assistantCall(
    "settle",
    'try { return await matrix_settle({operationId:"matrix-settlement-1"}); } catch (error) { return {error:String(error)}; }',
  );
  const diagnostic = {
    status: "completed",
    value: { error: "Output contract: receipt must be a string; totalCents is required" },
  };
  const waiting = { status: "waiting", runId: "settlement-run" };
  events[2] = toolOutcome("settle", waiting);
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
  const checks = evaluate(
    "partial-failure",
    SETTLEMENT,
    collectGatewayMatrixTrace(events),
    receipts,
  );
  const accepted = scenario !== "unrelated-run";
  expect(checks).toMatchObject({
    answer: true,
    exactlyOneEffect: true,
    inspectedAfterFailure: true,
    observedPersistedState: true,
    actionableDiagnostics: accepted,
  });
  allChecks(checks, accepted);
});

it("grades retained retention while preserving the correct-answer observation", () => {
  const { events, receipts } = invoiceEvidence();
  const trace = collectGatewayMatrixTrace(events);

  const checks = evaluate("invoices-auto-retention", INVOICES, trace, receipts);
  allChecks(checks);
});

const AUTOMATION = {
  jobName: "matrix-contracts-r1",
  updatedName: "matrix-contracts-r1-updated",
  payloadText: "Synthetic disabled automation 1",
  remainingOwnedJobs: 0,
};

function automationEvidence(terminal: "complete" | "partial") {
  const baselineJob = { id: "system-heartbeat", enabled: false };
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
    events.push(...activityEvents(id, "automations", input, result));
  }
  action({ action: "status" }, { enabled: false, jobs: 1 });
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
  action(
    { action: "list", includeDisabled: true },
    { ...inventory, hasMore: terminal === "partial" },
  );
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

function moveActivity(
  trace: GatewayMatrixTrace,
  item: GatewayMatrixTrace["activities"][number],
  anchor: GatewayMatrixTrace["activities"][number],
  after = false,
) {
  const activities = trace.activities;
  activities.splice(activities.indexOf(item), 1);
  activities.splice(activities.indexOf(anchor) + Number(after), 0, item);
}

it.each(["early-history", "history-before-read", "id-alias"] as const)(
  "accepts the %s lifecycle with complete inventories and preserved baseline jobs",
  (variant) => {
    const trace = automationEvidence("complete");
    if (variant === "id-alias") {
      for (const activity of trace.activities) {
        if (typeof activity.input.jobId === "string") {
          activity.input.id = activity.input.jobId;
          delete activity.input.jobId;
          traceCall(trace, expectDefined(activity.parentId, "activity parent")).args.code =
            `return await automations(${JSON.stringify(activity.input)});`;
        }
      }
    } else {
      const history = automationActivity(trace, "runs");
      const anchor =
        variant === "early-history"
          ? automationActivity(trace, "add")
          : automationActivity(trace, "get", AUTOMATION.updatedName);
      moveActivity(trace, history, anchor, variant === "early-history");
    }
    allChecks(evaluate("automation-contracts", AUTOMATION, trace));
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
    moveActivity(trace, status, automationActivity(trace, "add"), true);
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
  expect(checks).toMatchObject({
    answer: true,
    createdFacts: true,
    baselinePreserved: true,
    terminalInventoryComplete: true,
    createdRemoved: true,
  });
  allChecks(checks, false);
});

it("rejects a recurring job even when its name and final cleanup match", () => {
  const trace = automationEvidence("complete");
  const created = automationActivity(trace, "add");
  created.result.schedule = { kind: "every", everyMs: 86400000 };
  const checks = evaluate("automation-contracts", AUTOMATION, trace);
  expect(checks).toMatchObject({ answer: true, createdRemoved: true, createdFacts: false });
});

it("rejects partial inventories as proof of clean, isolated removal", () => {
  expect(evaluate("automation-contracts", AUTOMATION, automationEvidence("partial"))).toMatchObject(
    {
      answer: true,
      terminalInventoryComplete: false,
      createdRemoved: false,
      baselinePreserved: false,
    },
  );
});

it.each(["job", "wake"] as const)(
  "rejects an enabled job through the %s even after successful cleanup",
  (location) => {
    const trace = automationEvidence("complete");
    if (location === "wake") {
      const extra = collectGatewayMatrixTrace([
        ...activityEvents(
          "after-cleanup",
          "automations",
          { action: location, jobId: "owned-1" },
          { ok: true },
        ),
      ]);
      trace.calls.push(...extra.calls);
      trace.outcomes.push(...extra.outcomes);
      trace.activities.push(...extra.activities);
    } else {
      const operation = automationActivity(trace, "update");
      operation.input.job = { enabled: true };
    }
    const checks = evaluate("automation-contracts", AUTOMATION, trace);
    expect(checks).toMatchObject({ createdRemoved: true, remainedDisabled: false });
  },
);

type SerializationTask = "return-value-effects" | "result-save-invalid-json";

function serializationEvidence(task: SerializationTask, waiting = false) {
  const { expected, probeCode } = gatewayFixtures.createGatewayMatrixFixture(task, 1);
  const returnEffects = task === "return-value-effects";
  const tool = returnEffects ? "matrix_return_effect" : "matrix_serialization_seed";
  const nonce = expected.nonce;
  const output = returnEffects
    ? [{ type: "text", text: expected.marker }]
    : ["bigint", "cycle", "throwing-toJSON"].map((kind) => ({
        type: "json",
        value: { kind, error: `Cannot serialize ${kind}` },
      }));
  const events = [
    assistantCall("probe", expectDefined(probeCode, "prescribed probe program")),
    nestedActivity("probe", tool, returnEffects ? { nonce } : {}, { nonce }),
    toolOutcome(
      "probe",
      waiting
        ? { status: "waiting", runId: "probe-run", output }
        : { status: "completed", value: expected, output },
    ),
    ...(waiting ? waitEvents("resume", "probe-run", { status: "completed", value: expected }) : []),
  ];
  const receipts = returnEffects
    ? [receipt("call", tool, { nonce }), receipt("effect", tool, { nonce })]
    : [receipt("call", tool)];
  return {
    task,
    expected,
    probeCode,
    final: JSON.stringify(expected),
    trace: collectGatewayMatrixTrace(events),
    receipts,
  };
}

it("accepts result-save-invalid-json only with its program, observed value, output and fixture receipts", () => {
  for (const waiting of [false, true]) {
    allChecks(
      evaluateGatewayMatrixTask(serializationEvidence("result-save-invalid-json", waiting)),
    );
  }
});

it("rejects invented-value despite a correct final serialization claim", () => {
  for (const task of ["return-value-effects", "result-save-invalid-json"] as const) {
    const evidence = serializationEvidence(task);
    expectDefined(evidence.trace.outcomes[0], "probe outcome").details.value = null;
    const checks = evaluateGatewayMatrixTask(evidence);
    expect(checks.answer).toBe(true);
    allChecks(checks, false);
  }
});

function configReadEvidence() {
  const { expected } = gatewayFixtures.createGatewayMatrixFixture("gateway-config-read", 1);
  const input = { action: "config.get", path: "tools.codeMode" };
  const config = { enabled: true, timeoutMs: 10_000, maxOutputBytes: 65_536 };
  const result = { ok: true, result: { path: input.path, config } };
  return {
    task: "gateway-config-read" as const,
    expected,
    final: JSON.stringify(expected),
    receipts: [],
    trace: collectGatewayMatrixTrace(activityEvents("config", "gateway", input, result)),
  };
}

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
    allChecks(checks, violation === "unchanged");
  },
);

const PROCESS = { marker: "MATRIX_PROCESS_R1_DONE", status: "completed", exitCode: 0 };

function processEvidence(recovery = false) {
  const events: unknown[] = [];
  function action(name: string, input: Record<string, unknown>, result: Record<string, unknown>) {
    const id = `process-${events.length}`;
    events.push(...activityEvents(id, name, input, result));
  }
  action(
    "exec",
    { command: "node ./process-probe.mjs", background: true },
    { status: "running", sessionId: "helper-1" },
  );
  if (recovery) {
    const failed = { status: "failed", error: "Invalid outer wait" };
    events.push(...waitEvents("wrong-wait", "helper-1", failed, true));
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

it("requires exactly one successful helper launch: single-helper", () => {
  const trace = processEvidence();

  const checks = evaluate("process-contracts", PROCESS, trace);
  expect(checks).toMatchObject({ observedCompletion: true, singleHelperLaunch: true });
  allChecks(checks);
});

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
  allChecks(evaluate("process-wait-recovery", PROCESS, processEvidence(true)));
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
  const { trace, launch, poll, pollCall, wait, waitResult, launchResult } = recoveryEvidence();
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
    launchResult.details.status = "waiting";
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
  expect(checks).toMatchObject({ answer: true, [failedCheck]: false });
  allChecks(checks, false);
});

const expected = { verificationCode: "JAVASCRIPT_R1_OK" };
function javascriptEvidence() {
  return collectGatewayMatrixTrace([
    ...completedEvents("list", 'return await API.list("tools/");', {
      files: [{ path: "tools/read.d.ts" }, { path: "tools/write.d.ts" }],
    }),
    ...completedEvents(
      "read-types",
      '// Inspect the real declaration.\nreturn await API.read("tools/read.d.ts");',
      {
        content: "declare function read(input: {path: string}): Promise<unknown>;",
      },
    ),
    ...completedEvents("write-types", 'return await API.read("tools/write.d.ts");', {
      content: "declare function write(input: {path: string; content: string}): Promise<unknown>;",
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
        error: 'Invalid arguments for tool "openclaw:core:read": /path: must be string.',
      },
      true,
    ),
    toolOutcome("invalid", {
      status: "completed",
      output: [{ type: "text", text: 'Invalid arguments for tool "read": /path: must be string.' }],
    }),
    assistantCall("read", 'return await read({path:"facts.txt"});'),
    textRead("read", "facts.txt", `verification_code=${expected.verificationCode}\n`),
    completed("read", `verification_code=${expected.verificationCode}`),
    assistantCall(
      "write",
      `await write({path:"result.txt",content:${JSON.stringify(expected.verificationCode)}}); return await read({path:"result.txt"});`,
    ),
    nestedActivity("write", "write", { path: "result.txt", content: expected.verificationCode }),
    textRead("write", "result.txt", expected.verificationCode),
    completed("write", expected.verificationCode),
  ]);
}
it.each([
  "missing-types",
  "late-types",
  "reordered-discovery",
  "early-rejected-read",
  "late-rejection",
  "fabricated-error",
] as const)("grades %s JavaScript evidence independently of the final answer", (violation) => {
  const trace = javascriptEvidence();
  if (violation === "missing-types") {
    expectDefined(trace.outcomes[0], "declaration result").details.value = {};
  } else if (violation === "late-types") {
    expectDefined(trace.outcomes[0], "declaration result").eventIndex = 100;
  } else if (violation === "reordered-discovery") {
    const listed = traceCall(trace, "list");
    const read = traceCall(trace, "read-types");
    [listed.eventIndex, read.eventIndex] = [read.eventIndex, listed.eventIndex];
    const listResult = expectDefined(trace.outcomes[0], "list result");
    const readResult = expectDefined(trace.outcomes[1], "read declaration result");
    [listResult.eventIndex, readResult.eventIndex] = [readResult.eventIndex, listResult.eventIndex];
  } else if (violation === "early-rejected-read") {
    traceCall(trace, "invalid").eventIndex = traceCall(trace, "write-types").eventIndex - 1;
  } else if (violation === "late-rejection") {
    trace.activities.push(expectDefined(trace.activities.shift(), "rejected read"));
  } else if (violation === "fabricated-error") {
    trace.activities.shift();
  }
  const checks = evaluate("javascript-contracts", expected, trace);
  expect(checks.answer).toBe(true);
  allChecks(checks, false);
});

function interviewAnswer(previewComplete: boolean | null) {
  return JSON.stringify({
    rationale: "Observed expiry of the prior snapshot.",
    facts: {
      priorRefAvailable: false,
      retainedDataFresh: false,
      sameRunOnly: true,
      previewComplete,
    },
  });
}

const previewCases = [
  { label: "missing preview metadata", descriptors: [{ id: "unknown" }] },
  {
    label: "mixed selected previews",
    descriptors: [
      { id: "full", previewTruncated: false },
      { id: "partial", previewTruncated: true },
    ],
  },
];
it.each(previewCases)("uses the actually probed descriptors for $label", ({ descriptors }) => {
  const taskTrace = collectGatewayMatrixTrace([
    assistantCall("saved", "return await results.save({});"),
    completed(
      "saved",
      descriptors.map((descriptor) => ({ bytes: 2, preview: "{}", ...descriptor })),
    ),
  ]);
  const interviewTrace = collectGatewayMatrixTrace(
    descriptors.flatMap(({ id }, index) => [
      assistantCall(
        `probe-${index}`,
        `try { return await results.load(${JSON.stringify(id)}); } catch (error) { return {error:String(error)}; }`,
      ),
      completed(`probe-${index}`, { error: `Result reference ${id} is unavailable or expired` }),
    ]),
  );
  const checks = evaluateGatewayMatrixInterview(
    "invoices-auto-retention",
    taskTrace,
    interviewTrace,
    interviewAnswer(null),
  );
  expect(checks).toMatchObject({ priorReferenceProbed: true, priorReferenceUnavailable: true });
  allChecks(checks);
});

it("requires correlated terminal expiry evidence through other-session-call-outcome", () => {
  const taskTrace = collectGatewayMatrixTrace(invoiceEvidence().events);
  const events: Record<string, unknown>[] = [
    assistantCall(
      "probe",
      'try { return await results.load("result-1"); } catch (error) { return {error:String(error)}; }',
    ),
    toolOutcome("probe", { status: "waiting", runId: "expiry-probe-run" }),
  ];
  const expired = { error: "Result reference result-1 is unavailable or expired" };
  events.push(
    ...waitEvents("resume-final", "expiry-probe-run", { status: "completed", value: expired }),
  );
  for (const [index, event] of events.entries()) {
    event.matrixSessionKey = index === 1 ? "child-session" : "root-session";
  }
  const checks = evaluateGatewayMatrixInterview(
    "invoices-auto-retention",
    taskTrace,
    collectGatewayMatrixTrace(events),
    interviewAnswer(false),
  );
  expect(checks.priorReferenceProbed).toBe(true);
  expect(checks.priorReferenceUnavailable).toBe(false);
  allChecks(checks, false);
});

const TASK_DELTAS = {
  taskElapsedMs: -2000,
  assistantTurns: null,
  upstreamCalls: 0,
  inputTokens: null,
  outputTokens: null,
  costUsd: null,
};

function comparisonRow(outcomes = false) {
  return {
    id: "invoice-code-r1",
    task: "invoices-auto-retention",
    model: "openai/gpt-5.6-sol",
    mode: "code",
    repetition: 1,
    gitSha: "baseline-sha",
    passed: true,
    elapsedMs: 20000,
    oracle: outcomes ? { identity: true } : undefined,
    workload: {
      promptSha256: "fixed-prompt",
      fixtureSha256: "fixed-fixture",
      settings: { executor: "node", thinking: "off", timeoutSeconds: 120 },
    },
    gateway: {
      upstreamCalls: 1,
      taskElapsedMs: 10000,
      ...(outcomes
        ? {
            traceAvailable: true,
            behavior: { answer: true, complete: true },
            interview: {
              traceAvailable: true,
              checks: { answered: true, priorReferenceUnavailable: true },
            },
          }
        : {}),
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
  expect(() => compareCodeModeMatrixResults([row], [])).toThrow("same model/mode/task/repetition");
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
  expect(expectDefined(compared.cells[0], "paired comparison cell").deltas).toEqual(TASK_DELTAS);
});

it("separates interview failure from the other outcome", () => {
  const baseline = comparisonRow(true);
  const candidate = comparisonRow(true);
  candidate.passed = false;
  candidate.gateway.taskElapsedMs = 8000;
  expectDefined(candidate.gateway.interview, "interview").checks.priorReferenceUnavailable = false;
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
    deltas: TASK_DELTAS,
  });
  expect(cell.interviewConsistency).toEqual({ baselinePassed: true, candidatePassed: false });
  expect(compared).toMatchObject({ baselinePassed: 1, candidatePassed: 0 });
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
