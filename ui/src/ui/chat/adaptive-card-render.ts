/**
 * Lightweight Adaptive Card renderer for Lit-based web UI.
 *
 * Covers the most common card elements without pulling in the full
 * `adaptivecards` npm package (~60 KB). Unknown element types are
 * silently skipped.
 */

import { html, nothing, type TemplateResult } from "lit";
import type { ParsedAdaptiveCard } from "./adaptive-card-parse.ts";

type Element = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Render a parsed adaptive card as a Lit TemplateResult. */
export function renderAdaptiveCard(
  parsed: ParsedAdaptiveCard,
): TemplateResult {
  const { card } = parsed;
  return html`
    <div class="ac-card">
      ${renderElements(card.body)}
      ${card.actions?.length ? renderActions(card.actions as Element[]) : nothing}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Element dispatch
// ---------------------------------------------------------------------------

function renderElements(items: unknown[]): TemplateResult[] {
  const results: TemplateResult[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const el = item as Element;
    const rendered = renderElement(el);
    if (rendered !== nothing) {
      results.push(rendered as TemplateResult);
    }
  }
  return results;
}

function renderElement(el: Element): TemplateResult | typeof nothing {
  const type = typeof el.type === "string" ? el.type : "";
  switch (type) {
    case "TextBlock":
      return renderTextBlock(el);
    case "FactSet":
      return renderFactSet(el);
    case "ColumnSet":
      return renderColumnSet(el);
    case "Column":
      return renderColumn(el);
    case "Container":
      return renderContainer(el);
    case "Image":
      return renderImage(el);
    case "Table":
      return renderTable(el);
    default:
      // Unknown element — skip silently per spec.
      return nothing;
  }
}

// ---------------------------------------------------------------------------
// Element renderers
// ---------------------------------------------------------------------------

function renderTextBlock(el: Element): TemplateResult {
  const text = String(el.text ?? "");
  const weight = el.weight === "Bolder" ? "ac-bold" : "";
  const isSubtle = el.isSubtle === true ? "ac-subtle" : "";
  const sizeClass = sizeToClass(el.size);
  const wrapClass = el.wrap === false ? "ac-nowrap" : "";

  return html`<div class="ac-text ${weight} ${isSubtle} ${sizeClass} ${wrapClass}">
    ${text}
  </div>`;
}

function renderFactSet(el: Element): TemplateResult {
  const facts = Array.isArray(el.facts) ? (el.facts as Element[]) : [];
  return html`
    <dl class="ac-factset">
      ${facts.map(
        (f) => html`
          <dt class="ac-factset__key">${String(f.title ?? "")}</dt>
          <dd class="ac-factset__val">${String(f.value ?? "")}</dd>
        `,
      )}
    </dl>
  `;
}

function renderColumnSet(el: Element): TemplateResult {
  const columns = Array.isArray(el.columns)
    ? (el.columns as Element[])
    : [];
  return html`
    <div class="ac-columnset">
      ${columns.map((col) => renderElement({ type: "Column", ...col }))}
    </div>
  `;
}

function renderColumn(el: Element): TemplateResult {
  const items = Array.isArray(el.items) ? el.items : [];
  const width = typeof el.width === "string" ? el.width : "auto";
  // Map AC width values to flex style
  const flex =
    width === "stretch"
      ? "1 1 0%"
      : width === "auto"
        ? "0 0 auto"
        : `0 0 ${width}`;
  return html`
    <div class="ac-column" style="flex: ${flex}">
      ${renderElements(items as unknown[])}
    </div>
  `;
}

function renderContainer(el: Element): TemplateResult {
  const items = Array.isArray(el.items) ? el.items : [];
  return html`
    <div class="ac-container">
      ${renderElements(items as unknown[])}
    </div>
  `;
}

function renderImage(el: Element): TemplateResult {
  const url = typeof el.url === "string" ? el.url : "";
  const alt = typeof el.altText === "string" ? el.altText : "";
  const sizeClass = imageSizeClass(el.size);
  if (!url) {
    return nothing as unknown as TemplateResult;
  }
  return html`<img class="ac-image ${sizeClass}" src="${url}" alt="${alt}" />`;
}

function renderTable(el: Element): TemplateResult {
  const columns = Array.isArray(el.columns)
    ? (el.columns as Element[])
    : [];
  const rows = Array.isArray(el.rows) ? (el.rows as Element[]) : [];
  const showHeader = el.firstRowAsHeader !== false && rows.length > 0;
  const headerRow = showHeader ? (rows[0] as Element) : null;
  const bodyRows = showHeader ? rows.slice(1) : rows;

  return html`
    <table class="ac-table">
      ${
        headerRow
          ? html`<thead>
              <tr>
                ${renderTableCells(headerRow, columns, true)}
              </tr>
            </thead>`
          : nothing
      }
      <tbody>
        ${bodyRows.map(
          (row) =>
            html`<tr>
              ${renderTableCells(row as Element, columns, false)}
            </tr>`,
        )}
      </tbody>
    </table>
  `;
}

function renderTableCells(
  row: Element,
  _columns: Element[],
  isHeader: boolean,
): TemplateResult[] {
  const cells = Array.isArray(row.cells)
    ? (row.cells as Element[])
    : [];
  return cells.map((cell) => {
    const items = Array.isArray(cell.items) ? cell.items : [];
    // Simple text fallback: if cell has a single TextBlock, render text directly.
    const text = items.length === 1 && (items[0] as Element)?.type === "TextBlock"
      ? String((items[0] as Element).text ?? "")
      : null;
    const content = text !== null ? text : renderElements(items as unknown[]);
    return isHeader
      ? html`<th class="ac-table__th">${content}</th>`
      : html`<td class="ac-table__td">${content}</td>`;
  });
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function renderActions(actions: Element[]): TemplateResult {
  return html`
    <div class="ac-actions">
      ${actions.map((a) => renderAction(a))}
    </div>
  `;
}

function renderAction(a: Element): TemplateResult | typeof nothing {
  const type = typeof a.type === "string" ? a.type : "";
  const title = String(a.title ?? "");

  if (type === "Action.OpenUrl") {
    const url = typeof a.url === "string" ? a.url : "#";
    return html`<a
      class="ac-action ac-action--link"
      href="${url}"
      target="_blank"
      rel="noreferrer noopener"
    >${title}</a>`;
  }

  if (type === "Action.Submit") {
    return html`<button
      class="ac-action ac-action--submit"
      type="button"
      @click=${() => {
        console.log("[adaptive-card] Action.Submit", a.data);
      }}
    >${title}</button>`;
  }

  return nothing;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sizeToClass(size: unknown): string {
  switch (size) {
    case "Small":
      return "ac-size-sm";
    case "Medium":
      return "ac-size-md";
    case "Large":
      return "ac-size-lg";
    case "ExtraLarge":
      return "ac-size-xl";
    default:
      return "ac-size-default";
  }
}

function imageSizeClass(size: unknown): string {
  switch (size) {
    case "Small":
      return "ac-img-sm";
    case "Medium":
      return "ac-img-md";
    case "Large":
      return "ac-img-lg";
    default:
      return "ac-img-auto";
  }
}
