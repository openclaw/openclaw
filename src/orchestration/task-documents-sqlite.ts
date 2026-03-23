import { randomUUID } from "node:crypto";
import { getStateDb } from "../infra/state-db/index.js";
import type { TaskDocument, TaskDocumentFormat } from "./types.js";

type TaskDocumentRow = {
  id: string;
  task_id: string;
  title: string | null;
  format: string;
  body: string;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
};

function rowToDocument(row: TaskDocumentRow): TaskDocument {
  return {
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    format: row.format as TaskDocumentFormat,
    body: row.body,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createTaskDocument(params: {
  taskId: string;
  title?: string;
  body?: string;
  format?: TaskDocumentFormat;
  createdBy?: string;
}): TaskDocument {
  const db = getStateDb();
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(
    `INSERT INTO op1_task_documents (id, task_id, title, format, body, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.taskId,
    params.title ?? null,
    params.format ?? "markdown",
    params.body ?? "",
    params.createdBy ?? null,
    params.createdBy ?? null,
    now,
    now,
  );

  const row = db.prepare("SELECT * FROM op1_task_documents WHERE id = ?").get(id);
  return rowToDocument(row as unknown as TaskDocumentRow);
}

export function getTaskDocument(id: string): TaskDocument | null {
  const db = getStateDb();
  const row = db.prepare("SELECT * FROM op1_task_documents WHERE id = ?").get(id);
  return row ? rowToDocument(row as unknown as TaskDocumentRow) : null;
}

export function listTaskDocuments(taskId: string): TaskDocument[] {
  const db = getStateDb();
  const rows = db
    .prepare("SELECT * FROM op1_task_documents WHERE task_id = ? ORDER BY created_at ASC")
    .all(taskId);
  return (rows as unknown as TaskDocumentRow[]).map(rowToDocument);
}

export function updateTaskDocument(
  id: string,
  patch: { title?: string; body?: string; updatedBy?: string },
): TaskDocument {
  const db = getStateDb();
  const existing = getTaskDocument(id);
  if (!existing) {
    throw new Error(`Task document not found: ${id}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const sets: string[] = ["updated_at = ?"];
  const params: Array<string | number | bigint | null> = [now];

  if (patch.title !== undefined) {
    sets.push("title = ?");
    params.push(patch.title);
  }
  if (patch.body !== undefined) {
    sets.push("body = ?");
    params.push(patch.body);
  }
  if (patch.updatedBy !== undefined) {
    sets.push("updated_by = ?");
    params.push(patch.updatedBy);
  }

  params.push(id);
  db.prepare(`UPDATE op1_task_documents SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  return getTaskDocument(id)!;
}

export function deleteTaskDocument(id: string): void {
  const db = getStateDb();
  db.prepare("DELETE FROM op1_task_documents WHERE id = ?").run(id);
}
