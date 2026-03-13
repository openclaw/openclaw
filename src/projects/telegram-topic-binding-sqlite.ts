/**
 * SQLite adapter for Telegram topic → project bindings.
 * Replaces the embedded telegram.topicId field in PROJECTS.md entries.
 */
import { getStateDb } from "../infra/state-db/connection.js";

export interface TelegramTopicBinding {
  chatId: string;
  topicId: string;
  projectId: string;
  groupName?: string;
  topicName?: string;
  boundAt?: number;
  boundBy?: string;
}

type BindingRow = {
  chat_id: string;
  topic_id: string;
  project_id: string;
  group_name: string | null;
  topic_name: string | null;
  bound_at: number | null;
  bound_by: string | null;
};

function rowToBinding(r: BindingRow): TelegramTopicBinding {
  return {
    chatId: r.chat_id,
    topicId: r.topic_id,
    projectId: r.project_id,
    groupName: r.group_name ?? undefined,
    topicName: r.topic_name ?? undefined,
    boundAt: r.bound_at ?? undefined,
    boundBy: r.bound_by ?? undefined,
  };
}

// ── Read ─────────────────────────────────────────────────────────────────────

/** Find which project a topic is bound to (used by auto-bind). */
export function findProjectByTopicId(topicId: string | number): string | undefined {
  const db = getStateDb();
  const row = db
    .prepare("SELECT project_id FROM op1_telegram_topic_bindings WHERE topic_id = ? LIMIT 1")
    .get(String(topicId)) as { project_id: string } | undefined;
  return row?.project_id;
}

/** Get all topic bindings for a project. */
export function getBindingsForProject(projectId: string): TelegramTopicBinding[] {
  const db = getStateDb();
  const rows = db
    .prepare(
      "SELECT chat_id, topic_id, project_id, group_name, topic_name, bound_at, bound_by FROM op1_telegram_topic_bindings WHERE project_id = ? ORDER BY bound_at",
    )
    .all(projectId) as BindingRow[];
  return rows.map(rowToBinding);
}

/** List all topic bindings. */
export function listAllTopicBindings(): TelegramTopicBinding[] {
  const db = getStateDb();
  const rows = db
    .prepare(
      "SELECT chat_id, topic_id, project_id, group_name, topic_name, bound_at, bound_by FROM op1_telegram_topic_bindings ORDER BY bound_at",
    )
    .all() as BindingRow[];
  return rows.map(rowToBinding);
}

// ── Write ────────────────────────────────────────────────────────────────────

/** Bind a Telegram topic to a project (upsert). */
export function bindTelegramTopic(binding: {
  chatId: string;
  topicId: string;
  projectId: string;
  groupName?: string;
  topicName?: string;
  boundBy?: string;
}): void {
  const db = getStateDb();
  db.prepare(
    `INSERT INTO op1_telegram_topic_bindings (chat_id, topic_id, project_id, group_name, topic_name, bound_at, bound_by)
     VALUES (?, ?, ?, ?, ?, unixepoch(), ?)
     ON CONFLICT(chat_id, topic_id) DO UPDATE SET
       project_id = excluded.project_id,
       group_name = excluded.group_name,
       topic_name = excluded.topic_name,
       bound_at = unixepoch(),
       bound_by = excluded.bound_by`,
  ).run(
    binding.chatId,
    binding.topicId,
    binding.projectId,
    binding.groupName ?? null,
    binding.topicName ?? null,
    binding.boundBy ?? "manual",
  );
}

/** Unbind a Telegram topic. */
export function unbindTelegramTopic(chatId: string, topicId: string): boolean {
  const db = getStateDb();
  const result = db
    .prepare("DELETE FROM op1_telegram_topic_bindings WHERE chat_id = ? AND topic_id = ?")
    .run(chatId, topicId);
  return (result.changes as number) > 0;
}

/** Remove all bindings for a project (used when deleting a project). */
export function unbindAllForProject(projectId: string): number {
  const db = getStateDb();
  const result = db
    .prepare("DELETE FROM op1_telegram_topic_bindings WHERE project_id = ?")
    .run(projectId);
  return result.changes as number;
}
