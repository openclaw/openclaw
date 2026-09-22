let pairedCardRendererCache: { stateDir: string; value: Promise<boolean> } | undefined;

export function invalidatePairedCardRendererCache(): void {
  pairedCardRendererCache = undefined;
}

/** The pairing publication owner invalidates this projection after committed mutations. */
export function readPairedCardRendererCache(
  stateDir: string,
  load: () => Promise<boolean>,
): Promise<boolean> {
  if (pairedCardRendererCache?.stateDir !== stateDir) {
    pairedCardRendererCache = { stateDir, value: load() };
  }
  return pairedCardRendererCache.value;
}
