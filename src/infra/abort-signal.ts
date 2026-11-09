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

/** Resolves on abort or when `until` settles; passing the source releases abandoned listeners. */
export async function waitForAbortSignal(
  signal?: AbortSignal,
  until?: Promise<unknown>,
): Promise<void> {
  let onAbort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve();
    if (!signal || signal.aborted) {
      resolve();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    await (until ? Promise.race([until, aborted]) : aborted);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
