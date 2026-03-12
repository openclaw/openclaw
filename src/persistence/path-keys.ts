import path from "node:path";

function splitResolvedPath(pathname: string): string[] {
  return path.resolve(pathname).split(path.sep).filter(Boolean);
}

export function normalizePersistencePathKey(pathname: string): string {
  return path.resolve(pathname);
}

export function inferAgentIdFromAgentPath(pathname: string): string | undefined {
  const parts = splitResolvedPath(pathname);
  const agentsIndex = parts.lastIndexOf("agents");
  if (agentsIndex < 0 || agentsIndex + 1 >= parts.length) {
    return undefined;
  }
  const agentId = parts[agentsIndex + 1];
  return agentId?.trim() ? agentId : undefined;
}

export function resolvePathRelativeToRoot(root: string, candidate: string): string | undefined {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.replace(/\\/g, "/");
}

export function normalizeMemoryDocumentPath(relativePath: string): string | undefined {
  const normalized = relativePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "");
  if (!normalized) {
    return undefined;
  }
  if (normalized === "MEMORY.md" || normalized === "memory.md") {
    return normalized;
  }
  if (!normalized.startsWith("memory/") || !normalized.endsWith(".md")) {
    return undefined;
  }
  return normalized;
}

export function isMemoryDocumentPath(relativePath: string): boolean {
  return normalizeMemoryDocumentPath(relativePath) !== undefined;
}

export function deriveSessionIdFromTranscriptPath(transcriptPath: string): string | undefined {
  const baseName = path.basename(transcriptPath, path.extname(transcriptPath)).trim();
  if (!baseName) {
    return undefined;
  }
  const topicIndex = baseName.indexOf("-topic-");
  return topicIndex > 0 ? baseName.slice(0, topicIndex) : baseName;
}
