import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type AgentDatabaseReadCandidate = { path: string; scope?: "sibling-family" };

/** Close retained readers; a deletion also refuses later opens until the database is revived. */
export type AgentDatabaseReaderRequest =
  | { kind: "close"; candidates: AgentDatabaseReadCandidate[]; deleted: false }
  | { kind: "close"; candidates: AgentDatabaseReadCandidate[]; deleted: true; agentId: string }
  | { kind: "revive"; agentIds: string[] };

type AgentDatabaseReaderCloser = (
  candidates: readonly AgentDatabaseReadCandidate[],
) => void | Promise<void>;

const readers = resolveGlobalSingleton(Symbol.for("openclaw.agentDatabaseReaders"), () => ({
  closers: new Set<AgentDatabaseReaderCloser>(),
  deleted: new Map<string, string>(),
}));

/** Match captured read custody without inspecting files or inferring their owners. */
export function matchesAgentDatabaseReadCandidatePath(
  candidate: AgentDatabaseReadCandidate,
  pathname: string,
): boolean {
  const capturedPath = path.resolve(candidate.path);
  const resolvedPath = path.resolve(pathname);
  if (capturedPath === resolvedPath) {
    return true;
  }
  if (candidate.scope !== "sibling-family") {
    return false;
  }
  const captured = path.parse(capturedPath);
  const selected = path.parse(resolvedPath);
  return (
    selected.dir === captured.dir &&
    selected.base.startsWith(`${captured.name}.`) &&
    selected.base.endsWith(captured.ext)
  );
}

/** Every cache that retains agent database connections registers once per isolate. */
export function registerAgentDatabaseReaderCloser(closer: AgentDatabaseReaderCloser): () => void {
  readers.closers.add(closer);
  return () => {
    readers.closers.delete(closer);
  };
}

/** A deleted agent's database stays closed in this isolate until the roster admits the agent again. */
export function isDeletedAgentDatabasePath(pathname: string): boolean {
  return readers.deleted.has(path.resolve(pathname));
}

export function hasDeletedAgentDatabases(): boolean {
  return readers.deleted.size > 0;
}

/** Task admission carries the parent owner's current fences into every worker generation. */
export function captureDeletedAgentDatabaseFences(): [string, string][] {
  return [...readers.deleted];
}

export function installDeletedAgentDatabaseFences(fences: readonly [string, string][]): void {
  readers.deleted.clear();
  for (const [pathname, agentId] of fences) {
    readers.deleted.set(pathname, agentId);
  }
}

export async function applyAgentDatabaseReaderRequest(
  request: AgentDatabaseReaderRequest,
): Promise<void> {
  if (request.kind === "revive") {
    for (const [deleted, agentId] of readers.deleted) {
      if (request.agentIds.includes(agentId)) {
        readers.deleted.delete(deleted);
      }
    }
    return;
  }
  if (request.deleted) {
    for (const candidate of request.candidates) {
      readers.deleted.set(path.resolve(candidate.path), request.agentId);
    }
  }
  const results = await Promise.allSettled(
    [...readers.closers].map(async (closer) => closer(request.candidates)),
  );
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Agent database reader cleanup failed");
  }
}

function normalizeCandidates(candidates: unknown): AgentDatabaseReadCandidate[] | undefined {
  if (
    !Array.isArray(candidates) ||
    !candidates.every(
      (candidate) =>
        isRecord(candidate) &&
        typeof candidate.path === "string" &&
        (candidate.scope === undefined || candidate.scope === "sibling-family"),
    )
  ) {
    return undefined;
  }
  return candidates.map((candidate: { path: string; scope?: "sibling-family" }) =>
    candidate.scope ? { path: candidate.path, scope: candidate.scope } : { path: candidate.path },
  );
}

export function encodeAgentDatabaseReaderRequest(request: AgentDatabaseReaderRequest): string {
  if (request.kind === "revive") {
    return JSON.stringify({ revive: request.agentIds });
  }
  const candidates = normalizeCandidates(request.candidates) ?? [];
  return request.deleted
    ? JSON.stringify({ deleted: candidates, agentId: request.agentId })
    : JSON.stringify(candidates);
}

/** Worker resource keys that name agent databases; other keys belong to their worker's own closer. */
export function decodeAgentDatabaseReaderRequest(
  key: string | undefined,
): AgentDatabaseReaderRequest | undefined {
  if (key === undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    return undefined;
  }
  if (Array.isArray(parsed)) {
    const candidates = normalizeCandidates(parsed);
    return candidates ? { kind: "close", candidates, deleted: false } : undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  if ("deleted" in parsed) {
    const candidates = normalizeCandidates(parsed.deleted);
    return candidates && typeof parsed.agentId === "string" && parsed.agentId.length > 0
      ? { kind: "close", candidates, deleted: true, agentId: parsed.agentId }
      : undefined;
  }
  if (
    "revive" in parsed &&
    Array.isArray(parsed.revive) &&
    parsed.revive.every((agentId) => typeof agentId === "string")
  ) {
    return { kind: "revive", agentIds: parsed.revive };
  }
  return undefined;
}
