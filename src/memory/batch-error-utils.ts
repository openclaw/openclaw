type BatchOutputErrorLike = {
  error?: { message?: string };
  response?: {
    body?: {
      error?: { message?: string };
    };
  };
};

export function extractBatchErrorMessage(lines: BatchOutputErrorLike[]): string | undefined {
  const first = lines.find((line) => line.error?.message || line.response?.body?.error);
  return (
    first?.error?.message ??
    (typeof first?.response?.body?.error?.message === "string"
      ? first?.response?.body?.error?.message
      : undefined)
  );
}

export function formatUnavailableBatchError(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : String(err);
  return message ? `error file unavailable: ${message}` : undefined;
}
