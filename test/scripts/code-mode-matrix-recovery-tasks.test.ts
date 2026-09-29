import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import type { GatewayMatrixTrace } from "../../scripts/lib/code-mode-matrix-gateway.js";
import {
  createRecoveryMatrixFixture,
  RECOVERY_MATRIX_TASKS,
} from "../../scripts/lib/code-mode-matrix-recovery-tasks.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const DRIVER = `
import fs from "node:fs";
import path from "node:path";
const { default: register } = await import(process.argv[1]);
const runs = [];
for (const reverse of [false, true]) {
  const workspace = path.join(process.argv[2], reverse ? "reverse" : "forward");
  fs.mkdirSync(workspace);
  const receiptsPath = path.join(workspace, "receipts.jsonl");
  const tools = new Map();
  register({ pluginConfig: { receiptsPath }, registerTool(tool) { tools.set(tool.name, tool); } });
  let callId = 0;
  const call = async (name, input = {}) => (await tools.get(name).execute(String(++callId), input)).details;
  const batch = await call("matrix_settlement_batch");
  const failures = [];
  const operations = reverse ? batch.operations.toReversed() : batch.operations;
  for (const operation of operations) {
    if (operation.blocked) continue;
    const input = { operationId: operation.operationId, totalCents: operation.lines.reduce((sum, line) => sum + line.amountCents, 0) };
    try {
      await call("matrix_settle_operation", input);
    } catch (error) {
      const { states } = await call("matrix_inspect_settlements");
      const state = states.find(item => item.operationId === operation.operationId);
      failures.push({ operationId: operation.operationId, message: error.message, effectCount: state.effectCount });
      if (state.status === "unsettled") await call("matrix_settle_operation", input);
    }
  }
  const { states } = await call("matrix_inspect_settlements");
  const project = ({operationId, effectCount, totalCents}) => ({operationId, effectCount, totalCents});
  const settled = states.filter(state => batch.operations.some(operation => operation.operationId === state.operationId) && state.status === "settled").map(project).sort((a,b) => a.operationId.localeCompare(b.operationId));
  const report = {
    batchId: batch.batchId,
    sourceLineCount: batch.operations.reduce((sum, operation) => sum + operation.lines.length, 0),
    settled,
    blocked: states.filter(state => state.status === "blocked").map(state => state.operationId).sort(),
    preserved: states.filter(state => batch.existing.some(existing => existing.operationId === state.operationId)).map(project).sort((a,b) => a.operationId.localeCompare(b.operationId)),
    newEffectCount: settled.reduce((sum, state) => sum + state.effectCount, 0),
    newTotalCents: settled.reduce((sum, state) => sum + state.totalCents, 0),
  };
  fs.writeFileSync(path.join(workspace, "settlement-report.json"), JSON.stringify(report));
  runs.push({ workspace, batch, failures, report, receipts: fs.readFileSync(receiptsPath, "utf8").trim().split("\\n").map(JSON.parse) });
}
console.log(JSON.stringify(runs));
`;

type Run = {
  workspace: string;
  batch: { operations: { operationId: string; lines: unknown[] }[] };
  failures: { operationId: string; message: string; effectCount: number }[];
  report: { newEffectCount: number; settled: unknown[]; blocked: string[]; preserved: unknown[] };
  receipts: Record<string, unknown>[];
};

function emptyTrace(): GatewayMatrixTrace {
  return {
    calls: [],
    outcomes: [],
    activities: [],
    assistantTurns: 1,
    models: [],
  };
}

it("injects operation-bound failures in either order and rejects missing reconciliation or duplicate effects", async () => {
  const fixture = createRecoveryMatrixFixture(RECOVERY_MATRIX_TASKS[0], 2);
  const root = tempDirs.make("matrix-recovery-");
  const entry = path.join(root, "fixture.mjs");
  const pluginSource = fixture.pluginSource;
  if (!pluginSource) {
    throw new Error("Recovery fixture must provide a plugin source");
  }
  fs.writeFileSync(entry, pluginSource);
  // One child exercises the generated ESM plugin under both invocation orders.
  const processResult = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", DRIVER, pathToFileURL(entry).href, root],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );
  expect(processResult.status, processResult.stderr).toBe(0);
  const runs = JSON.parse(processResult.stdout) as Run[];
  expect(runs).toHaveLength(2);
  for (const run of runs) {
    expect(run.batch.operations).toHaveLength(12);
    expect(run.batch.operations.flatMap((operation) => operation.lines)).toHaveLength(96);
    expect(run.failures.map((failure) => failure.effectCount).toSorted((a, b) => a - b)).toEqual([
      0, 0, 1, 1,
    ]);
    expect(new Set(run.failures.map((failure) => failure.message)).size).toBe(1);
    expect(run.report).toMatchObject({ newEffectCount: 10 });
    expect(run.report.settled).toHaveLength(10);
    expect(run.report.blocked).toHaveLength(2);
    expect(run.report.preserved).toHaveLength(3);
    const evaluation = { ...run, trace: emptyTrace() };
    const checks = await fixture.evaluate(evaluation);
    expect(Object.values(checks).every(Boolean), JSON.stringify(checks)).toBe(true);

    const missingInspections = run.receipts.filter((row) => row.kind !== "inspection");
    expect(await fixture.evaluate({ ...evaluation, receipts: missingInspections })).toMatchObject({
      inspectedBeforeRetry: false,
      finalStateInspected: false,
    });
    const staleInspections = [
      ...run.receipts.filter((row) => row.kind === "inspection"),
      ...missingInspections,
    ];
    expect(await fixture.evaluate({ ...evaluation, receipts: staleInspections })).toMatchObject({
      inspectedBeforeRetry: false,
    });
    const firstEffect = run.receipts.find((row) => row.kind === "effect");
    expect(firstEffect).toBeDefined();
    expect(
      await fixture.evaluate({ ...evaluation, receipts: [...run.receipts, firstEffect] }),
    ).toMatchObject({ exactlyOnceEligibleEffects: false, finalStateInspected: false });
    fs.writeFileSync(path.join(run.workspace, "settlement-report.json"), "{}");
    expect(await fixture.evaluate(evaluation)).toMatchObject({ exactReport: false });
  }
  expect(runs[0]?.failures.toSorted((a, b) => a.operationId.localeCompare(b.operationId))).toEqual(
    runs[1]?.failures.toSorted((a, b) => a.operationId.localeCompare(b.operationId)),
  );
});
