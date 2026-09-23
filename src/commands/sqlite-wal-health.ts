import { formatByteSize } from "@openclaw/normalization-core";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import type { SqliteWalHealth } from "../infra/sqlite-wal.js";

/** Render the maintenance owner's recorded warning without probing the database. */
export function formatSqliteWalHealthWarning(
  health: SqliteWalHealth | undefined,
): string | undefined {
  if (!health?.warning) {
    return undefined;
  }
  const bytes = (value: number | null) =>
    value === null
      ? "unknown"
      : formatByteSize(value, {
          style: "iec",
          maxUnit: "tera",
          separator: " ",
          fractionDigits: 1,
        });
  return [
    `checkpoint ${health.state}`,
    `WAL ${bytes(health.walBytes)}`,
    `database ${bytes(health.databaseBytes)}`,
    `frames ${health.checkpointedFrames ?? "unknown"}/${health.logFrames ?? "unknown"} checkpointed`,
    `last complete ${health.lastCompletedAtMs === null ? "never observed" : new Date(health.lastCompletedAtMs).toISOString()}`,
    `${health.consecutiveBlocked} consecutive blocked observations`,
    `observed ${new Date(health.observedAtMs).toISOString()}`,
    ...(health.error ? [sanitizeTerminalText(health.error)] : []),
    "Restart the Gateway gracefully with openclaw gateway restart; report with openclaw status --deep output.",
  ].join(" · ");
}
