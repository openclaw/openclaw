import { randomUUID } from "node:crypto";
import { getStateDb } from "../infra/state-db/index.js";
import type { TaskAttachment } from "./types.js";

type TaskAttachmentRow = {
  id: string;
  task_id: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number | null;
  storage_path: string;
  created_by: string | null;
  created_at: number;
};

function rowToAttachment(row: TaskAttachmentRow): TaskAttachment {
  return {
    id: row.id,
    taskId: row.task_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    storagePath: row.storage_path,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function createTaskAttachment(params: {
  taskId: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  storagePath: string;
  createdBy?: string;
}): TaskAttachment {
  const db = getStateDb();
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(
    `INSERT INTO op1_task_attachments (id, task_id, filename, mime_type, size_bytes, storage_path, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    params.taskId,
    params.filename,
    params.mimeType ?? null,
    params.sizeBytes ?? null,
    params.storagePath,
    params.createdBy ?? null,
    now,
  );

  const row = db.prepare("SELECT * FROM op1_task_attachments WHERE id = ?").get(id);
  return rowToAttachment(row as unknown as TaskAttachmentRow);
}

export function listTaskAttachments(taskId: string): TaskAttachment[] {
  const db = getStateDb();
  const rows = db
    .prepare("SELECT * FROM op1_task_attachments WHERE task_id = ? ORDER BY created_at ASC")
    .all(taskId);
  return (rows as unknown as TaskAttachmentRow[]).map(rowToAttachment);
}

export function deleteTaskAttachment(id: string): void {
  const db = getStateDb();
  db.prepare("DELETE FROM op1_task_attachments WHERE id = ?").run(id);
}
