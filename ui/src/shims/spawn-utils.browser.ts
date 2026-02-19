export function resolveCommandStdio() {
  return "pipe" as const;
}

export function spawnWithFallback(): never {
  throw new Error("spawnWithFallback is not available in browser builds");
}
