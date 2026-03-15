export type EmbeddingAuthDiagnostics = {
  provider?: string;
  source?: string;
  fingerprint?: string;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

export function resolveEmbeddingAuthDiagnostics(status: {
  custom?: unknown;
}): EmbeddingAuthDiagnostics | undefined {
  const custom = readRecord(status.custom);
  const raw = readRecord(custom?.embeddingAuth);
  if (!raw) {
    return undefined;
  }
  const provider = typeof raw.provider === "string" ? raw.provider : undefined;
  const source = typeof raw.source === "string" ? raw.source : undefined;
  const fingerprint = typeof raw.fingerprint === "string" ? raw.fingerprint : undefined;
  if (!provider && !source && !fingerprint) {
    return undefined;
  }
  return { provider, source, fingerprint };
}
