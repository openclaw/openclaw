import { colorize, isRich, theme } from "../terminal/theme.js";

const formatKv = (line: string, rich: boolean) => {
  const idx = line.indexOf(": ");
  if (idx <= 0) {
    return colorize(rich, theme.muted, line);
  }
  const key = line.slice(0, idx);
  const value = line.slice(idx + 2);

  const valueColor =
    key === "Gateway target" || key === "Config"
      ? theme.command
      : key === "Source"
        ? theme.muted
        : theme.info;

  return `${colorize(rich, theme.muted, `${key}:`)} ${colorize(rich, valueColor, value)}`;
};

export function formatHealthCheckFailure(err: unknown, opts: { rich?: boolean } = {}): string {
  const rich = opts.rich ?? isRich();
  const raw = String(err);
  const message = err instanceof Error ? err.message : raw;

  if (!rich) {
    return `Health check failed: ${raw}`;
  }

  const lines = message
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);
  const detailsIdx = lines.findIndex((l) => l.startsWith("Gateway target: "));

  const summaryLines = (detailsIdx >= 0 ? lines.slice(0, detailsIdx) : lines)
    .map((l) => l.trim())
    .filter(Boolean);
  const detailLines = detailsIdx >= 0 ? lines.slice(detailsIdx) : [];

  const summary = summaryLines.length > 0 ? summaryLines.join(" ") : message;
  const header = colorize(rich, theme.error.bold, "Health check failed");

  const out: string[] = [`${header}: ${summary}`];
  for (const line of detailLines) {
    out.push(`  ${formatKv(line, rich)}`);
  }
  return out.join("\n");
}
