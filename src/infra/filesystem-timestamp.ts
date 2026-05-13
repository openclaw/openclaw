export function formatFilesystemTimestamp(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().replaceAll(":", "-");
}
