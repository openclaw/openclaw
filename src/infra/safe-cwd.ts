// Safe process.cwd() helpers for launch paths that may run after the cwd was deleted.
export function tryProcessCwd(): string | null {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

export function resolveProcessCwdOrFallback(fallback: string): string {
  return tryProcessCwd() ?? fallback;
}
