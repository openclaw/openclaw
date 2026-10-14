import { renderTable, type TableColumn } from "../../../packages/terminal-core/src/table.js";

type StatusReportContext = {
  lines: string[];
  heading: (text: string) => string;
  width: number;
};

/** Keeps section spacing in one rendering owner. */
export function appendStatusReportHeading(context: StatusReportContext, title: string) {
  if (context.lines.length > 0) {
    context.lines.push("");
  }
  context.lines.push(context.heading(title));
}

export function appendStatusReportLines(
  context: StatusReportContext,
  title: string,
  body: string[],
) {
  appendStatusReportHeading(context, title);
  context.lines.push(...body);
}

export function appendStatusReportTable(
  context: StatusReportContext,
  title: string,
  columns: TableColumn[],
  rows: Array<Record<string, string>>,
  trailer?: string | null,
) {
  appendStatusReportHeading(context, title);
  context.lines.push(renderTable({ width: context.width, columns, rows }).trimEnd());
  if (trailer) {
    context.lines.push(trailer);
  }
}
