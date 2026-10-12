export function formatIsoDate(date: Date, timeZone: "local" | "utc" = "local"): string {
  const year = timeZone === "utc" ? date.getUTCFullYear() : date.getFullYear();
  const month = (timeZone === "utc" ? date.getUTCMonth() : date.getMonth()) + 1;
  const day = timeZone === "utc" ? date.getUTCDate() : date.getDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function createDefaultUsageDateRange(date = new Date()) {
  const start = new Date(date);
  start.setDate(start.getDate() - 29);
  return { startDate: formatIsoDate(start), endDate: formatIsoDate(date) };
}

export function toggleUsageRangeSelection<T>(
  selected: T[],
  value: T,
  orderedValues: T[],
  shiftKey: boolean,
  mode: "toggle" | "append" | "replace",
): T[] {
  if (shiftKey && selected.length > 0) {
    for (const lastSelected of selected.slice(-1)) {
      const lastIndex = orderedValues.indexOf(lastSelected);
      const nextIndex = orderedValues.indexOf(value);
      if (lastIndex !== -1 && nextIndex !== -1) {
        const [start, end] =
          lastIndex < nextIndex ? [lastIndex, nextIndex] : [nextIndex, lastIndex];
        return [...new Set([...selected, ...orderedValues.slice(start, end + 1)])];
      }
    }
  }
  if (mode === "replace") {
    return selected.length === 1 && selected[0] === value ? [] : [value];
  }
  if (selected.includes(value)) {
    return selected.filter((entry) => entry !== value);
  }
  return mode === "append" ? [...selected, value] : [value];
}

export function parseToolSummary(content: string) {
  const toolCounts = new Map<string, number>();
  const nonToolLines: string[] = [];
  for (const line of content.split("\n")) {
    const match = /^\[Tool:\s*([^\]]+)\]/.exec(line.trim());
    const name = match?.[1];
    if (name) {
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      continue;
    }
    if (line.trim().startsWith("[Tool Result]")) {
      continue;
    }
    nonToolLines.push(line);
  }
  const sortedTools = Array.from(toolCounts).toSorted((a, b) => b[1] - a[1]);
  const totalCalls = sortedTools.reduce((sum, [, count]) => sum + count, 0);
  const summary =
    sortedTools.length > 0
      ? `Tools: ${sortedTools
          .map(([name, count]) => `${name}×${count}`)
          .join(", ")} (${totalCalls} calls)`
      : "";
  return {
    tools: sortedTools,
    summary,
    cleanContent: nonToolLines.join("\n").trim(),
  };
}
