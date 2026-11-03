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
];
export const auditMarkdownTable = [auditHeader, auditHeader.map(() => "---"), ...auditRows]
  .map((row) => `| ${row.join(" | ")} |`)
  .join("\n");

export async function expectReadableAuditTable(_page: Page, shell: Locator) {
  await shell.scrollIntoViewIfNeeded();
  const report = await shell.evaluate((element) => {
    const cells = [...element.querySelectorAll<HTMLTableCellElement>("tbody td")].map((cell) => {
      const range = document.createRange();
      range.selectNodeContents(cell);
      return {
        text: cell.textContent,
        lines: new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size,
        width: cell.getBoundingClientRect().width,
        overflow: cell.scrollWidth - cell.clientWidth,
      };
    });
    const bounds = element.getBoundingClientRect();
    const pane = element.closest(".chat-thread")!.getBoundingClientRect();
    return {
      cells,
      contained: bounds.left >= pane.left && bounds.right <= pane.right,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(report.contained).toBe(true);
  expect(report.overflow).toBeLessThanOrEqual(1);
  const [, bytes, hash] = report.cells;
  expect(bytes).toMatchObject({ text: "3514", lines: 1 });
  expect(hash?.text).toBe(auditHash);
  expect(hash?.lines).toBeGreaterThan(1);
  expect(hash?.width).toBeLessThanOrEqual(408);
  expect(hash?.overflow).toBeLessThanOrEqual(1);
}

export function expectResponsiveTableGeometry(
  geometry: ReturnType<typeof readResponsiveTableGeometry>,
  width: number,
) {
  expect(geometry).toMatchObject({
    withinPane: true,
    topAligned: true,
    headerPainted: true,
    actionBelowTable: true,
    tableStartsShell: true,
    controlHeight: width > 932 ? 32 : 40,
    visibleExpandLabel: width <= 932,
    controlsGap: width > 932 ? 0 : 4,
  });
  expect(geometry.verticalOverflow).toBeLessThanOrEqual(1);
  expect(geometry.columnWidths[0]).toBeGreaterThan(geometry.columnWidths[1]!);
  if (width > 932) {
    expect(geometry.width).toBeCloseTo(geometry.prose, 0);
    expect(geometry.compactWidths.every((value) => Math.abs(value - geometry.prose) <= 1)).toBe(
      true,
    );
    expect(geometry.denseWidth).toBeGreaterThan(geometry.prose);
    expect(geometry.denseOverflow).toBeLessThanOrEqual(1);
    expect(geometry.bottomGap).toBeGreaterThanOrEqual(20);
    expect(geometry.prose).toBeLessThanOrEqual(768);
  } else {
    expect(geometry.denseOverflow).toBeGreaterThan(0);
    if (width === 932) {
      // Landscape tables borrow spare width while keeping a centered gutter.
      expect(geometry.width).toBeGreaterThan(geometry.prose);
      expect(geometry.leadingGap).toBeGreaterThan(0);
      expect(geometry.trailingGap).toBeCloseTo(geometry.leadingGap, 0);
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
      element.querySelector(".markdown-table__actions")!.getBoundingClientRect().top -
      viewport.getBoundingClientRect().bottom,
    bottomGap: element.nextElementSibling!.getBoundingClientRect().top - rect.bottom,
    width: rect.width,
    prose: paragraph.getBoundingClientRect().width,
    withinPane: rect.left >= paneRect.left && rect.right <= paneRect.right,
    leadingGap: rect.left - paneRect.left,
    trailingGap: paneRect.right - rect.right,
    verticalOverflow: viewport.scrollHeight - viewport.clientHeight,
    columnWidths: [...cells].map((cell) => cell.getBoundingClientRect().width),
    topAligned: [...cells].every((cell) => getComputedStyle(cell).verticalAlign === "top"),
    headerPainted: table.contains(document.elementFromPoint(header.left + 4, header.top + 4)),
    actionBelowTable: action.getBoundingClientRect().top >= viewport.getBoundingClientRect().bottom,
    tableStartsShell: Math.abs(table.getBoundingClientRect().top - rect.top) <= 1,
  };
}
