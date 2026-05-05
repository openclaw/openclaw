import path from "node:path";

export type RewriteSessionFileForNewSessionIdParams = {
  sessionFile?: string;
  previousSessionId: string;
  nextSessionId: string;
};

export function rewriteSessionFileForNewSessionId(
  params: RewriteSessionFileForNewSessionIdParams,
): string | undefined {
  const trimmed = params.sessionFile?.trim();
  const previousSessionId = params.previousSessionId.trim();
  const nextSessionId = params.nextSessionId.trim();
  if (!trimmed || !previousSessionId || !nextSessionId) {
    return undefined;
  }

  const base = path.basename(trimmed);
  if (!base.endsWith(".jsonl")) {
    return undefined;
  }

  const withoutExt = base.slice(0, -".jsonl".length);
  if (withoutExt === previousSessionId) {
    return path.join(path.dirname(trimmed), `${nextSessionId}.jsonl`);
  }

  if (withoutExt.startsWith(`${previousSessionId}-topic-`)) {
    return path.join(
      path.dirname(trimmed),
      `${nextSessionId}${base.slice(previousSessionId.length)}`,
    );
  }

  const forkMatch = withoutExt.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}(?:Z|[+-]\d{2}(?:-\d{2})?))_(.+)$/,
  );
  if (forkMatch?.[2] === previousSessionId) {
    return path.join(path.dirname(trimmed), `${forkMatch[1]}_${nextSessionId}.jsonl`);
  }

  return undefined;
}
