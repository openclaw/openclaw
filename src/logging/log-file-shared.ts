export const LOG_PREFIX = "openclaw";
export const LOG_SUFFIX = ".log";

export function canUseNodeFs(): boolean {
  try {
    return process.getBuiltinModule?.("fs") !== undefined;
  } catch {
    return false;
  }
}

export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
