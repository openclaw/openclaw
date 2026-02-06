import { randomUUID } from "node:crypto";
import type { WorkItemActor } from "./types.js";

export const WORKSTREAM_NOTE_KINDS = [
  "finding",
  "decision",
  "blocker",
  "context",
  "summary",
] as const;

export type WorkstreamNoteKind = (typeof WORKSTREAM_NOTE_KINDS)[number];

export type WorkstreamNote = {
  id: string;
  workstream: string;
  itemId?: string;
  kind: WorkstreamNoteKind;
  content: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  createdBy?: WorkItemActor;
};

export type WorkstreamNotesBackend = {
  appendNote(note: Omit<WorkstreamNote, "id" | "createdAt">): WorkstreamNote;
  listNotes(
    workstream: string,
    opts?: { limit?: number; kind?: WorkstreamNoteKind },
  ): WorkstreamNote[];
  listNotesByItem(itemId: string): WorkstreamNote[];
  pruneNotes(workstream: string, keepCount: number): number;
};

const DEFAULT_NOTE_CAP = 30;
const DEFAULT_SUMMARY_MAX_CHARS = 2000;

export class WorkstreamNotesStore {
  constructor(private backend: WorkstreamNotesBackend) {}

  append(note: Omit<WorkstreamNote, "id" | "createdAt">): WorkstreamNote {
    const created = this.backend.appendNote(note);
    this.backend.pruneNotes(note.workstream, DEFAULT_NOTE_CAP);
    return created;
  }

  list(workstream: string, opts?: { limit?: number; kind?: WorkstreamNoteKind }): WorkstreamNote[] {
    return this.backend.listNotes(workstream, opts);
  }

  listByItem(itemId: string): WorkstreamNote[] {
    return this.backend.listNotesByItem(itemId);
  }

  /**
   * Format recent notes into a compact string for system prompt injection.
   */
  summarize(notes: WorkstreamNote[], opts?: { maxChars?: number }): string {
    if (notes.length === 0) return "";

    const maxChars = opts?.maxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
    const ws = notes[0]?.workstream ?? "unknown";
    const lines: string[] = [`## Workstream Notes (${ws})`];
    let totalLen = lines[0]!.length;

    for (const note of notes) {
      const datePart = note.createdAt.slice(0, 10);
      const itemPart = note.itemId ? ` (item: ${note.itemId.slice(0, 8)})` : "";
      const line = `[${datePart} ${note.kind}] ${note.content}${itemPart}`;

      if (totalLen + line.length + 1 > maxChars) break;
      lines.push(line);
      totalLen += line.length + 1;
    }

    return lines.join("\n");
  }

  prune(workstream: string, keepCount?: number): number {
    return this.backend.pruneNotes(workstream, keepCount ?? DEFAULT_NOTE_CAP);
  }
}

/**
 * SQLite-backed workstream notes using the existing work-queue database.
 * The `workstream_notes` table is created in `SqliteWorkQueueBackend.ensureSchema()`.
 */
export class SqliteWorkstreamNotesBackend implements WorkstreamNotesBackend {
  private db: import("node:sqlite").DatabaseSync;

  constructor(db: import("node:sqlite").DatabaseSync) {
    this.db = db;
  }

  appendNote(note: Omit<WorkstreamNote, "id" | "createdAt">): WorkstreamNote {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO workstream_notes (id, workstream, item_id, kind, content, metadata_json, created_at, created_by_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        note.workstream,
        note.itemId ?? null,
        note.kind,
        note.content,
        note.metadata ? JSON.stringify(note.metadata) : null,
        now,
        note.createdBy ? JSON.stringify(note.createdBy) : null,
      );
    return { ...note, id, createdAt: now };
  }

  listNotes(
    workstream: string,
    opts?: { limit?: number; kind?: WorkstreamNoteKind },
  ): WorkstreamNote[] {
    const conditions = ["workstream = ?"];
    const params: Array<string | number> = [workstream];

    if (opts?.kind) {
      conditions.push("kind = ?");
      params.push(opts.kind);
    }

    const limitClause = opts?.limit ? `LIMIT ${opts.limit}` : "LIMIT 50";
    const sql = `SELECT * FROM workstream_notes WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC ${limitClause}`;
    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map(mapNoteRow);
  }

  listNotesByItem(itemId: string): WorkstreamNote[] {
    const rows = this.db
      .prepare("SELECT * FROM workstream_notes WHERE item_id = ? ORDER BY created_at DESC")
      .all(itemId) as Array<Record<string, unknown>>;
    return rows.map(mapNoteRow);
  }

  pruneNotes(workstream: string, keepCount: number): number {
    // Keep the most recent `keepCount` notes; prefer keeping 'summary' kind longer.
    const result = this.db
      .prepare(
        `DELETE FROM workstream_notes
         WHERE workstream = ?
           AND id NOT IN (
             SELECT id FROM workstream_notes
             WHERE workstream = ?
             ORDER BY
               CASE kind WHEN 'summary' THEN 0 ELSE 1 END,
               created_at DESC
             LIMIT ?
           )`,
      )
      .run(workstream, workstream, keepCount);
    return Number(result.changes);
  }
}

/**
 * In-memory backend for testing.
 */
export class MemoryWorkstreamNotesBackend implements WorkstreamNotesBackend {
  private notes: WorkstreamNote[] = [];

  appendNote(note: Omit<WorkstreamNote, "id" | "createdAt">): WorkstreamNote {
    const created: WorkstreamNote = {
      ...note,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.notes.push(created);
    return created;
  }

  listNotes(
    workstream: string,
    opts?: { limit?: number; kind?: WorkstreamNoteKind },
  ): WorkstreamNote[] {
    let filtered = this.notes
      .filter((n) => n.workstream === workstream)
      .filter((n) => (opts?.kind ? n.kind === opts.kind : true));
    filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const limit = opts?.limit ?? 50;
    return filtered.slice(0, limit);
  }

  listNotesByItem(itemId: string): WorkstreamNote[] {
    return this.notes
      .filter((n) => n.itemId === itemId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  pruneNotes(workstream: string, keepCount: number): number {
    const wsNotes = this.notes
      .filter((n) => n.workstream === workstream)
      .sort((a, b) => {
        const kindOrder = (a.kind === "summary" ? 0 : 1) - (b.kind === "summary" ? 0 : 1);
        if (kindOrder !== 0) return kindOrder;
        return b.createdAt.localeCompare(a.createdAt);
      });

    const toKeep = new Set(wsNotes.slice(0, keepCount).map((n) => n.id));
    const before = this.notes.length;
    this.notes = this.notes.filter((n) => n.workstream !== workstream || toKeep.has(n.id));
    return before - this.notes.length;
  }
}

function mapNoteRow(row: Record<string, unknown>): WorkstreamNote {
  return {
    id: row.id as string,
    workstream: row.workstream as string,
    itemId: (row.item_id as string) ?? undefined,
    kind: row.kind as WorkstreamNoteKind,
    content: row.content as string,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json as string) : undefined,
    createdAt: row.created_at as string,
    createdBy: row.created_by_json ? JSON.parse(row.created_by_json as string) : undefined,
  };
}
