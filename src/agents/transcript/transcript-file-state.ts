import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { appendRegularFile, appendRegularFileSync } from "../../infra/fs-safe.js";
import { privateFileStore, privateFileStoreSync } from "../../infra/private-file-store.js";
import type {
  FileEntry,
  SessionContext,
  SessionEntry,
  SessionHeader,
  SessionTreeNode,
} from "./session-transcript-contract.js";
import {
  buildSessionContext,
  CURRENT_SESSION_VERSION,
  migrateSessionEntries,
  parseSessionEntries,
} from "./session-transcript-format.js";

type BranchSummaryEntry = Extract<SessionEntry, { type: "branch_summary" }>;
type CompactionEntry = Extract<SessionEntry, { type: "compaction" }>;
type CustomEntry = Extract<SessionEntry, { type: "custom" }>;
type CustomMessageEntry = Extract<SessionEntry, { type: "custom_message" }>;
type LabelEntry = Extract<SessionEntry, { type: "label" }>;
type ModelChangeEntry = Extract<SessionEntry, { type: "model_change" }>;
type SessionInfoEntry = Extract<SessionEntry, { type: "session_info" }>;
type SessionMessageEntry = Extract<SessionEntry, { type: "message" }>;
type ThinkingLevelChangeEntry = Extract<SessionEntry, { type: "thinking_level_change" }>;

function isSessionEntry(entry: FileEntry): entry is SessionEntry {
  return entry.type !== "session";
}

function sessionHeaderVersion(header: SessionHeader | null): number {
  return typeof header?.version === "number" ? header.version : 1;
}

function generateEntryId(byId: { has(id: string): boolean }): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const id = randomUUID().slice(0, 8);
    if (!byId.has(id)) {
      return id;
    }
  }
  return randomUUID();
}

function serializeTranscriptFileEntries(entries: FileEntry[]): string {
  return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

export class TranscriptFileState {
  readonly header: SessionHeader | null;
  readonly entries: SessionEntry[];
  readonly migrated: boolean;
  private readonly byId = new Map<string, SessionEntry>();
  private readonly labelsById = new Map<string, string>();
  private readonly labelTimestampsById = new Map<string, string>();
  private leafId: string | null = null;

  constructor(params: {
    header: SessionHeader | null;
    entries: SessionEntry[];
    migrated?: boolean;
  }) {
    this.header = params.header;
    this.entries = [...params.entries];
    this.migrated = params.migrated === true;
    this.rebuildIndex();
  }

  private rebuildIndex(): void {
    this.byId.clear();
    this.labelsById.clear();
    this.labelTimestampsById.clear();
    this.leafId = null;
    for (const entry of this.entries) {
      this.byId.set(entry.id, entry);
      this.leafId = entry.id;
      if (entry.type === "label") {
        if (entry.label) {
          this.labelsById.set(entry.targetId, entry.label);
          this.labelTimestampsById.set(entry.targetId, entry.timestamp);
        } else {
          this.labelsById.delete(entry.targetId);
          this.labelTimestampsById.delete(entry.targetId);
        }
      }
    }
  }

  getCwd(): string {
    return this.header?.cwd ?? process.cwd();
  }

  getHeader(): SessionHeader | null {
    return this.header;
  }

  getEntries(): SessionEntry[] {
    return [...this.entries];
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  getLeafEntry(): SessionEntry | undefined {
    return this.leafId ? this.byId.get(this.leafId) : undefined;
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.byId.get(id);
  }

  getChildren(parentId: string): SessionEntry[] {
    return this.entries.filter((entry) => entry.parentId === parentId);
  }

  getLabel(id: string): string | undefined {
    return this.labelsById.get(id);
  }

  getTree(): SessionTreeNode[] {
    const nodeById = new Map<string, SessionTreeNode>();
    const roots: SessionTreeNode[] = [];
    for (const entry of this.entries) {
      nodeById.set(entry.id, {
        entry,
        children: [],
        label: this.labelsById.get(entry.id),
        labelTimestamp: this.labelTimestampsById.get(entry.id),
      });
    }

    for (const entry of this.entries) {
      const node = nodeById.get(entry.id);
      if (!node) {
        continue;
      }
      if (entry.parentId === null || entry.parentId === entry.id) {
        roots.push(node);
        continue;
      }
      const parent = nodeById.get(entry.parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }

    const stack = [...roots];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) {
        continue;
      }
      node.children.sort((a, b) => Date.parse(a.entry.timestamp) - Date.parse(b.entry.timestamp));
      stack.push(...node.children);
    }
    return roots;
  }

  getSessionName(): string | undefined {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (entry.type === "session_info") {
        return entry.name?.trim() || undefined;
      }
    }
    return undefined;
  }

  getBranch(fromId?: string): SessionEntry[] {
    const branch: SessionEntry[] = [];
    let current = (fromId ?? this.leafId) ? this.byId.get((fromId ?? this.leafId)!) : undefined;
    while (current) {
      branch.push(current);
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }
    branch.reverse();
    return branch;
  }

  buildSessionContext(): SessionContext {
    return buildSessionContext(this.entries, this.leafId, this.byId);
  }

  branch(branchFromId: string): void {
    if (!this.byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchFromId;
  }

  resetLeaf(): void {
    this.leafId = null;
  }

  appendMessage(message: SessionMessageEntry["message"]): SessionMessageEntry {
    return this.appendEntry({
      type: "message",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      message,
    });
  }

  appendThinkingLevelChange(thinkingLevel: string): ThinkingLevelChangeEntry {
    return this.appendEntry({
      type: "thinking_level_change",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      thinkingLevel,
    });
  }

  appendModelChange(provider: string, modelId: string): ModelChangeEntry {
    return this.appendEntry({
      type: "model_change",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      provider,
      modelId,
    });
  }

  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: unknown,
    fromHook?: boolean,
  ): CompactionEntry {
    return this.appendEntry({
      type: "compaction",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      fromHook,
    });
  }

  appendCustomEntry(customType: string, data?: unknown): CustomEntry {
    return this.appendEntry({
      type: "custom",
      customType,
      data,
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
    });
  }

  appendSessionInfo(name: string): SessionInfoEntry {
    return this.appendEntry({
      type: "session_info",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      name: name.trim(),
    });
  }

  appendCustomMessageEntry(
    customType: string,
    content: CustomMessageEntry["content"],
    display: boolean,
    details?: unknown,
  ): CustomMessageEntry {
    return this.appendEntry({
      type: "custom_message",
      customType,
      content,
      display,
      details,
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
    });
  }

  appendLabelChange(targetId: string, label: string | undefined): LabelEntry {
    if (!this.byId.has(targetId)) {
      throw new Error(`Entry ${targetId} not found`);
    }
    return this.appendEntry({
      type: "label",
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      targetId,
      label,
    });
  }

  branchWithSummary(
    branchFromId: string | null,
    summary: string,
    details?: unknown,
    fromHook?: boolean,
  ): BranchSummaryEntry {
    if (branchFromId !== null && !this.byId.has(branchFromId)) {
      throw new Error(`Entry ${branchFromId} not found`);
    }
    this.leafId = branchFromId;
    return this.appendEntry({
      type: "branch_summary",
      id: generateEntryId(this.byId),
      parentId: branchFromId,
      timestamp: new Date().toISOString(),
      fromId: branchFromId ?? "root",
      summary,
      details,
      fromHook,
    });
  }

  private appendEntry<T extends SessionEntry>(entry: T): T {
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    if (entry.type === "label") {
      if (entry.label) {
        this.labelsById.set(entry.targetId, entry.label);
        this.labelTimestampsById.set(entry.targetId, entry.timestamp);
      } else {
        this.labelsById.delete(entry.targetId);
        this.labelTimestampsById.delete(entry.targetId);
      }
    }
    return entry;
  }
}

export async function readTranscriptFileState(sessionFile: string): Promise<TranscriptFileState> {
  const raw = await fs.readFile(sessionFile, "utf-8");
  const fileEntries = parseSessionEntries(raw);
  const headerBeforeMigration =
    fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  const migrated = sessionHeaderVersion(headerBeforeMigration) < CURRENT_SESSION_VERSION;
  migrateSessionEntries(fileEntries);
  const header =
    fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  const entries = fileEntries.filter(isSessionEntry);
  return new TranscriptFileState({ header, entries, migrated });
}

export function readTranscriptFileStateSync(sessionFile: string): TranscriptFileState {
  const raw = fsSync.readFileSync(sessionFile, "utf-8");
  const fileEntries = parseSessionEntries(raw);
  const headerBeforeMigration =
    fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  const migrated = sessionHeaderVersion(headerBeforeMigration) < CURRENT_SESSION_VERSION;
  migrateSessionEntries(fileEntries);
  const header =
    fileEntries.find((entry): entry is SessionHeader => entry.type === "session") ?? null;
  const entries = fileEntries.filter(isSessionEntry);
  return new TranscriptFileState({ header, entries, migrated });
}

export async function writeTranscriptFileAtomic(
  filePath: string,
  entries: Array<SessionHeader | SessionEntry>,
): Promise<void> {
  await privateFileStore(path.dirname(filePath)).writeText(
    path.basename(filePath),
    serializeTranscriptFileEntries(entries),
  );
}

export function writeTranscriptFileAtomicSync(
  filePath: string,
  entries: Array<SessionHeader | SessionEntry>,
): void {
  privateFileStoreSync(path.dirname(filePath)).writeText(
    path.basename(filePath),
    serializeTranscriptFileEntries(entries),
  );
}

export async function persistTranscriptStateMutation(params: {
  sessionFile: string;
  state: TranscriptFileState;
  appendedEntries: SessionEntry[];
}): Promise<void> {
  if (params.appendedEntries.length === 0 && !params.state.migrated) {
    return;
  }
  if (params.state.migrated) {
    await writeTranscriptFileAtomic(params.sessionFile, [
      ...(params.state.header ? [params.state.header] : []),
      ...params.state.entries,
    ]);
    return;
  }
  await appendRegularFile({
    filePath: params.sessionFile,
    content: `${params.appendedEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    rejectSymlinkParents: true,
  });
}

export function persistTranscriptStateMutationSync(params: {
  sessionFile: string;
  state: TranscriptFileState;
  appendedEntries: SessionEntry[];
}): void {
  if (params.appendedEntries.length === 0 && !params.state.migrated) {
    return;
  }
  if (params.state.migrated) {
    writeTranscriptFileAtomicSync(params.sessionFile, [
      ...(params.state.header ? [params.state.header] : []),
      ...params.state.entries,
    ]);
    return;
  }
  appendRegularFileSync({
    filePath: params.sessionFile,
    content: `${params.appendedEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    rejectSymlinkParents: true,
  });
}
