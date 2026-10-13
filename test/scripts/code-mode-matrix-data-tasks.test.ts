import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createDataFixture } from "../../scripts/lib/code-mode-matrix-data-tasks.ts";
import type { MatrixPerformanceEvaluation } from "../../scripts/lib/code-mode-matrix-performance-types.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type Invoice = {
  invoiceId: string;
  revision: number;
  customerId: string;
  status: string;
  dueDate: string;
  amountCents?: number | string | null;
  creditCents: number;
};
type Page = { snapshotId: string; records: Invoice[]; nextCursor: string | null };
type FixtureTool = {
  execute: (id: string, input: Record<string, unknown>) => Promise<{ details: unknown }>;
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function prepare(repetition: number) {
  const fixture = createDataFixture("invoice-reconciliation", repetition);
  const root = tempDirs.make("openclaw-invoice-matrix-");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  await Promise.all(
    Object.entries(fixture.workspaceFiles ?? {}).map(([name, value]) =>
      fs.writeFile(path.join(workspace, name), value),
    ),
  );
  const receiptsPath = path.join(root, "receipts.jsonl");
  const pluginPath = path.join(root, "fixture.mjs");
  await fs.writeFile(pluginPath, fixture.pluginSource!);
  const plugin = await import(pathToFileURL(pluginPath).href);
  const tools = new Map<string, FixtureTool>();
  plugin.default({
    pluginConfig: { receiptsPath },
    registerTool(tool: FixtureTool & { name: string }) {
      tools.set(tool.name, tool);
    },
  });
  const snapshot = (await tools.get("matrix_invoice_snapshot")!.execute("snapshot", {}))
    .details as { snapshotId: string; recordCount: number; firstCursor: string };
  const rows: Invoice[] = [];
  const pages: Page[] = [];
  let cursor: string | null = snapshot.firstCursor;
  while (cursor !== null) {
    const page = (
      await tools.get("matrix_invoice_page")!.execute("page", {
        snapshotId: snapshot.snapshotId,
        cursor,
      })
    ).details as Page;
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8 * 1024);
    pages.push(page);
    rows.push(...page.records);
    cursor = page.nextCursor;
  }
  const policy = JSON.parse(fixture.workspaceFiles!["reconciliation-policy.json"]!);
  // This reference groups revisions in one pass; it does not use the fixture oracle.
  const latest = new Map<string, Invoice>();
  for (const row of rows) {
    if ((latest.get(row.invoiceId)?.revision ?? 0) < row.revision) {
      latest.set(row.invoiceId, row);
    }
  }
  const selected = [...latest.values()].toSorted((a, b) => a.invoiceId.localeCompare(b.invoiceId));
  const eligible = selected.filter(
    (row) => row.status === "open" && row.dueDate <= policy.cutoffDate,
  );
  const payableInvoices = eligible
    .filter((row) => row.amountCents != null)
    .map((row) => ({
      invoiceId: row.invoiceId,
      revision: row.revision,
      customerId: row.customerId,
      amountCents: Number(row.amountCents),
      creditCents: row.creditCents,
      netCents: Number(row.amountCents) - row.creditCents,
    }));
  const totals = new Map<string, { customerId: string; invoiceCount: number; netCents: number }>();
  for (const row of payableInvoices) {
    const total = totals.get(row.customerId) ?? {
      customerId: row.customerId,
      invoiceCount: 0,
      netCents: 0,
    };
    total.invoiceCount += 1;
    total.netCents += row.netCents;
    totals.set(row.customerId, total);
  }
  const customerTotals = [...totals.values()].toSorted((a, b) =>
    a.customerId.localeCompare(b.customerId),
  );
  const report = {
    snapshotId: snapshot.snapshotId,
    sourceRecordCount: rows.length,
    invoiceCount: latest.size,
    cutoffDate: policy.cutoffDate,
    payableInvoices,
    excludedInvoices: selected
      .filter((row) => row.status !== "open" || row.dueDate > policy.cutoffDate)
      .map((row) => ({
        invoiceId: row.invoiceId,
        revision: row.revision,
        reason: row.status === "open" ? "future" : row.status,
      })),
    exceptions: eligible
      .filter((row) => row.amountCents == null)
      .map((row) => ({
        invoiceId: row.invoiceId,
        revision: row.revision,
        reason: "unknown_amount",
      })),
    customerTotals,
    totalNetCents: [...totals.values()].reduce((sum, row) => sum + row.netCents, 0),
  };
  const artifacts = {
    "reconciliation.json": JSON.stringify(report),
    "customer-balances.csv":
      "customerId,invoiceCount,netCents\n" +
      customerTotals
        .map((row) => `${row.customerId},${row.invoiceCount},${row.netCents}\n`)
        .join(""),
  };
  await Promise.all(
    Object.entries(artifacts).map(([name, value]) =>
      fs.writeFile(path.join(workspace, name), value),
    ),
  );
  const trace: MatrixPerformanceEvaluation["trace"] = {
    calls: [],
    outcomes: [],
    assistantTurns: 1,
    models: [],
    activities: Object.entries(artifacts).flatMap(([name, content]) => [
      { name: "write", input: { path: name, content }, result: {}, isError: false },
      { name: "read", input: { path: name }, result: { kind: "text", content }, isError: false },
    ]),
  };
  const receipts: unknown[] = (await fs.readFile(receiptsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  return {
    fixture,
    report,
    rows,
    pages,
    snapshot,
    tools,
    evaluate: (patch: Partial<MatrixPerformanceEvaluation> = {}) =>
      fixture.evaluate({ workspace, trace, receipts, ...patch }),
    workspace,
    trace,
    receipts,
  };
}

describe("paginated invoice task", () => {
  it("accepts independently reconciled artifacts across seeds with complete bounded source pages", async () => {
    const totals: number[] = [];
    for (const repetition of [1, 2, 3]) {
      const run = await prepare(repetition);
      expect(run.rows).toHaveLength(192);
      expect(run.pages).toHaveLength(8);
      expect(run.report.invoiceCount).toBe(144);
      expect(run.report.payableInvoices.some((row) => row.amountCents === 0)).toBe(true);
      expect(run.rows.some((row) => row.amountCents === null)).toBe(true);
      expect(run.rows.some((row) => !("amountCents" in row))).toBe(true);
      expect(run.report.payableInvoices).toContainEqual(
        expect.objectContaining({ invoiceId: run.rows.at(-1)!.invoiceId, revision: 2 }),
      );
      expect(Object.values(await run.evaluate()).every(Boolean)).toBe(true);
      totals.push(run.report.totalNetCents);
      const projected = (
        await run.tools.get("matrix_invoice_page")!.execute("projection", {
          snapshotId: run.snapshot.snapshotId,
          cursor: run.snapshot.firstCursor,
          fields: ["invoiceId", "revision"],
        })
      ).details as Page;
      expect(projected.records).toEqual(
        run.pages[0]!.records.map(({ invoiceId, revision }) => ({ invoiceId, revision })),
      );
      expect(projected.nextCursor).toBe(run.pages[0]!.nextCursor);
    }
    expect(new Set(totals).size).toBe(3);
  });

  it("rejects missing final-page evidence while accepting artifacts produced without file tool calls", async () => {
    const run = await prepare(4);
    expect((await run.evaluate({ receipts: run.receipts.slice(0, -1) })).completePageCoverage).toBe(
      false,
    );
    expect(
      Object.values(await run.evaluate({ trace: { ...run.trace, activities: [] } })).every(Boolean),
    ).toBe(true);
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
