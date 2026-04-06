type HeadingFn = (text: string) => string;

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

export function appendStatusLinesSection(params: {
  lines: string[];
  heading: HeadingFn;
  title: string;
  body: string[];
}) {
  appendStatusSectionHeading(params);
  params.lines.push(...params.body);
}

export function appendStatusTableSection<Row extends Record<string, string>>(params: {
  lines: string[];
  heading: HeadingFn;
  title: string;
  width: number;
  renderTable: (input: {
    width: number;
    columns: Array<Record<string, unknown>>;
    rows: Row[];
  }) => string;
  columns: Array<Record<string, unknown>>;
  rows: Row[];
}) {
  appendStatusSectionHeading(params);
  params.lines.push(
    params
      .renderTable({
        width: params.width,
        columns: params.columns,
        rows: params.rows,
      })
      .trimEnd(),
  );
}
