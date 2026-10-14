export { createAbortError, racePromiseWithAbortSignal } from "../../packages/retry/src/index.js";

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  try {
    const name = "name" in error ? String(error.name) : "";
    if (name === "AbortError") {
      return true;
    }
    const message = "message" in error && typeof error.message === "string" ? error.message : "";
    return message === "This operation was aborted";
  } catch {
    return false;
  }
}

/** Resolves when the signal aborts, or immediately when no wait is needed. */
export async function waitForAbortSignal(signal?: AbortSignal): Promise<void> {
  if (!signal || signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
