// Stores meeting-capture transcripts in the shared SQLite state database.
import fs from "node:fs/promises";
import path from "node:path";
import type { TranscriptUtterance as ProjectedTranscriptUtterance } from "../../packages/gateway-protocol/src/schema/transcripts.js";
import { sha256File, sha256Hex } from "../infra/crypto-digest.js";
import { ensureAbsoluteDirectory } from "../infra/fs-safe.js";
import { iterateOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-read-connection.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  withOpenClawStateLease,
  type OpenClawStateLeaseContext,
} from "../state/openclaw-state-lease.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import type {
  TranscriptSessionDescriptor,
  TranscriptSourceLocator,
  TranscriptUtterance,
} from "./provider-types.js";
import { ensureMeetingTranscriptsSchema } from "./sqlite-schema.js";
import {
  isCaseSensitiveDirectory,
  legacyTranscriptSessionSelector,
  normalizeExportText,
  removeTranscriptArtifact,
  safeTranscriptPathSegment,
  TRANSCRIPT_EXPORT_FILE_NAMES,
  transcriptSessionExportKey,
  transcriptSessionSelector,
  writeTranscriptArtifact,
} from "./store-artifacts.js";
import { TranscriptSessionConflictError, TranscriptsSummaryChangedError } from "./store-errors.js";
import { writeTranscriptJsonlArtifact } from "./store-export-jsonl.js";
import {
  assertTranscriptExportPathAvailable,
  hasAliasedCanonicalTranscriptExportPathOwner,
} from "./store-export-ownership.js";
import {
  parseTranscriptExportManifest,
  parseTranscriptPendingExports,
} from "./store-export-state.js";
import * as read from "./store-read.js";
import { sessionFromRow } from "./store-sqlite.js";
import type * as StoreTypes from "./store-types.js";
import {
  createTranscriptStoreOperation,
  type TranscriptStoreOperation,
} from "./store-worker-client.js";
import type {
  TranscriptAppendScheduler,
  TranscriptReadRequests,
  TranscriptWriteOperations,
} from "./store-worker-contract.js";
import type { TranscriptsSummary } from "./summary.js";
import { renderTranscriptsMarkdown } from "./summary.js";

export type * from "./store-types.js";
export { safeTranscriptPathSegment, transcriptSessionExportKey, transcriptSessionSelector };

type TranscriptSessionMatchEntry = StoreTypes.TranscriptsSessionEntry & { inputRevision: string };

/** Canonical meeting-capture transcript store. Files are explicit exports only. */
export class TranscriptsStore {
  constructor(
    private readonly exportRootDir: string,
    private readonly databaseOptions: Pick<
      OpenClawStateDatabaseOptions,
      "env" | "path" | "readOnly"
    > = {},
  ) {}

  private database() {
    ensureMeetingTranscriptsSchema(this.databaseOptions);
    return openOpenClawStateDatabase(this.databaseOptions);
  }

  sessionDir(session: TranscriptSessionDescriptor): string {
    return path.join(this.exportRootDir, transcriptSessionSelector(session));
  }

  private async readWorker<Key extends keyof TranscriptReadRequests>(
    type: Key,
    request: OpenClawStateWorkerOperations[Key]["input"],
  ): Promise<TranscriptReadRequests[Key]["output"]> {
    return createTranscriptStoreOperation(this.databaseOptions).read(type, request);
  }

  private entryFromSession(
    session: TranscriptSessionDescriptor,
    selector: string,
    hasSummary: boolean,
  ): StoreTypes.TranscriptsSessionEntry {
    const sessionDir = this.sessionDir(session);
    return {
      session,
      sessionDir,
      selector,
      summaryPath: path.join(sessionDir, "summary.md"),
      hasSummary,
    };
  }

  private async readExportOwnership(
    session: TranscriptSessionDescriptor,
    operation = createTranscriptStoreOperation(this.databaseOptions),
  ): Promise<{
    manifest: Record<string, string>;
    pending: Set<string>;
  }> {
    const row = await operation.read("transcripts.exportOwnership", {
      params: { session: { sessionId: session.sessionId, startedAt: session.startedAt } },
    });
    return row
      ? {
          manifest: parseTranscriptExportManifest(row.export_manifest_json),
          pending: parseTranscriptPendingExports(row.export_pending_json),
        }
      : { manifest: {}, pending: new Set() };
  }

  private async readSessionByIdentity(
    { sessionId, startedAt }: TranscriptSessionDescriptor,
    operation = createTranscriptStoreOperation(this.databaseOptions),
  ): Promise<TranscriptSessionDescriptor | undefined> {
    return operation.read("transcripts.session", {
      params: { session: { sessionId, startedAt } },
    });
  }

  private async expectedExportHashes(
    session: TranscriptSessionDescriptor,
    operation: TranscriptStoreOperation,
  ): Promise<Record<string, string>> {
    const storedSession = await this.readSessionByIdentity(session, operation);
    if (!storedSession) {
      return {};
    }
    const hashes: Record<string, string> = {
      "metadata.json": sha256Hex(`${JSON.stringify(storedSession, null, 2)}\n`),
      "transcript.jsonl": await operation.read("transcripts.exportDigest", {
        params: {
          session: { sessionId: storedSession.sessionId, startedAt: storedSession.startedAt },
        },
      }),
    };
    const summary = await operation.read("transcripts.summary", {
      params: { session: storedSession },
    });
    if (summary.summary) {
      hashes["summary.json"] = sha256Hex(`${JSON.stringify(summary.summary, null, 2)}\n`);
    }
    if (summary.markdown !== undefined) {
      hashes["summary.md"] = sha256Hex(normalizeExportText(summary.markdown));
    }
    return hashes;
  }

  private async updateExportManifest(
    session: TranscriptSessionDescriptor,
    exportedHashes: Readonly<Record<string, string>>,
    removedExports: ReadonlySet<string> = new Set(),
    operation = createTranscriptStoreOperation(this.databaseOptions),
    lease?: OpenClawStateLeaseContext,
  ): Promise<void> {
    const input = {
      session: { sessionId: session.sessionId, startedAt: session.startedAt },
      exportedHashes: { ...exportedHashes },
      removedExports: [...removedExports],
    };
    if (lease) {
      await operation.writeExport("transcripts.recordExportManifest", input, lease);
    } else {
      await operation.write("transcripts.recordExportManifest", input);
    }
  }

  private async markPendingExports(
    session: TranscriptSessionDescriptor,
    fileNames: string[],
    operation: TranscriptStoreOperation,
    lease: OpenClawStateLeaseContext,
  ): Promise<void> {
    await operation.writeExport(
      "transcripts.markPendingExports",
      { session: { sessionId: session.sessionId, startedAt: session.startedAt }, fileNames },
      lease,
    );
  }

  private async assertExportDestinationOwned(
    session: TranscriptSessionDescriptor,
    sessionDir = this.sessionDir(session),
    operation = createTranscriptStoreOperation(this.databaseOptions),
    lease?: OpenClawStateLeaseContext,
  ): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(sessionDir, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
    const ownership = await this.readExportOwnership(session, operation);
    const caseSensitive = await isCaseSensitiveDirectory(sessionDir);
    let expectedHashes: Record<string, string> | undefined;
    const repairedHashes: Record<string, string> = {};
    for (const entry of entries) {
      const canonicalName = caseSensitive ? entry.name : entry.name.toLowerCase();
      if (!TRANSCRIPT_EXPORT_FILE_NAMES.has(canonicalName)) {
        continue;
      }
      const filePath = path.join(sessionDir, entry.name);
      const stat = await fs.lstat(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(
          `legacy transcript artifacts require migration before writing ${sessionDir}; run openclaw doctor --fix`,
        );
      }
      const actualHash = await sha256File(filePath);
      if (
        ownership.manifest[canonicalName] === actualHash ||
        ownership.pending.has(canonicalName)
      ) {
        continue;
      }
      expectedHashes ??= await this.expectedExportHashes(session, operation);
      if (expectedHashes[canonicalName] !== actualHash) {
        throw new Error(
          `legacy transcript artifacts require migration before writing ${sessionDir}; run openclaw doctor --fix`,
        );
      }
      repairedHashes[canonicalName] = actualHash;
    }
    if (Object.keys(repairedHashes).length > 0) {
      await this.updateExportManifest(session, repairedHashes, new Set(), operation, lease);
    }
  }

  async listSessionEntries(): Promise<StoreTypes.TranscriptsSessionEntry[]> {
    const entries = await this.readWorker("transcripts.sessionEntries", { params: undefined });
    return entries.map(({ session, selector, hasSummary }) =>
      this.entryFromSession(session, selector, hasSummary),
    );
  }

  async *iterateReadEntries(options: read.TranscriptReadOptions = {}) {
    return yield* iterateOpenClawStateDatabaseReadOnly(
      this.database(),
      ({ db }) => read.iterateTranscriptReadEntries(db, options),
      this.databaseOptions.env,
    );
  }

  async readEntry(selector: string, purpose: read.TranscriptReadPurpose = "page") {
    return this.readWorker("transcripts.entry", { params: { selector, purpose } });
  }

  async readLatestEntry() {
    return this.readWorker("transcripts.latest", { params: undefined });
  }

  async readNotes(
    session: TranscriptSessionDescriptor,
    purpose: read.TranscriptReadPurpose = "page",
  ) {
    return this.readWorker("transcripts.notes", {
      params: {
        session: { sessionId: session.sessionId, startedAt: session.startedAt },
        purpose,
      },
    });
  }

  async readLibraryEntry(params: Parameters<typeof read.readTranscriptLibraryEntry>[1]) {
    return this.readWorker("transcripts.libraryEntry", { params });
  }

  async *iterateExport(
    selector: string,
    includeNotes: boolean,
  ): AsyncGenerator<ProjectedTranscriptUtterance, read.TranscriptExportRead | undefined> {
    return yield* iterateOpenClawStateDatabaseReadOnly(
      this.database(),
      ({ db }) => read.iterateTranscriptExport(db, selector, includeNotes),
      this.databaseOptions.env,
    );
  }

  async readRecentStoppedSession(
    source: TranscriptSourceLocator,
    stoppedAfter: string,
    stoppedBefore: string,
  ) {
    return this.readWorker("transcripts.recentStopped", {
      params: { source, stoppedAfter, stoppedBefore },
    });
  }

  async readSummaryInputRevision(
    session: TranscriptSessionDescriptor,
  ): Promise<string | undefined> {
    return this.readWorker("transcripts.summaryRevision", {
      params: {
        session: { sessionId: session.sessionId, startedAt: session.startedAt },
      },
    });
  }

  summaryScope(session: TranscriptSessionDescriptor): string {
    return JSON.stringify([
      path.resolve(
        this.databaseOptions.path ?? resolveOpenClawStateSqlitePath(this.databaseOptions.env),
      ),
      session.sessionId,
      session.startedAt,
    ]);
  }

  async readSummarySnapshot(
    session: TranscriptSessionDescriptor,
    maxUtterances: number,
  ): Promise<StoreTypes.TranscriptSummarySnapshot | undefined> {
    return this.readWorker("transcripts.summarySnapshot", {
      params: {
        session: { sessionId: session.sessionId, startedAt: session.startedAt },
        maxUtterances,
      },
    });
  }

  async listReadEntries(options: read.TranscriptReadOptions) {
    return this.readWorker("transcripts.readEntries", { params: options });
  }

  async writeSession(
    inputSession: TranscriptSessionDescriptor,
    condition?: { expectedInputRevision?: string; assertCurrent?: () => void },
  ): Promise<void> {
    const operation = createTranscriptStoreOperation(
      this.databaseOptions,
      condition?.assertCurrent,
    );
    const expectedInputRevision = condition?.expectedInputRevision;
    const session = { ...inputSession };
    const selector = transcriptSessionSelector(session);
    const sessionValues = {
      selector,
      export_key: transcriptSessionExportKey(session),
      session_slug: safeTranscriptPathSegment(session.sessionId),
      provider_id: session.source.providerId,
      title: session.title ?? null,
      source_json: JSON.stringify(session.source),
      stopped_at: session.stoppedAt ?? null,
      metadata_json: session.metadata ? JSON.stringify(session.metadata) : null,
    };
    // Classify the existing constraint before export checks, then recheck under write admission.
    const owner = await operation.read("transcripts.canonicalSessionRow", { params: { selector } });
    if (
      owner &&
      (owner.session_id !== session.sessionId || owner.started_at !== session.startedAt)
    ) {
      throw new TranscriptSessionConflictError();
    }
    if (
      !(await this.readSessionByIdentity(session, operation)) &&
      !(await hasAliasedCanonicalTranscriptExportPathOwner({
        selector: transcriptSessionSelector(session),
        exportRootDir: this.exportRootDir,
        owners: await operation.read("transcripts.exportPathOwners", {
          params: { exportKey: transcriptSessionExportKey(session) },
        }),
      }))
    ) {
      await this.assertExportDestinationOwned(session, undefined, operation);
      const legacySelector = legacyTranscriptSessionSelector(session);
      if (legacySelector !== undefined) {
        const legacySessionDir = path.join(this.exportRootDir, legacySelector);
        const legacyRow = await operation.read("transcripts.canonicalSessionRow", {
          params: { selector: legacySelector },
        });
        const legacyOwner = legacyRow ? sessionFromRow(legacyRow) : undefined;
        const legacyPathIsCanonical =
          legacyOwner !== undefined &&
          path.resolve(this.sessionDir(legacyOwner)) === path.resolve(legacySessionDir);
        if (
          path.resolve(legacySessionDir) !== path.resolve(this.sessionDir(session)) &&
          !legacyPathIsCanonical
        ) {
          await this.assertExportDestinationOwned(session, legacySessionDir, operation);
        }
      }
    }
    const result = await operation.write("transcripts.writeSession", {
      session: { sessionId: session.sessionId, startedAt: session.startedAt },
      sessionValues,
      now: Date.now(),
      expectedInputRevision,
    });
    if (!result.ok) {
      throw result.reason === "conflict"
        ? new TranscriptSessionConflictError()
        : new TranscriptsSummaryChangedError();
    }
  }

  async readSession(sessionSelector: string): Promise<TranscriptSessionDescriptor | undefined> {
    return (await this.readSessionEntry(sessionSelector))?.session;
  }

  async readSessionEntry(
    sessionSelector: string,
  ): Promise<StoreTypes.TranscriptsSessionEntry | undefined> {
    const { qualified, unqualified } = await this.matchSessionEntries(sessionSelector);
    const entries = qualified.length ? qualified : unqualified;
    if (entries.length > 1) {
      throw new Error(
        `multiple transcripts sessions match ${sessionSelector}; use one of: ${entries
          .map((entry) => entry.selector)
          .join(", ")}`,
      );
    }
    const matched = entries[0];
    if (!matched) {
      return undefined;
    }
    const { inputRevision: _inputRevision, ...entry } = matched;
    return entry;
  }

  // Return bounded evidence, not a selection policy: operators prefer qualified
  // matches, while legacy tool handles must also account for raw-ID collisions.
  async matchSessionEntries(value: string): Promise<{
    qualified: TranscriptSessionMatchEntry[];
    unqualified: TranscriptSessionMatchEntry[];
  }> {
    const matches = await this.readWorker("transcripts.matches", { params: { value } });
    const entry = (matched: (typeof matches.qualified)[number]): TranscriptSessionMatchEntry => ({
      ...this.entryFromSession(matched.session, matched.selector, matched.hasSummary),
      inputRevision: matched.inputRevision,
    });
    return { qualified: matches.qualified.map(entry), unqualified: matches.unqualified.map(entry) };
  }

  async appendUtteranceForSession(
    session: TranscriptSessionDescriptor,
    utterance: TranscriptUtterance,
    schedule?: TranscriptAppendScheduler,
  ): Promise<void> {
    const operation = createTranscriptStoreOperation(this.databaseOptions);
    const metadataJson = utterance.metadata ? JSON.stringify(utterance.metadata) : null;
    const now = Date.now();
    const speaker = utterance.speaker;
    const input: TranscriptWriteOperations["transcripts.append"]["input"] = {
      session: { sessionId: session.sessionId, startedAt: session.startedAt },
      utterance: {
        id: utterance.id,
        startedAt: utterance.startedAt,
        endedAt: utterance.endedAt,
        speaker: speaker ? { id: speaker.id, label: speaker.label } : undefined,
        text: utterance.text,
        final: utterance.final,
      },
      metadataJson,
      now,
      readOnly: this.databaseOptions.readOnly,
    };
    const append = (assertOwner?: () => void) =>
      operation.write("transcripts.append", input, assertOwner);
    await (schedule ? schedule(append) : append());
  }

  async readUtterancesForSession(
    session: TranscriptSessionDescriptor,
    options: { maxUtterances?: number } = {},
  ): Promise<TranscriptUtterance[]> {
    return this.readWorker("transcripts.utterances", {
      params: {
        session: { sessionId: session.sessionId, startedAt: session.startedAt },
        maxUtterances: options.maxUtterances,
      },
    });
  }

  async writeSummary(
    summary: TranscriptsSummary,
    session: TranscriptSessionDescriptor,
    condition?: {
      guard: StoreTypes.TranscriptSummaryWriteGuard;
      assertCurrent?: () => void;
    },
  ): Promise<string> {
    const operation = createTranscriptStoreOperation(
      this.databaseOptions,
      condition?.assertCurrent,
    );
    const identity = { sessionId: session.sessionId, startedAt: session.startedAt };
    const intendedSummaryPath = path.join(this.sessionDir(session), "summary.md");
    const guard = condition
      ? {
          inputRevision: condition.guard.inputRevision,
          nextSequence: condition.guard.nextSequence,
          summaryRevision: condition.guard.summaryRevision,
          allowAppends: condition.guard.allowAppends,
        }
      : undefined;
    const summaryJson = JSON.stringify(summary);
    const markdown = renderTranscriptsMarkdown(summary);
    const input: TranscriptWriteOperations["transcripts.writeSummary"]["input"] = {
      session: identity,
      summaryValues: {
        generated_at: summary.generatedAt,
        summary_json: summaryJson,
        markdown,
        utterance_count: summary.utteranceCount,
      },
      guard,
      readOnly: this.databaseOptions.readOnly,
    };
    const result = await operation.write("transcripts.writeSummary", input);
    if (!result.ok) {
      throw new TranscriptsSummaryChangedError();
    }
    return intendedSummaryPath;
  }

  async readSummary(
    session: TranscriptSessionDescriptor,
  ): Promise<{ summary?: TranscriptsSummary; markdown?: string }> {
    return this.readWorker("transcripts.summary", {
      params: {
        session: { sessionId: session.sessionId, startedAt: session.startedAt },
      },
    });
  }

  async materializeSessionArtifacts(
    sessionOrSelector: TranscriptSessionDescriptor | string,
    kind: StoreTypes.TranscriptArtifactKind,
  ): Promise<StoreTypes.MaterializedTranscriptArtifacts> {
    const operation = createTranscriptStoreOperation(this.databaseOptions);
    const session =
      typeof sessionOrSelector === "string"
        ? await this.readSession(sessionOrSelector)
        : await this.readSessionByIdentity(sessionOrSelector, operation);
    if (!session) {
      const selector =
        typeof sessionOrSelector === "string" ? sessionOrSelector : sessionOrSelector.sessionId;
      throw new Error(`transcripts session not found: ${selector}`);
    }
    operation.assertCurrent();
    return await withOpenClawStateLease(
      {
        scope: "meeting-transcript.export",
        key: transcriptSessionExportKey(session),
        database: { scope: "shared", options: operation.databaseOptions },
        leaseMs: 60_000,
        waitMs: 10_000,
        leaseLabel: "meeting transcript export lease",
        operationLabel: "meeting-transcripts.export.lease",
      },
      async (lease) => await this.materializeSessionArtifactsOwned(session, kind, operation, lease),
    );
  }

  private async materializeSessionArtifactsOwned(
    session: TranscriptSessionDescriptor,
    kind: StoreTypes.TranscriptArtifactKind,
    operation: TranscriptStoreOperation,
    lease: OpenClawStateLeaseContext,
  ): Promise<StoreTypes.MaterializedTranscriptArtifacts> {
    const assertOwner = () => {
      operation.assertCurrent();
      lease.assertOwned();
    };
    const sessionDir = this.sessionDir(session);
    const includeTranscript = kind === "all" || kind === "transcript";
    const includeSummary = kind === "all" || kind === "summary";
    const storedSummary = includeSummary
      ? await operation.read("transcripts.summary", { params: { session } })
      : {};
    const exportedHashes: Record<string, string> = {};
    const removedExports = new Set<string>();
    await assertTranscriptExportPathAvailable({
      selector: transcriptSessionSelector(session),
      exportRootDir: this.exportRootDir,
      collisions: await operation.read("transcripts.exportPathCollisions", {
        params: { exportKey: transcriptSessionExportKey(session) },
      }),
    });
    await this.assertExportDestinationOwned(session, sessionDir, operation, lease);
    const pendingFiles = [
      "metadata.json",
      ...(includeTranscript ? ["transcript.jsonl"] : []),
      ...(includeSummary ? ["summary.json", "summary.md"] : []),
    ];
    await this.markPendingExports(session, pendingFiles, operation, lease);
    assertOwner();
    const ensured = await ensureAbsoluteDirectory(sessionDir, {
      mode: 0o700,
      scopeLabel: "transcript export directory",
    });
    if (!ensured.ok) {
      throw ensured.error;
    }
    // Every export starts with identity metadata, so even an interrupted partial
    // materialization remains inspectable by Doctor without guessing its owner.
    assertOwner();
    exportedHashes["metadata.json"] = await writeTranscriptArtifact(
      sessionDir,
      "metadata.json",
      `${JSON.stringify(session, null, 2)}\n`,
    );
    if (includeTranscript) {
      assertOwner();
      exportedHashes["transcript.jsonl"] = await writeTranscriptJsonlArtifact({
        sessionDir,
        session,
        databaseOptions: operation.databaseOptions,
      });
    }
    if (includeSummary) {
      const summaries = {
        "summary.json": storedSummary.summary
          ? `${JSON.stringify(storedSummary.summary, null, 2)}\n`
          : undefined,
        "summary.md":
          storedSummary.markdown === undefined
            ? undefined
            : normalizeExportText(storedSummary.markdown),
      };
      for (const [fileName, content] of Object.entries(summaries)) {
        assertOwner();
        if (content === undefined) {
          await removeTranscriptArtifact(sessionDir, fileName);
          removedExports.add(fileName);
        } else {
          exportedHashes[fileName] = await writeTranscriptArtifact(sessionDir, fileName, content);
        }
      }
    }
    await this.updateExportManifest(session, exportedHashes, removedExports, operation, lease);
    return {
      sessionDir,
      metadataPath: path.join(sessionDir, "metadata.json"),
      transcriptPath: path.join(sessionDir, "transcript.jsonl"),
      summaryJsonPath: path.join(sessionDir, "summary.json"),
      summaryPath: path.join(sessionDir, "summary.md"),
      hasSummary: storedSummary.summary !== undefined || storedSummary.markdown !== undefined,
    };
  }
}
