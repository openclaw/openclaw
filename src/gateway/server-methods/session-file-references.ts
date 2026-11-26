import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ExactFileIdentity } from "@openclaw/fs-safe/root";
import type { OpenResult, Root } from "../../infra/fs-safe.js";
import {
  FILE_REFERENCE_LEASE_MS,
  FILE_REFERENCE_MAX_CANDIDATES,
  FILE_REFERENCE_MAX_INDEX_ENTRIES,
  FILE_REFERENCE_MAX_QUERY_BYTES,
  FILE_REFERENCE_NAMESPACE,
  FILE_REFERENCE_PROVIDER,
  type FileReference,
  type FileReferenceCapability,
  type FileReferenceResult,
} from "../../shared/file-references.js";

const EXCLUDED_DIRECTORIES = new Set(["node_modules", "dist", "coverage"]);
type IndexedFile = { relativePath: string; identity: ExactFileIdentity; tokens: string[] };
type Candidate = { reference: FileReference; opened: OpenResult };
type Match = "path" | "name" | "spoken";

function sameIdentity(left: ExactFileIdentity | undefined, right: ExactFileIdentity | undefined) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

/** Normalization affects matching only; provider-issued paths and identity stay exact. */
function spokenTokens(value: string): string[] {
  return value
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1 $2")
    .normalize("NFC")
    .toLocaleLowerCase("en-US")
    .split(/[\s/._-]+/u)
    .filter(Boolean);
}

function queryPath(raw: string): string | undefined {
  const value = raw.trim().replaceAll("\\", "/");
  if (
    !value ||
    Buffer.byteLength(value, "utf8") > FILE_REFERENCE_MAX_QUERY_BYTES ||
    // oxlint-disable-next-line eslint/no-control-regex -- Reject ASCII controls before filesystem lookup.
    /[:\u0000-\u001f\u007f]/u.test(value) ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part.startsWith("."))
  ) {
    return undefined;
  }
  return value;
}

/**
 * A metadata index and at most 20 open, unread descriptors belong to one chooser.
 * Pinned descriptors prevent inode reuse from turning a replacement into the selected object.
 * The caller re-enters session authorization on every operation; this lease grants no access.
 */
export async function createLocalFileReferenceLease(options: {
  root: Root;
  accountId: string;
  workspaceId: string;
  rootLabel: string;
  authorizationRevision: string;
  resolverRevision: string;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const rootIdentity = (await options.root.stat(".")).exactIdentity;
  if (!rootIdentity) {
    throw new Error("File reference identity unavailable");
  }
  const capability: FileReferenceCapability = {
    schemaVersion: 1,
    namespace: FILE_REFERENCE_NAMESPACE,
    providerId: FILE_REFERENCE_PROVIDER,
    accountId: options.accountId,
    workspaceId: options.workspaceId,
    rootLabel: options.rootLabel,
    authorizationRevision: options.authorizationRevision,
    resolverRevision: options.resolverRevision,
    leaseId: randomUUID(),
    leaseExpiresAt: now() + FILE_REFERENCE_LEASE_MS,
  };
  let disposed = false;
  let incomplete = false;
  let exhausted = false;
  let scannedEntries = 0;
  let index: IndexedFile[] | undefined;
  let iterator: AsyncGenerator<IndexedFile | undefined> | undefined;
  let nextEntry: IteratorResult<IndexedFile | undefined> | undefined;
  let chunk = 0;
  let page:
    | { query: string; cursor: string; remaining: { file: IndexedFile; match: Match }[] }
    | undefined;
  const candidates = new Map<string, Candidate>();
  let currentOperation = 0;
  let operationTail = Promise.resolve();
  let disposal: Promise<void> | undefined;

  function exclusive<T>(run: () => Promise<T>): Promise<T> {
    const result = operationTail.then(run);
    operationTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async function closeCandidates() {
    const previous = [...candidates.values()];
    candidates.clear();
    await Promise.all(previous.map(({ opened }) => opened[Symbol.asyncDispose]().catch(() => {})));
  }

  async function dispose() {
    if (disposal) {
      return disposal;
    }
    disposed = true;
    currentOperation += 1;
    clearTimeout(timer);
    disposal = exclusive(async () => {
      await closeCandidates();
      await iterator?.return(undefined).catch(() => {});
      index = undefined;
      page = undefined;
    });
    return disposal;
  }
  const timer = setTimeout(() => void dispose(), FILE_REFERENCE_LEASE_MS);
  timer.unref();

  async function* walk(directory: string, depth = 0): AsyncGenerator<IndexedFile | undefined> {
    try {
      for await (const entry of options.root.entries(directory, { order: "filesystem" })) {
        if (disposed) {
          return;
        }
        const relativePath = directory === "." ? entry.name : `${directory}/${entry.name}`;
        const excluded = entry.name.startsWith(".") || EXCLUDED_DIRECTORIES.has(entry.name);
        // Count skipped entries too: a directory of excluded names cannot bypass the work bound.
        yield !excluded && entry.isFile && entry.exactIdentity && relativePath.length <= 2048
          ? { relativePath, identity: entry.exactIdentity, tokens: spokenTokens(relativePath) }
          : undefined;
        if (!excluded && entry.isDirectory && !entry.isSymbolicLink) {
          if (depth < 63) {
            yield* walk(relativePath, depth + 1);
          } else {
            incomplete = true;
          }
        }
      }
    } catch {
      // Neither a denied directory's name nor its existence enters the result.
      incomplete = true;
    }
  }

  async function check(assertCurrent: () => void, operation: number) {
    assertCurrent();
    if (disposed || now() >= capability.leaseExpiresAt) {
      return "expired" as const;
    }
    if (operation !== currentOperation) {
      return "stale" as const;
    }
    if (!sameIdentity(rootIdentity, (await options.root.stat(".")).exactIdentity)) {
      return "stale" as const;
    }
    assertCurrent();
    return operation === currentOperation && !disposed ? undefined : ("stale" as const);
  }

  async function loadIndex(assertCurrent: () => void, operation: number) {
    iterator ??= walk(".");
    const entries: IndexedFile[] = [];
    for (let count = 0; count < FILE_REFERENCE_MAX_INDEX_ENTRIES; count += 1) {
      assertCurrent();
      if (disposed || operation !== currentOperation || now() >= capability.leaseExpiresAt) {
        index = undefined;
        return;
      }
      const next = nextEntry ?? (await iterator.next());
      nextEntry = undefined;
      if (next.done) {
        exhausted = true;
        break;
      }
      scannedEntries += 1;
      if (next.value) {
        entries.push(next.value);
      }
    }
    if (!exhausted) {
      nextEntry = await iterator.next();
      exhausted = nextEntry.done === true;
    }
    index = entries;
  }

  async function restartIndex() {
    await iterator?.return(undefined);
    iterator = undefined;
    nextEntry = undefined;
    index = undefined;
    exhausted = false;
    incomplete = false;
    scannedEntries = 0;
    chunk = 0;
    page = undefined;
  }

  return {
    capability,
    dispose,
    async search(
      rawQuery: string,
      cursor: string | undefined,
      assertCurrent: () => void,
    ): Promise<FileReferenceResult> {
      const operation = ++currentOperation;
      return exclusive(async (): Promise<FileReferenceResult> => {
        try {
          const stale = await check(assertCurrent, operation);
          if (stale) {
            return { status: stale };
          }
          const query = queryPath(rawQuery);
          if (!query) {
            await closeCandidates();
            return { status: "denied" };
          }
          if (cursor && (!page || page.cursor !== cursor || page.query !== query)) {
            return { status: "stale" };
          }
          await closeCandidates();
          // Only a complete first chunk can be reused for a new query. A cancelled
          // scan or a later chunk must never masquerade as the whole workspace.
          if (!cursor && (!index || chunk > 1)) {
            await restartIndex();
          }
          if (!index || (cursor && !page?.remaining.length && !exhausted)) {
            chunk += 1;
            await loadIndex(assertCurrent, operation);
          }
          const tokens = spokenTokens(query);
          const matches =
            cursor && page?.remaining.length
              ? page.remaining
              : (index ?? [])
                  .flatMap((file): { file: IndexedFile; match: Match }[] => {
                    const match =
                      file.relativePath === query
                        ? "path"
                        : path.posix.basename(file.relativePath) === query
                          ? "name"
                          : tokens.length && tokens.every((token) => file.tokens.includes(token))
                            ? "spoken"
                            : undefined;
                    return match ? [{ file, match }] : [];
                  })
                  .toSorted((a, b) => {
                    const rank = { path: 0, name: 1, spoken: 2 };
                    return (
                      rank[a.match] - rank[b.match] ||
                      (a.file.relativePath < b.file.relativePath ? -1 : 1)
                    );
                  });
          const selected = matches.slice(0, FILE_REFERENCE_MAX_CANDIDATES);
          const result: Extract<FileReferenceResult, { status: "matches" }>["candidates"] = [];
          for (const { file, match } of selected) {
            assertCurrent();
            let opened: OpenResult | undefined;
            try {
              opened = await options.root.open(file.relativePath);
              if (
                !sameIdentity(file.identity, opened.exactIdentity) ||
                disposed ||
                operation !== currentOperation
              ) {
                await opened[Symbol.asyncDispose]();
                continue;
              }
              const { leaseId: _leaseId, ...identity } = capability;
              const reference: FileReference = {
                ...identity,
                objectId: randomUUID(),
                relativePath: file.relativePath,
                displayLabel: path.posix.basename(file.relativePath),
              };
              candidates.set(reference.objectId, { reference, opened });
              result.push({ reference, match });
            } catch {
              await opened?.[Symbol.asyncDispose]().catch(() => {});
            }
          }
          const failure = await check(assertCurrent, operation);
          if (failure) {
            return { status: failure };
          }
          const remaining = matches.slice(FILE_REFERENCE_MAX_CANDIDATES);
          page =
            remaining.length || !exhausted ? { query, cursor: randomUUID(), remaining } : undefined;
          return {
            status: "matches",
            capability,
            candidates: result,
            ...(page ? { nextCursor: page.cursor } : {}),
            indexComplete: exhausted && !incomplete,
            scannedEntries,
          };
        } catch {
          return { status: "denied" };
        }
      });
    },
    async revalidate(objectId: string, assertCurrent: () => void): Promise<FileReferenceResult> {
      const operation = currentOperation;
      return exclusive(async (): Promise<FileReferenceResult> => {
        try {
          const stale = await check(assertCurrent, operation);
          if (stale) {
            return { status: stale };
          }
          const candidate = candidates.get(objectId);
          if (!candidate) {
            return { status: "denied" };
          }
          await using opened = await options.root.open(candidate.reference.relativePath);
          if (!sameIdentity(candidate.opened.exactIdentity, opened.exactIdentity)) {
            return { status: "stale" };
          }
          const failure = await check(assertCurrent, operation);
          if (
            !failure &&
            !sameIdentity(
              candidate.opened.exactIdentity,
              (await options.root.stat(candidate.reference.relativePath)).exactIdentity,
            )
          ) {
            return { status: "stale" };
          }
          assertCurrent();
          const finalFailure =
            failure ??
            (disposed || now() >= capability.leaseExpiresAt
              ? "expired"
              : operation !== currentOperation
                ? "stale"
                : undefined);
          return finalFailure
            ? { status: finalFailure }
            : { status: "validated", reference: candidate.reference };
        } catch {
          return { status: "stale" };
        }
      });
    },
  };
}
