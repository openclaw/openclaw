const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

function formatBytes(bytes: number): string {
  if (bytes < 0) bytes = 0;
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < UNITS.length - 1) {
    val /= 1024;
    idx++;
  }
  return idx === 0 ? `${Math.round(val)}${UNITS[idx]}` : `${val.toFixed(1)}${UNITS[idx]}`;
}

export function formatProgressBar(completed: number, total: number, width = 20): string {
  if (total <= 0) return `${"░".repeat(width)} 0%`;
  const ratio = Math.min(completed / total, 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const pct = Math.round(ratio * 100);
  return `${"█".repeat(filled)}${"░".repeat(empty)} ${pct}% • ${formatBytes(completed)}/${formatBytes(total)}`;
}

export function formatDownloadSpeed(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return "0 B/s";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  let idx = 0;
  let val = bytesPerSecond;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return idx === 0 ? `${Math.round(val)} ${units[idx]}` : `${val.toFixed(1)} ${units[idx]}`;
}

export function formatETA(remainingBytes: number, bytesPerSecond: number): string {
  if (bytesPerSecond <= 0 || remainingBytes <= 0) return "";
  const secs = Math.ceil(remainingBytes / bytesPerSecond);
  if (secs < 60) return `~${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `~${m}m ${s}s` : `~${m}m`;
}

export function formatModelPullProgress(
  status: string,
  completed?: number,
  total?: number,
): string {
  if (completed != null && total != null && total > 0) {
    const bar = formatProgressBar(completed, total);
    return `${status} ${bar}`;
  }
  return status;
}
