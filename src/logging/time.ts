/**
 * Formats the current local time as HH:MM:SS.
 * Respects the system TZ environment variable.
 */
export function formatLocalHHMMSS(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}
