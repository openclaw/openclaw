import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect } from "vitest";

const auditHash = "0123456789abcdef".repeat(4);
const auditHeader = ["File", "Bytes", "SHA-256", "First nonempty line"];
const auditRows = [
  [
    "café_雪_invoice_reconciliation.md",
    "3514",
    auditHash,
    "Invoice arithmetic uses integer cents.",
  ],
  [
    "monthly_transaction_summary.md",
    "832",
    auditHash,
    "The total includes all recorded line items.",
  ],
  ["inventory_quantity_report.md", "890", auditHash, "Inventory quantities reconcile correctly."],
];
export const auditMarkdownTable = [auditHeader, auditHeader.map(() => "---"), ...auditRows]
  .map((row) => `| ${row.join(" | ")} |`)
  .join("\n");

export async function expectReadableAuditTable(page: Page, shell: Locator, artifactDir?: string) {
  const readCells = (element: HTMLElement) =>
    [...element.querySelectorAll<HTMLTableCellElement>("tbody td")].map((cell) => {
      const range = document.createRange();
      range.selectNodeContents(cell);
      return {
        text: cell.textContent,
        lines: new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size,
        width: cell.getBoundingClientRect().width,
        overflow: cell.scrollWidth - cell.clientWidth,
      };
    });
  const expectReadable = (cells: ReturnType<typeof readCells>) => {
    expect(
      cells.filter((_, index) => index % 4 === 1).map((cell) => [cell.text, cell.lines]),
    ).toEqual([
      ["3514", 1],
      ["832", 1],
      ["890", 1],
    ]);
    for (const cell of cells.filter((_, index) => index % 4 === 2)) {
      expect(cell.text).toBe(auditHash);
      expect(cell.lines).toBeGreaterThan(1);
      expect(cell.width).toBeLessThanOrEqual(408);
      expect(cell.overflow).toBeLessThanOrEqual(1);
    }
  };
  await shell.scrollIntoViewIfNeeded();
  if (artifactDir) {
    await page.screenshot({
      animations: "disabled",
      path: path.join(artifactDir, "audit-mobile.png"),
    });
  }
  expectReadable(await shell.evaluate(readCells));
  expect(
    await shell.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const pane = element.closest(".chat-thread")!.getBoundingClientRect();
      return bounds.left >= pane.left && bounds.right <= pane.right;
    }),
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await shell.getByRole("button", { name: "Copy table" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe([auditHeader, ...auditRows].map((row) => row.join("\t")).join("\n"));
  await shell.getByRole("button", { name: "Expand table" }).click();
  const dialog = page.locator(".markdown-table-dialog");
  await dialog.waitFor({ state: "visible" });
  expectReadable(await dialog.evaluate(readCells));
  expect(
    await dialog.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= document.documentElement.clientWidth;
    }),
  ).toBe(true);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
}

export function expectResponsiveTableGeometry(
  geometry: ReturnType<typeof readResponsiveTableGeometry>,
  width: number,
) {
  expect(geometry.withinPane).toBe(true);
  expect(geometry.verticalOverflow).toBeLessThanOrEqual(1);
  expect(geometry.topAligned).toBe(true);
  expect(geometry.headerPainted).toBe(true);
  expect(geometry.actionAboveTable).toBe(true);
  expect(geometry.columnWidths[0]).toBeGreaterThan(geometry.columnWidths[1]!);
  if (width > 932) {
    expect(geometry.width).toBeCloseTo(geometry.prose, 0);
    expect(geometry.compactWidths.every((value) => Math.abs(value - geometry.prose) <= 1)).toBe(
      true,
    );
    expect(geometry.denseWidth).toBeGreaterThan(geometry.prose);
    expect(geometry.denseOverflow).toBeLessThanOrEqual(1);
    expect(geometry.controlHeight).toBe(32);
    expect(geometry.visibleExpandLabel).toBe(false);
    expect(geometry.controlsGap).toBe(0);
    expect(geometry.bottomGap).toBeGreaterThanOrEqual(20);
    expect(geometry.prose).toBeLessThanOrEqual(768);
  } else {
    expect(geometry.controlHeight).toBe(40);
    expect(geometry.visibleExpandLabel).toBe(true);
    expect(geometry.controlsGap).toBe(4);
    expect(geometry.denseOverflow).toBeGreaterThan(0);
    if (width === 932) {
      expect(geometry.width).toBeCloseTo(900, 0);
    } else {
      expect(geometry.width).toBeLessThanOrEqual(geometry.prose + 1);
    }
  }
}

export function readResponsiveTableGeometry(element: HTMLElement) {
  const viewport = element.querySelector<HTMLElement>(".markdown-table__viewport")!;
  const table = element.querySelector("table")!;
  const cells = table.querySelectorAll("tbody tr:first-child td");
  const paragraph = element.parentElement!.querySelector("p")!;
  const pane = element.closest(".chat-thread")!;
  const action = element.querySelector("button")!;
  const rect = element.getBoundingClientRect();
  const paneRect = pane.getBoundingClientRect();
  const header = table.querySelector("th")!.getBoundingClientRect();
  const siblings = element.parentElement!.querySelectorAll<HTMLElement>(".markdown-table");
  const dense = siblings[3]!;
  const denseViewport = dense.querySelector<HTMLElement>(".markdown-table__viewport")!;
  return {
    compactWidths: [...siblings].slice(1, 3).map((node) => node.getBoundingClientRect().width),
    denseWidth: dense.getBoundingClientRect().width,
    denseOverflow: denseViewport.scrollWidth - denseViewport.clientWidth,
    controlHeight: action.getBoundingClientRect().height,
    visibleExpandLabel:
      element.querySelector(".markdown-table__expand > span")!.getClientRects().length > 0,
    controlsGap:
      table.getBoundingClientRect().top -
      element.querySelector(".markdown-table__actions")!.getBoundingClientRect().bottom,
    bottomGap: element.nextElementSibling!.getBoundingClientRect().top - rect.bottom,
    width: rect.width,
    prose: paragraph.getBoundingClientRect().width,
    withinPane: rect.left >= paneRect.left && rect.right <= paneRect.right,
    verticalOverflow: viewport.scrollHeight - viewport.clientHeight,
    columnWidths: [...cells].map((cell) => cell.getBoundingClientRect().width),
    topAligned: [...cells].every((cell) => getComputedStyle(cell).verticalAlign === "top"),
    headerPainted: table.contains(document.elementFromPoint(header.left + 4, header.top + 4)),
    actionAboveTable: action.getBoundingClientRect().bottom <= table.getBoundingClientRect().top,
  };
}
