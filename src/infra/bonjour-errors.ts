export function formatBonjourError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message || String(err);
    if (err.name && err.name !== "Error") {
      return msg === err.name ? err.name : `${err.name}: ${msg}`;
    }
    return msg;
  }
  return String(err);
}
