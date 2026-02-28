import os from "node:os";

let cachedPromise: Promise<string> | null = null;

function fallbackHostName() {
  return (
    os
      .hostname()
      .replace(/\.local$/i, "")
      .trim() || "openclaw"
  );
}

export async function getMachineDisplayName(): Promise<string> {
  if (cachedPromise) {
    return cachedPromise;
  }
  cachedPromise = Promise.resolve(fallbackHostName());
  return cachedPromise;
}
