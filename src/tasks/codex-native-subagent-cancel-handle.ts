type CodexNativeSubagentCancelResult =
  | { found: false }
  | { found: true; cancelled: boolean; reason?: string };

const CANCEL_KEY = Symbol.for("openclaw.taskRegistry.codexNativeSubagentCancel");

export async function tryCancelCodexNativeSubagent(
  childThreadId: string,
): Promise<CodexNativeSubagentCancelResult> {
  const fn = (globalThis as Record<symbol, unknown>)[CANCEL_KEY] as
    | ((childThreadId: string) => Promise<CodexNativeSubagentCancelResult>)
    | undefined;
  if (!fn) {
    return { found: false };
  }
  return fn(childThreadId);
}
