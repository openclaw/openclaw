import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createDataFixture } from "../../scripts/lib/code-mode-matrix-data-tasks.ts";
import type { MatrixPerformanceEvaluation } from "../../scripts/lib/code-mode-matrix-performance-types.ts";
import { groupBy } from "../../scripts/lib/group-by.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type Invoice = Record<"invoiceId" | "customerId" | "status" | "dueDate", string> & {
  revision: number;
  amountCents?: number | string | null;
  creditCents: number;
};
type Page = { snapshotId: string; records: Invoice[]; nextCursor: string | null };
type Snapshot = { snapshotId: string; recordCount: number; firstCursor: string };
type FixtureTool = {
  execute: (id: string, input: Record<string, unknown>) => Promise<{ details: unknown }>;
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const writeFiles = (workspace: string, files: Record<string, string>) =>
  Promise.all(
    Object.entries(files).map(([name, value]) => fs.writeFile(path.join(workspace, name), value)),
  );
const decision = ({ invoiceId, revision }: Invoice, reason: string) => ({
  invoiceId,
  revision,
  reason,
});
const sumNet = (rows: readonly { netCents: number }[]) =>
  rows.reduce((sum, row) => sum + row.netCents, 0);

async function prepare(repetition: number) {
  const fixture = createDataFixture("invoice-reconciliation", repetition);
  const workspace = tempDirs.make("openclaw-invoice-matrix-");
  await writeFiles(workspace, fixture.workspaceFiles ?? {});
  const receiptsPath = path.join(workspace, "receipts.jsonl");
  const pluginPath = path.join(workspace, "fixture.mjs");
  await fs.writeFile(pluginPath, fixture.pluginSource!);
  const plugin = await import(pathToFileURL(pluginPath).href);
  const tools = new Map<string, FixtureTool>();
  plugin.default({
    pluginConfig: { receiptsPath },
    registerTool(tool: FixtureTool & { name: string }) {
      tools.set(tool.name, tool);
    },
  });
  const call = async <T>(name: string, input: Record<string, unknown>): Promise<T> =>
    (await tools.get(name)!.execute(name, input)).details as T;
  const snapshot = await call<Snapshot>("matrix_invoice_snapshot", {});
  const readPage = (cursor: string, fields?: string[]) =>
    call<Page>("matrix_invoice_page", { snapshotId: snapshot.snapshotId, cursor, fields });
  const rows: Invoice[] = [];
  const pages: Page[] = [];
  let cursor: string | null = snapshot.firstCursor;
  while (cursor !== null) {
    const page = await readPage(cursor);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8 * 1024);
    pages.push(page);
    rows.push(...page.records);
    cursor = page.nextCursor;
  }
  const policy = JSON.parse(fixture.workspaceFiles!["reconciliation-policy.json"]!);
  // Independent reference: group once and reduce to the highest revision, not the fixture oracle.
  const selected = [...groupBy(rows, (row) => row.invoiceId).values()]
    .map((revisions) => revisions.reduce((a, b) => (a.revision < b.revision ? b : a)))
    .toSorted((a, b) => a.invoiceId.localeCompare(b.invoiceId));
  const isEligible = (row: Invoice) => row.status === "open" && row.dueDate <= policy.cutoffDate;
  const eligible = selected.filter(isEligible);
  const payableInvoices = eligible
    .filter((row) => row.amountCents != null)
    .map(({ invoiceId, revision, customerId, amountCents, creditCents }) => ({
      invoiceId,
      revision,
      customerId,
      amountCents: Number(amountCents),
      creditCents,
      netCents: Number(amountCents) - creditCents,
    }));
  const customerTotals = [...groupBy(payableInvoices, (row) => row.customerId)]
    .map(([customerId, invoices]) => ({
      customerId,
      invoiceCount: invoices.length,
      netCents: sumNet(invoices),
    }))
    .toSorted((a, b) => a.customerId.localeCompare(b.customerId));
  const report = {
    snapshotId: snapshot.snapshotId,
    sourceRecordCount: rows.length,
    invoiceCount: selected.length,
    cutoffDate: policy.cutoffDate,
    payableInvoices,
    excludedInvoices: selected
      .filter((row) => !isEligible(row))
      .map((row) => decision(row, row.status === "open" ? "future" : row.status)),
    exceptions: eligible
      .filter((row) => row.amountCents == null)
      .map((row) => decision(row, "unknown_amount")),
    customerTotals,
    totalNetCents: sumNet(customerTotals),
  };
  const artifacts = {
    "reconciliation.json": JSON.stringify(report),
    "customer-balances.csv":
      "customerId,invoiceCount,netCents\n" +
      customerTotals
        .map((row) => `${row.customerId},${row.invoiceCount},${row.netCents}\n`)
        .join(""),
  };
  await writeFiles(workspace, artifacts);
  const trace: MatrixPerformanceEvaluation["trace"] = {
    calls: [],
    outcomes: [],
    assistantTurns: 1,
    models: [],
    activities: [],
  };
  const receipts: unknown[] = (await fs.readFile(receiptsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return {
    report,
    rows,
    pages,
    readFirstPage: (fields: string[]) => readPage(snapshot.firstCursor, fields),
    evaluate: (patch: Partial<MatrixPerformanceEvaluation> = {}) =>
      fixture.evaluate({ workspace, trace, receipts, ...patch }),
    workspace,
    receipts,
  };
}

describe("paginated invoice task", () => {
  it("accepts independently reconciled artifacts without file-tool calls across seeds and complete bounded pages", async () => {
    const totals: number[] = [];
    for (const repetition of [1, 2, 3]) {
      const run = await prepare(repetition);
      expect([run.rows.length, run.pages.length, run.report.invoiceCount]).toEqual([192, 8, 144]);
      expect(run.report.payableInvoices.some((row) => row.amountCents === 0)).toBe(true);
      expect(run.rows.some((row) => row.amountCents === null)).toBe(true);
      expect(run.rows.some((row) => !("amountCents" in row))).toBe(true);
      expect(run.report.payableInvoices).toContainEqual(
        expect.objectContaining({ invoiceId: run.rows.at(-1)!.invoiceId, revision: 2 }),
      );
      expect(Object.values(await run.evaluate()).every(Boolean)).toBe(true);
      totals.push(run.report.totalNetCents);
      expect(await run.readFirstPage(["invoiceId", "revision"])).toEqual({
        ...run.pages[0],
        records: run.pages[0]!.records.map(({ invoiceId, revision }) => ({ invoiceId, revision })),
      });
    }
    expect(new Set(totals).size).toBe(3);
  });

  it("rejects missing final-page evidence", async () => {
    const run = await prepare(4);
    expect((await run.evaluate({ receipts: run.receipts.slice(0, -1) })).completePageCoverage).toBe(
      false,
    );
  });

  it("rejects altered invoice decisions, CSV totals, and preserved source files", async () => {
    const run = await prepare(5);
    run.report.payableInvoices.pop();
    await fs.writeFile(path.join(run.workspace, "reconciliation.json"), JSON.stringify(run.report));
    await fs.appendFile(path.join(run.workspace, "customer-balances.csv"), "customer-extra,1,1\n");
    await fs.writeFile(path.join(run.workspace, "existing-notes.txt"), "changed");
    expect(await run.evaluate()).toMatchObject({
      exactReconciliationArtifact: false,
      exactCustomerBalancesArtifact: false,
      preservedSourceFiles: false,
    });
  });
});
