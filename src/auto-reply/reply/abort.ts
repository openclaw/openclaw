const ABORT_TRIGGERS = new Set(["stop", "esc", "abort", "wait", "exit"]);
const ABORT_MEMORY = new Map<string, boolean>();

export function isAbortTrigger(text?: string): boolean {
  if (!text) return false;
  const normalized = text.trim().toLowerCase();
  return ABORT_TRIGGERS.has(normalized);
}

export function getAbortMemory(key: string): boolean | undefined {
  return ABORT_MEMORY.get(key);
}

export function setAbortMemory(key: string, value: boolean): void {
  ABORT_MEMORY.set(key, value);
}
