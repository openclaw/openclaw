export function appendStatusSectionHeading(params) {
    if (params.lines.length > 0) {
        params.lines.push("");
    }
    params.lines.push(params.heading(params.title));
}
export function appendStatusLinesSection(params) {
    appendStatusSectionHeading(params);
    params.lines.push(...params.body);
}
export function appendStatusTableSection(params) {
    appendStatusSectionHeading(params);
    params.lines.push(params
        .renderTable({
        width: params.width,
        columns: [...params.columns],
        rows: params.rows,
    })
        .trimEnd());
}
export function appendStatusReportSections(params) {
    for (const section of params.sections) {
        if (section.kind === "raw") {
            if (section.skipIfEmpty && section.body.length === 0) {
                continue;
            }
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
            params.lines.push(section.trailer);
        }
    }
}
