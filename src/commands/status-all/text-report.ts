import type { RenderTableOptions, TableColumn } from "../../../packages/terminal-core/src/table.js";

type HeadingFn = (text: string) => string;
type TableRenderer = (input: RenderTableOptions) => string;

/** Render-ready section model used by `status --all` text assembly. */
export type StatusReportSection =
  | {
      kind: "lines";
      title: string;
      body: string[];
      skipIfEmpty?: boolean;
    }
  | {
      kind: "table";
      title: string;
      width: number;
      renderTable: TableRenderer;
      columns: readonly TableColumn[];
      rows: Array<Record<string, string>>;
      trailer?: string | null;
      skipIfEmpty?: boolean;
    }
  | {
      kind: "raw";
      body: string[];
      skipIfEmpty?: boolean;
    };

/** Appends a styled section heading, inserting the blank separator when needed. */
export function appendStatusSectionHeading(params: {
  lines: string[];
  heading: HeadingFn;
  title: string;
}) {
  if (params.lines.length > 0) {
    params.lines.push("");
  }
  params.lines.push(params.heading(params.title));
}

function appendStatusLinesSection(params: {
  lines: string[];
  heading: HeadingFn;
  title: string;
  body: string[];
}) {
  appendStatusSectionHeading(params);
  params.lines.push(...params.body);
}

function appendStatusTableSection<Row extends Record<string, string>>(params: {
  lines: string[];
  heading: HeadingFn;
  title: string;
  width: number;
  renderTable: (input: { width: number; columns: TableColumn[]; rows: Row[] }) => string;
  columns: readonly TableColumn[];
  rows: Row[];
}) {
  appendStatusSectionHeading(params);
  params.lines.push(
    params
      .renderTable({
        width: params.width,
        columns: [...params.columns],
        rows: params.rows,
      })
      .trimEnd(),
  );
}

/**
 * Appends mixed raw, line, and table sections in order, honoring `skipIfEmpty`
 * before headings so optional sections do not leave blank output gaps.
 */
export function appendStatusReportSections(params: {
  lines: string[];
  heading: HeadingFn;
  sections: StatusReportSection[];
}) {
  for (const section of params.sections) {
    if (section.kind === "raw") {
      if (section.skipIfEmpty && section.body.length === 0) {
        continue;
      }
      // Raw sections are already formatted by their caller, so they bypass the
      // heading/separator path used by named sections.
      params.lines.push(...section.body);
      continue;
    }
    if (section.kind === "lines") {
      if (section.skipIfEmpty && section.body.length === 0) {
        continue;
      }
      appendStatusLinesSection({
        lines: params.lines,
        heading: params.heading,
        title: section.title,
        body: section.body,
      });
      continue;
    }
    if (section.skipIfEmpty && section.rows.length === 0) {
      continue;
    }
    appendStatusTableSection({
      lines: params.lines,
      heading: params.heading,
      title: section.title,
      width: section.width,
      renderTable: section.renderTable,
      columns: section.columns,
      rows: section.rows,
    });
    if (section.trailer) {
      // Table trailers belong directly under their table, before the next
      // section heading inserts a separator.
      params.lines.push(section.trailer);
    }
  }
}
