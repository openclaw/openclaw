import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGatewayMatrixFixture,
  createGatewayMatrixPluginManifest,
  GATEWAY_MATRIX_TASKS,
  type GatewayMatrixTask,
} from "../../scripts/lib/code-mode-matrix-gateway-fixtures.js";
import { runGatewayMatrixCell } from "../../scripts/lib/code-mode-matrix-gateway.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const DRIVER = `
const {default: register} = await import(process.argv[1]);
const tools = new Map();
register({pluginConfig: {receiptsPath: process.argv[3]}, registerTool(tool) { tools.set(tool.name, tool); }});
const results = [];
for (const [index, action] of JSON.parse(process.argv[2]).entries()) {
  const tool = tools.get(action.name);
  results.push(await tool.execute(String(index), action.input ?? {}));
}
console.log(JSON.stringify({
  tools: [...tools.values()].map(({name, parameters, outputSchema}) => ({name, parameters, outputSchema})),
  results,
}));
`;

type Action = { name: string; input?: Record<string, unknown> };
type Invocation<T> = {
  tools: { name: string; parameters: TSchema; outputSchema?: TSchema }[];
  results: { details: T; content: { type: string; text: string }[] }[];
};

function prepare(task: GatewayMatrixTask, repetition = 2) {
  const fixture = createGatewayMatrixFixture(task, repetition);
  const root = tempDirs.make("openclaw-code-mode-matrix-");
  const pluginDir = path.join(root, "plugin");
  fs.mkdirSync(pluginDir);
  fs.writeFileSync(path.join(root, "receipts.jsonl"), "");
  const entry = path.join(pluginDir, "index.mjs");
  fs.writeFileSync(entry, fixture.pluginSource);
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(createGatewayMatrixPluginManifest(fixture.requiredTools)),
  );
  return { fixture, root, entry };
}

function invoke<T>(entry: string, actions: Action[]): Invocation<T> {
  const run = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      DRIVER,
      pathToFileURL(entry).href,
      JSON.stringify(actions),
      path.resolve(path.dirname(entry), "..", "receipts.jsonl"),
    ],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  expect(run.status, run.stderr).toBe(0);
  const invocation = JSON.parse(run.stdout) as Invocation<T>;
  const manifest = JSON.parse(
    fs.readFileSync(path.join(path.dirname(entry), "openclaw.plugin.json"), "utf8"),
  );
  expect(manifest.contracts.tools.toSorted()).toEqual(
    invocation.tools.map((tool) => tool.name).toSorted(),
  );
  expect(manifest.activation.onStartup).toBe(true);
  return invocation;
}

describe("Gateway code-mode matrix fixtures", () => {
  it("supplies a full oversized invoice export with an independently verified unpaid-total oracle", () => {
    const { fixture, root, entry } = prepare("invoices-auto-retention");
    type Export = {
      nonce: string;
      invoices: { customer: string; amountCents: number; paid: boolean }[];
    };
    const run = invoke<Export>(entry, [{ name: "matrix_invoice_export" }]);
    expect(run.tools.map((tool) => tool.name).toSorted()).toEqual(fixture.requiredTools.toSorted());
    const exported = expectDefined(run.results[0], "invoice export result").details;
    expect(Buffer.byteLength(JSON.stringify(exported))).toBeGreaterThan(64 * 1024);
    expect(expectDefined(run.tools[0], "invoice export tool").outputSchema).toBeUndefined();
    const totalsCents: Record<string, number> = {};
    for (const customer of new Set(exported.invoices.map((invoice) => invoice.customer))) {
      totalsCents[customer] = exported.invoices
        .filter((invoice) => invoice.customer === customer && !invoice.paid)
        .reduce((sum, invoice) => sum + invoice.amountCents, 0);
    }
    expect(fixture.expected).toEqual({
      nonce: exported.nonce,
      count: exported.invoices.length,
      totalsCents,
    });
    expect(fs.readFileSync(path.join(root, "receipts.jsonl"), "utf8").trim()).toBe(
      JSON.stringify({ sequence: 1, kind: "call", tool: "matrix_invoice_export" }),
    );
  });

  it("makes full heterogeneous inventory joins distinguishable from sample-only calculations", () => {
    const { fixture, entry } = prepare("inventory-join");
    type RecordRow = {
      supplier: { id: string } | null;
      stock?: { onHand: number | string | null };
      reorder: { target: number };
    };
    type Inventory = { nonce: string; batches: { records: RecordRow[] }[] };
    type Directory = {
      suppliers: {
        supplierId: string;
        available: boolean;
        terms: { unitCostCents: number | null };
      }[];
    };
    const inventoryRun = invoke<Inventory>(entry, [{ name: "matrix_inventory_export" }]);
    expect(inventoryRun.tools.map((tool) => tool.name).toSorted()).toEqual(
      fixture.requiredTools.toSorted(),
    );
    const inventory = expectDefined(inventoryRun.results[0], "inventory export result").details;
    const directory = expectDefined(
      invoke<Directory>(entry, [{ name: "matrix_supplier_directory" }]).results[0],
      "supplier directory result",
    ).details;
    const records = inventory.batches.flatMap((batch) => batch.records);
    expect(records.some((row) => row.stock?.onHand === null)).toBe(true);
    expect(records.some((row) => !row.stock)).toBe(true);
    expect(records.some((row) => typeof row.stock?.onHand === "string")).toBe(true);
    const low = records.filter(
      (row) => row.stock?.onHand != null && Number(row.stock.onHand) < row.reorder.target,
    );
    const available = low.flatMap((row) => {
      const supplier = directory.suppliers.find((item) => item.supplierId === row.supplier?.id);
      if (!supplier?.available || supplier.terms.unitCostCents == null) {
        return [];
      }
      const units = row.reorder.target - Number(row.stock?.onHand);
      return [
        { supplierId: supplier.supplierId, units, costCents: units * supplier.terms.unitCostCents },
      ];
    });
    const totalsBySupplier = directory.suppliers
      .map(({ supplierId }) => ({
        supplierId,
        units: available
          .filter((row) => row.supplierId === supplierId)
          .reduce((sum, row) => sum + row.units, 0),
        costCents: available
          .filter((row) => row.supplierId === supplierId)
          .reduce((sum, row) => sum + row.costCents, 0),
      }))
      .filter((row) => row.units > 0)
      .toSorted((a, b) => a.supplierId.localeCompare(b.supplierId));
    expect(fixture.expected).toEqual({
      nonce: inventory.nonce,
      lowStockCount: low.length,
      reorderUnits: available.reduce((sum, row) => sum + row.units, 0),
      unavailableSupplierCount: low.length - available.length,
      totalsBySupplier,
    });
    expect(low.length).toBeGreaterThan(
      expectDefined(inventory.batches[0], "first warehouse batch").records.length,
    );
    expect(fixture.expected.unavailableSupplierCount).toBeGreaterThan(0);
  });

  it("persists settlement receipts outside the plugin across fresh registrations and exposes duplicate effects", () => {
    const { fixture, root, entry } = prepare("partial-failure");
    const input = { operationId: fixture.expected.operationId };
    const settled = invoke<Record<string, unknown>>(entry, [{ name: "matrix_settle", input }]);
    expect(settled.tools.map((tool) => tool.name).toSorted()).toEqual(
      fixture.requiredTools.toSorted(),
    );
    const schema = settled.tools.find((tool) => tool.name === "matrix_settle")?.outputSchema;
    expect(schema).toBeDefined();
    if (!schema) {
      throw new Error("Settlement output schema is required for the fault scenario");
    }
    expect(Value.Check(schema, expectDefined(settled.results[0], "settlement reply").details)).toBe(
      false,
    );
    const observed = invoke<Record<string, unknown>>(entry, [
      { name: "matrix_settlement_inspect", input },
    ]);
    expect(expectDefined(observed.results[0], "persisted settlement inspection").details).toEqual(
      fixture.expected,
    );
    const retried = invoke<Record<string, unknown>>(entry, [
      { name: "matrix_settle", input },
      { name: "matrix_settlement_inspect", input },
    ]);
    expect(
      expectDefined(retried.results[1], "inspection after repeated settlement").details,
    ).toMatchObject({
      effectCount: 2,
      totalCents: Number(fixture.expected.totalCents) * 2,
    });
    const receipts = fs
      .readFileSync(path.join(root, "receipts.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; tool: string });
    expect(receipts.map(({ kind, tool }) => `${kind}:${tool}`)).toEqual([
      "call:matrix_settle",
      "effect:matrix_settle",
      "call:matrix_settlement_inspect",
      "call:matrix_settle",
      "effect:matrix_settle",
      "call:matrix_settlement_inspect",
    ]);
    expect(fs.existsSync(path.join(path.dirname(entry), "receipts.jsonl"))).toBe(false);
  });

  it("records every return-value effect in the fixture receipt owner", () => {
    const { fixture, root, entry } = prepare("return-value-effects");
    const input = { nonce: fixture.expected.nonce };
    const run = invoke<{ nonce: string }>(entry, [
      { name: "matrix_return_effect", input },
      { name: "matrix_return_effect", input },
    ]);
    expect(run.results.map((result) => result.details)).toEqual([input, input]);
    const receipts = fs
      .readFileSync(path.join(root, "receipts.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(receipts).toEqual([
      { sequence: 1, kind: "call", tool: "matrix_return_effect", ...input },
      { sequence: 2, kind: "effect", tool: "matrix_return_effect", ...input },
      { sequence: 3, kind: "call", tool: "matrix_return_effect", ...input },
      { sequence: 4, kind: "effect", tool: "matrix_return_effect", ...input },
    ]);
  });

  it("declares the serialization seed used by the prescribed guest program", () => {
    const { fixture, entry } = prepare("result-save-invalid-json");
    const run = invoke<{ nonce: string }>(entry, [{ name: "matrix_serialization_seed" }]);
    const schema = expectDefined(run.tools[0]?.outputSchema, "serialization seed schema");
    const seed = expectDefined(run.results[0], "serialization seed").details;
    expect(Value.Check(schema, seed)).toBe(true);
    expect(seed).toEqual({ nonce: fixture.expected.nonce });
  });

  it.each([
    "automation-contracts",
    "process-contracts",
    "javascript-contracts",
    "gateway-config-read",
  ] as const)("%s relies on actual built-ins instead of synthetic replacements", (task) => {
    const { fixture, entry } = prepare(task);
    expect(invoke(entry, []).tools).toEqual([]);
    expect(fixture.requiredTools).toEqual([]);
  });

  it("keeps each repetition reproducible across runtime/model consumers", () => {
    for (const task of GATEWAY_MATRIX_TASKS) {
      expect(createGatewayMatrixFixture(task, 3)).toEqual(createGatewayMatrixFixture(task, 3));
      expect(createGatewayMatrixFixture(task, 4).expected).not.toEqual(
        createGatewayMatrixFixture(task, 3).expected,
      );
    }
    expect(() => createGatewayMatrixFixture("inventory-join", -1)).toThrow("repetition");
  });
});

const FAKE_GATEWAY = `
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
const fixtureData = JSON.parse(fs.readFileSync(new URL("./case.json", import.meta.url), "utf8"));
const config = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
fs.writeFileSync(new URL("./observed-config.json", import.meta.url), JSON.stringify({
  codeMode: config.tools.codeMode,
  plugins: { allow: config.plugins.allow, quickjs: config.plugins.entries["code-mode-quickjs"] }
}));
const pluginDir = config.plugins.load.paths[0];
const { default: register } = await import(pathToFileURL(path.join(pluginDir, "index.mjs")).href);
const tools = new Map();
register({ pluginConfig: config.plugins.entries["code-mode-matrix-fixture"].config,
  registerTool(tool) { tools.set(tool.name, tool); } });
if (process.argv.includes("call")) {
  console.log(JSON.stringify({ groups: [{ tools: [...tools.keys()].map(id => ({
    id, source: "plugin", pluginId: "code-mode-matrix-fixture"
  })) }] }));
} else {
  const agentDir = path.join(process.env.OPENCLAW_STATE_DIR, "agents", "qa", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite"));
  db.exec("CREATE TABLE transcript_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, event_json TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO transcript_events(session_id,event_json) VALUES (?,?)");
  const emit = message => insert.run("synthetic-session", JSON.stringify({ type: "message", message }));
  const diagnostic = "Output contract: receipt must be a string; totalCents is required";
  function toolStep(id, name, input, result, isError) {
    emit({ role: "assistant", provider: "openai", model: "gpt-5.6-sol", content: [{
      type: "toolCall", id, name: "exec", arguments: { code: "return await " + name + "(" + JSON.stringify(input) + ");" }
    }] });
    emit({ role: "custom", customType: "openclaw.nested-tool.v1", display: true,
      excludeFromContext: true, content: "", timestamp: 100,
      details: { runId: id, scopeId: id, afterEntryId: null, startOrder: 0,
        parentToolCallId: id, toolCallId: id + "-nested", toolName: name, input,
        result, isError, startedAt: 100, timestamp: 101 } });
    const details = isError ? { status: "failed", error: diagnostic } : { status: "completed", value: result.details };
    emit({ role: "toolResult", toolCallId: id, toolName: "exec", isError, details,
      content: [{ type: "text", text: JSON.stringify(details) }] });
  }
  const server = http.createServer(async (request, response) => {
    if (request.url === "/readyz") { response.end("ready"); return; }
    if (request.method !== "POST" || request.url !== "/v1/responses") { response.writeHead(404).end(); return; }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const interview = Boolean(body.previous_response_id);
    const input = { operationId: fixtureData.expected.operationId };
    const id = interview ? "interview-settle" : "task-settle";
    const settled = await tools.get("matrix_settle").execute(id, input);
    toolStep(id, "matrix_settle", input, settled, true);
    let final;
    if (interview) {
      final = { rationale: "I performed an additional settlement during the interview.", facts: { failureImpliesRollback: false } };
    } else {
      const inspected = await tools.get("matrix_settlement_inspect").execute("task-inspect", input);
      toolStep("task-inspect", "matrix_settlement_inspect", input, inspected, false);
      final = inspected.details;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: interview ? "interview-response" : "task-response", status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(final) }] }] }));
  });
  server.listen(config.gateway.port, "127.0.0.1");
}
`;

it.each(["node", "quickjs"] as const)(
  "routes %s while keeping interview settlement effects out of the completed task score and receipts",
  async (executor) => {
    const root = tempDirs.make("openclaw-matrix-producer-");
    const runtime = path.join(root, "fake-gateway.mjs");
    const fixture = createGatewayMatrixFixture("partial-failure", 1);
    fs.writeFileSync(runtime, FAKE_GATEWAY);
    fs.writeFileSync(path.join(root, "case.json"), JSON.stringify({ expected: fixture.expected }));
    vi.stubEnv("OPENAI_API_KEY", "synthetic-local-producer-test-key");
    try {
      const result = await runGatewayMatrixCell({
        executor,
        cell: {
          id: "receipt-boundary",
          model: "openai/gpt-5.6-sol",
          mode: "code",
          task: "partial-failure",
          repetition: 1,
        },
        runtime: { args: [runtime], cwd: root },
        repoRoot: root,
        outputDir: root,
        keepState: false,
        thinking: "off",
        timeoutSeconds: 30,
        gitSha: "a".repeat(40),
        buildSha256: "b".repeat(64),
        sourceDirty: false,
        sourcePatchSha256: null,
      });
      const observedConfig = JSON.parse(
        fs.readFileSync(path.join(root, "observed-config.json"), "utf8"),
      );
      expect(observedConfig.codeMode.executor).toBe(executor);
      expect(observedConfig.plugins.allow.includes("code-mode-quickjs")).toBe(
        executor === "quickjs",
      );
      expect(observedConfig.plugins.quickjs).toEqual(
        executor === "quickjs" ? { enabled: true } : undefined,
      );
      expect(result.executor).toBe(executor);
      const gateway = expectDefined(result.gateway, "producer Gateway evidence");
      expect(gateway.settings.executor).toBe(executor);
      expect(gateway.behavior.exactlyOneEffect).toBe(true);
      expect(result.failureCategory).toBe("interview_mismatch");
      expect(gateway.interview.checks.noExternalAction).toBe(false);
      const artifacts = path.join(root, "cells", "receipt-boundary");
      const readReceipts = (name: string) =>
        JSON.parse(fs.readFileSync(path.join(artifacts, name), "utf8")) as {
          kind: string;
          tool: string;
        }[];
      const taskReceipts = readReceipts("task-receipts.json");
      const interviewReceipts = readReceipts("interview-receipts.json");
      expect(taskReceipts.map(({ kind, tool }) => `${kind}:${tool}`)).toEqual([
        "call:matrix_settle",
        "effect:matrix_settle",
        "call:matrix_settlement_inspect",
      ]);
      expect(interviewReceipts.map(({ kind, tool }) => `${kind}:${tool}`)).toEqual([
        "call:matrix_settle",
        "effect:matrix_settle",
      ]);
      expect(readReceipts("receipts.json")).toEqual([...taskReceipts, ...interviewReceipts]);
    } finally {
      vi.unstubAllEnvs();
    }
  },
);
