// Stores meeting-capture transcripts in the shared SQLite state database.
import fs from "node:fs/promises";
import path from "node:path";
import type { TranscriptUtterance as ProjectedTranscriptUtterance } from "../../packages/gateway-protocol/src/schema/transcripts.js";
import { sha256File, sha256Hex } from "../infra/crypto-digest.js";
import { ensureAbsoluteDirectory } from "../infra/fs-safe.js";
import { executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import { iterateOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerOperations } from "../state/openclaw-state-worker-contract.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
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
import { TranscriptsSummaryChangedError } from "./store-errors.js";
import { transcriptJsonlDigest, writeTranscriptJsonlArtifact } from "./store-export-jsonl.js";
import {
  assertTranscriptExportPathAvailable,
  hasAliasedCanonicalTranscriptExportPathOwner,
} from "./store-export-ownership.js";
import {
  parseTranscriptExportManifest,
  parseTranscriptPendingExports,
} from "./store-export-state.js";
import * as read from "./store-read.js";
import {
  assertMeetingTranscriptSelectorAvailableInDatabase,
  markMeetingTranscriptPendingExportsInDatabase,
  updateMeetingTranscriptExportManifestInDatabase,
  writeMeetingTranscriptSessionInDatabase,
  writeMeetingTranscriptSummaryInDatabase,
} from "./store-sqlite-write.js";
import {
  appendMeetingTranscriptUtterance,
  meetingTranscriptDb,
  meetingTranscriptSessionQuery,
  sessionFromRow,
  transcriptSummaryInputRevisionFromRow,
  readStoredTranscriptSummaryRevision,
} from "./store-sqlite.js";
import type * as StoreTypes from "./store-types.js";
import type { TranscriptReadRequests } from "./store-worker-contract.js";
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

  private transaction(
    operationLabel: string,
    operation: (database: OpenClawStateDatabase) => void,
  ): void {
    runOpenClawStateWriteTransaction(operation, this.databaseOptions, { operationLabel });
  }

  sessionDir(session: TranscriptSessionDescriptor): string {
    return path.join(this.exportRootDir, transcriptSessionSelector(session));
  }

  private async readWorker<Key extends keyof TranscriptReadRequests>(
    type: Key,
    request: OpenClawStateWorkerOperations[Key]["input"],
  ): Promise<TranscriptReadRequests[Key]["output"]> {
    const context = captureOpenClawStateWorkerContext(this.databaseOptions);
    const input = structuredClone(request);
    input.readOnly = this.databaseOptions.readOnly;
    const result = await executeOpenClawStateWorker<Key>(context, { type, input });
    if (!result.ok) {
      throw new read.TranscriptLibraryError(
        result.error.type,
        result.error.message,
        result.error.maxBytes,
      );
    }
    return result.value;
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

  private readExportOwnership(session: TranscriptSessionDescriptor): {
    manifest: Record<string, string>;
    pending: Set<string>;
  } {
    const database = this.database();
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      meetingTranscriptSessionQuery(database.db, session).select([
        "export_manifest_json",
        "export_pending_json",
      ]),
    );
    return row
      ? {
          manifest: parseTranscriptExportManifest(row.export_manifest_json),
          pending: parseTranscriptPendingExports(row.export_pending_json),
        }
      : { manifest: {}, pending: new Set() };
  }

  private async readSessionByIdentity({
    sessionId,
    startedAt,
  }: TranscriptSessionDescriptor): Promise<TranscriptSessionDescriptor | undefined> {
    return this.readWorker("transcripts.session", {
      params: { session: { sessionId, startedAt } },
    });
  }

  private async expectedExportHashes(
    session: TranscriptSessionDescriptor,
  ): Promise<Record<string, string>> {
    const storedSession = await this.readSessionByIdentity(session);
    if (!storedSession) {
      return {};
    }
    const hashes: Record<string, string> = {
      "metadata.json": sha256Hex(`${JSON.stringify(storedSession, null, 2)}\n`),
      "transcript.jsonl": transcriptJsonlDigest(this.database().db, storedSession),
    };
    const summary = await this.readSummary(storedSession);
    if (summary.summary) {
      hashes["summary.json"] = sha256Hex(`${JSON.stringify(summary.summary, null, 2)}\n`);
    }
    if (summary.markdown !== undefined) {
      hashes["summary.md"] = sha256Hex(normalizeExportText(summary.markdown));
    }
    return hashes;
  }

  private updateExportManifest(
    session: TranscriptSessionDescriptor,
    exportedHashes: Readonly<Record<string, string>>,
    removedExports: ReadonlySet<string> = new Set(),
  ): void {
    this.transaction("meeting-transcripts.export.record", ({ db }) => {
      updateMeetingTranscriptExportManifestInDatabase(db, session, exportedHashes, removedExports);
    });
  }

  private markPendingExports(session: TranscriptSessionDescriptor, fileNames: string[]): void {
    this.transaction("meeting-transcripts.export.pending", ({ db }) => {
      markMeetingTranscriptPendingExportsInDatabase(db, session, fileNames);
    });
  }

  private async assertExportDestinationOwned(
    session: TranscriptSessionDescriptor,
    sessionDir = this.sessionDir(session),
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
    const ownership = this.readExportOwnership(session);
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
      expectedHashes ??= await this.expectedExportHashes(session);
      if (expectedHashes[canonicalName] !== actualHash) {
        throw new Error(
          `legacy transcript artifacts require migration before writing ${sessionDir}; run openclaw doctor --fix`,
        );
      }
      repairedHashes[canonicalName] = actualHash;
    }
    if (Object.keys(repairedHashes).length > 0) {
      this.updateExportManifest(session, repairedHashes);
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

  assertSummarySnapshotCurrent(
    session: TranscriptSessionDescriptor,
    snapshot: StoreTypes.TranscriptSummarySnapshot,
    allowAppends: boolean,
  ): void {
    const { db } = this.database();
    const row = executeSqliteQueryTakeFirstSync(
      db,
      meetingTranscriptSessionQuery(db, session).selectAll(),
    );
    if (
      !row ||
      (allowAppends && row.stopped_at !== null) ||
      row.next_utterance_seq < snapshot.nextSequence ||
      transcriptSummaryInputRevisionFromRow({
        ...row,
        ...(allowAppends ? { next_utterance_seq: snapshot.nextSequence } : {}),
      }) !== snapshot.inputRevision ||
      (readStoredTranscriptSummaryRevision(db, session) ?? "") !== snapshot.summaryRevision
    ) {
      throw new TranscriptsSummaryChangedError();
    }
  }

  async listReadEntries(options: read.TranscriptReadOptions) {
    return read.queryTranscriptReadEntries(this.database().db, options);
  }

  async writeSession(
    session: TranscriptSessionDescriptor,
    condition?: { expectedInputRevision?: string; assertCurrent?: () => void },
  ): Promise<void> {
    ensureMeetingTranscriptsSchema(this.databaseOptions);
    const selector = transcriptSessionSelector(session);
    // Classify the existing constraint before export checks, then recheck under write admission.
    assertMeetingTranscriptSelectorAvailableInDatabase(this.database().db, session, selector);
    if (
      !(await this.readSessionByIdentity(session)) &&
      !(await hasAliasedCanonicalTranscriptExportPathOwner({
        session,
        exportRootDir: this.exportRootDir,
        databaseOptions: this.databaseOptions,
      }))
    ) {
      await this.assertExportDestinationOwned(session);
      const legacySelector = legacyTranscriptSessionSelector(session);
      if (legacySelector !== undefined) {
        const legacySessionDir = path.join(this.exportRootDir, legacySelector);
        const legacyRow = this.readCanonicalSelectorRow(this.database().db, legacySelector);
        const legacyOwner = legacyRow ? sessionFromRow(legacyRow) : undefined;
        const legacyPathIsCanonical =
          legacyOwner !== undefined &&
          path.resolve(this.sessionDir(legacyOwner)) === path.resolve(legacySessionDir);
        if (
          path.resolve(legacySessionDir) !== path.resolve(this.sessionDir(session)) &&
          !legacyPathIsCanonical
        ) {
          await this.assertExportDestinationOwned(session, legacySessionDir);
        }
      }
    }
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
    const now = Date.now();
    this.transaction("meeting-transcripts.session.write", ({ db: database }) => {
      condition?.assertCurrent?.();
      writeMeetingTranscriptSessionInDatabase(database, {
        session,
        sessionValues,
        now,
        expectedInputRevision: condition?.expectedInputRevision,
      });
    });
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

  private readCanonicalSelectorRow(database: OpenClawStateDatabase["db"], selector: string) {
    return executeSqliteQueryTakeFirstSync(
      database,
      meetingTranscriptDb(database)
        .selectFrom("meeting_transcript_sessions")
        .selectAll()
        .where("selector", "=", selector),
    );
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
  ): Promise<void> {
    const metadataJson = utterance.metadata ? JSON.stringify(utterance.metadata) : null;
    const now = Date.now();
    ensureMeetingTranscriptsSchema(this.databaseOptions);
    this.transaction("meeting-transcripts.utterance.append", ({ db: database }) =>
      appendMeetingTranscriptUtterance({ database, metadataJson, now, session, utterance }),
    );
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
    expectedInputRevision?: string,
    assertCurrent?: () => void,
  ): Promise<string> {
    const summaryJson = JSON.stringify(summary);
    const markdown = renderTranscriptsMarkdown(summary);
    const summaryValues = {
      generated_at: summary.generatedAt,
      summary_json: summaryJson,
      markdown,
      utterance_count: summary.utteranceCount,
    };
    ensureMeetingTranscriptsSchema(this.databaseOptions);
    this.transaction("meeting-transcripts.summary.write", ({ db: database }) => {
      assertCurrent?.();
      writeMeetingTranscriptSummaryInDatabase(
        database,
        session,
        summaryValues,
        expectedInputRevision,
      );
    });
    return path.join(this.sessionDir(session), "summary.md");
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
    const session =
      typeof sessionOrSelector === "string"
        ? await this.readSession(sessionOrSelector)
        : await this.readSessionByIdentity(sessionOrSelector);
    if (!session) {
      const selector =
        typeof sessionOrSelector === "string" ? sessionOrSelector : sessionOrSelector.sessionId;
      throw new Error(`transcripts session not found: ${selector}`);
    }
    return await withOpenClawStateLease(
      {
        scope: "meeting-transcript.export",
        key: transcriptSessionExportKey(session),
        database: { scope: "shared", options: this.databaseOptions },
        leaseMs: 60_000,
        waitMs: 10_000,
        leaseLabel: "meeting transcript export lease",
        operationLabel: "meeting-transcripts.export.lease",
      },
      async () => await this.materializeSessionArtifactsOwned(session, kind),
    );
  }

  private async materializeSessionArtifactsOwned(
    session: TranscriptSessionDescriptor,
    kind: StoreTypes.TranscriptArtifactKind,
  ): Promise<StoreTypes.MaterializedTranscriptArtifacts> {
    const sessionDir = this.sessionDir(session);
    const includeTranscript = kind === "all" || kind === "transcript";
    const includeSummary = kind === "all" || kind === "summary";
    const storedSummary = includeSummary ? await this.readSummary(session) : {};
    const exportedHashes: Record<string, string> = {};
    const removedExports = new Set<string>();
    await assertTranscriptExportPathAvailable({
      session,
      exportRootDir: this.exportRootDir,
      databaseOptions: this.databaseOptions,
    });
    await this.assertExportDestinationOwned(session);
    const pendingFiles = [
      "metadata.json",
      ...(includeTranscript ? ["transcript.jsonl"] : []),
      ...(includeSummary ? ["summary.json", "summary.md"] : []),
    ];
    this.markPendingExports(session, pendingFiles);
    const ensured = await ensureAbsoluteDirectory(sessionDir, {
      mode: 0o700,
      scopeLabel: "transcript export directory",
    });
    if (!ensured.ok) {
      throw ensured.error;
    }
    // Every export starts with identity metadata, so even an interrupted partial
    // materialization remains inspectable by Doctor without guessing its owner.
    exportedHashes["metadata.json"] = await writeTranscriptArtifact(
      sessionDir,
      "metadata.json",
      `${JSON.stringify(session, null, 2)}\n`,
    );
    if (includeTranscript) {
      exportedHashes["transcript.jsonl"] = await writeTranscriptJsonlArtifact({
        sessionDir,
        session,
        databaseOptions: this.databaseOptions,
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
        if (content === undefined) {
          await removeTranscriptArtifact(sessionDir, fileName);
          removedExports.add(fileName);
        } else {
          exportedHashes[fileName] = await writeTranscriptArtifact(sessionDir, fileName, content);
        }
      }
    }
    this.updateExportManifest(session, exportedHashes, removedExports);
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
