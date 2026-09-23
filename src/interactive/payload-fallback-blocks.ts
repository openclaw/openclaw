import type {
  MessagePresentationChartBlock,
  MessagePresentationTableBlock,
  MessagePresentationTableCell,
} from "./payload-structured-block-types.js";

export function renderMessagePresentationChartFallbackText(
  block: MessagePresentationChartBlock,
): string {
  const lines = [`${block.title} (${block.chartType} chart)`];
  if (block.chartType === "pie") {
    lines.push(...block.segments.map((segment) => `- ${segment.label}: ${String(segment.value)}`));
    return lines.join("\n");
  }
  if (block.xLabel) {
    lines.push(`X axis: ${block.xLabel}`);
  }
  if (block.yLabel) {
    lines.push(`Y axis: ${block.yLabel}`);
  }
  lines.push(
    ...block.series.map(
      (series) =>
        `- ${series.name}: ${block.categories
          .map((category, index) => `${category}: ${String(series.values[index])}`)
          .join("; ")}`,
    ),
  );
  return lines.join("\n");
}

function renderTableFallbackValue(value: MessagePresentationTableCell): string {
  return String(value).replace(/\s+/g, " ").trim();
}

export function renderMessagePresentationTableFallbackText(
  block: MessagePresentationTableBlock,
): string {
  const headers = block.headers.map(renderTableFallbackValue);
  const lines = [`${renderTableFallbackValue(block.caption)} (table)`];
  lines.push(
    ...block.rows.map(
      (row) =>
        `- ${row
          .map((cell, index) => `${headers[index]}: ${renderTableFallbackValue(cell)}`)
          .join("; ")}`,
    ),
  );
  return lines.join("\n");
}
