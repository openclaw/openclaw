/**
 * SQLite adapter for the team store.
 *
 * Maps between the in-memory team types and the normalized op1_team_*
 * tables in operator1.db.
 */
import type { DatabaseSync } from "node:sqlite";
import { getStateDb } from "../infra/state-db/connection.js";
import { runMigrations } from "../infra/state-db/schema.js";
import type {
  TeamMember,
  TeamMessage,
  TeamRun,
  TeamRunState,
  TeamStoreData,
  TeamTask,
} from "./types.js";

// ── DB provider (overridable for tests) ─────────────────────────────────────

let _dbOverride: DatabaseSync | null = null;

export function setTeamStoreDbForTest(db: DatabaseSync): void {
  _dbOverride = db;
}

export function resetTeamStoreDbForTest(): void {
  _dbOverride = null;
}

export function initTeamStoreTestDb(db: DatabaseSync): DatabaseSync {
  runMigrations(db);
  setTeamStoreDbForTest(db);
  return db;
}

function resolveDb(db?: DatabaseSync): DatabaseSync {
  return db ?? _dbOverride ?? getStateDb();
}

// ── Row types ───────────────────────────────────────────────────────────────

type RegistryRow = {
  team_id: string;
  name: string;
  status: string | null;
  config_json: string | null;
  created_at: number | null;
  updated_at: number | null;
  leader: string | null;
  leader_session: string | null;
  completed_at: number | null;
};

type MemberRow = {
  team_id: string;
  agent_id: string;
  role: string | null;
  joined_at: number | null;
  session_key: string | null;
  state: string | null;
};

type TaskRow = {
  task_id: string;
  team_id: string;
  title: string | null;
  status: string | null;
  assigned_to: string | null;
  priority: number;
  result_json: string | null;
  created_at: number | null;
  updated_at: number | null;
  description: string | null;
  blocked_by_json: string | null;
};

type MessageRow = {
  id: number;
  team_id: string;
  agent_id: string | null;
  role: string | null;
  content: string | null;
  metadata_json: string | null;
  created_at: number | null;
  message_id: string | null;
  from_agent: string | null;
  to_agent: string | null;
  read_by_json: string | null;
};

// ── Row ↔ Type conversions ──────────────────────────────────────────────────

function rowToTeamRun(row: RegistryRow, members: TeamMember[]): TeamRun {
  const run: TeamRun = {
    id: row.team_id,
    name: row.name,
    leader: row.leader ?? "",
    leaderSession: row.leader_session ?? "",
    members,
    state: (row.status as TeamRunState) ?? "active",
    createdAt: row.created_at ?? 0,
    updatedAt: row.updated_at ?? 0,
  };
  if (row.completed_at != null) {
    run.completedAt = row.completed_at;
  }
  return run;
}

function rowToMember(row: MemberRow): TeamMember {
  return {
    agentId: row.agent_id,
    sessionKey: row.session_key ?? "",
    role: row.role ?? undefined,
    state: (row.state as TeamMember["state"]) ?? "idle",
    joinedAt: row.joined_at ?? 0,
  };
}

function rowToTask(row: TaskRow): TeamTask {
  let blockedBy: string[] = [];
  if (row.blocked_by_json) {
    try {
      blockedBy = JSON.parse(row.blocked_by_json);
    } catch {
      /* ignore */
    }
  }
  return {
    id: row.task_id,
    teamRunId: row.team_id,
    subject: row.title ?? "",
    description: row.description ?? "",
    owner: row.assigned_to ?? undefined,
    status: (row.status as TeamTask["status"]) ?? "pending",
    blockedBy,
    createdAt: row.created_at ?? 0,
    updatedAt: row.updated_at ?? 0,
  };
}

function rowToMessage(row: MessageRow): TeamMessage {
  let readBy: Record<string, number> | undefined;
  if (row.read_by_json) {
    try {
      readBy = JSON.parse(row.read_by_json);
    } catch {
      /* ignore */
    }
  }
  const msg: TeamMessage = {
    id: row.message_id ?? String(row.id),
    teamRunId: row.team_id,
    from: row.from_agent ?? row.agent_id ?? "",
    to: row.to_agent ?? "",
    content: row.content ?? "",
    timestamp: row.created_at ?? 0,
  };
  if (readBy && Object.keys(readBy).length > 0) {
    msg.readBy = readBy;
  }
  return msg;
}

// ── Team Run CRUD ───────────────────────────────────────────────────────────

export function saveTeamRunToDb(run: TeamRun, db?: DatabaseSync): void {
  const conn = resolveDb(db);
  try {
    conn.exec("BEGIN");
    try {
      conn
        .prepare(
          `INSERT OR REPLACE INTO op1_team_registry
           (team_id, name, status, leader, leader_session, created_at, updated_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          run.id,
          run.name,
          run.state,
          run.leader,
          run.leaderSession,
          run.createdAt,
          run.updatedAt,
          run.completedAt ?? null,
        );

      // Replace members
      conn.prepare("DELETE FROM op1_team_members WHERE team_id = ?").run(run.id);
      const insertMember = conn.prepare(
        `INSERT INTO op1_team_members (team_id, agent_id, role, joined_at, session_key, state)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const m of run.members) {
        insertMember.run(run.id, m.agentId, m.role ?? null, m.joinedAt, m.sessionKey, m.state);
      }

      conn.exec("COMMIT");
    } catch (err) {
      conn.exec("ROLLBACK");
      throw err;
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

export function loadTeamRunFromDb(teamRunId: string, db?: DatabaseSync): TeamRun | null {
  const conn = resolveDb(db);
  try {
    const row = conn.prepare("SELECT * FROM op1_team_registry WHERE team_id = ?").get(teamRunId) as
      | RegistryRow
      | undefined;
    if (!row) {
      return null;
    }
    const memberRows = conn
      .prepare("SELECT * FROM op1_team_members WHERE team_id = ?")
      .all(teamRunId) as MemberRow[];
    return rowToTeamRun(row, memberRows.map(rowToMember));
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return null;
    }
    throw err;
  }
}

export function listTeamRunsFromDb(
  filter?: { leader?: string; state?: TeamRunState; limit?: number },
  db?: DatabaseSync,
): TeamRun[] {
  const conn = resolveDb(db);
  try {
    let sql = "SELECT * FROM op1_team_registry WHERE 1=1";
    const params: (string | number | null)[] = [];
    if (filter?.leader) {
      sql += " AND leader = ?";
      params.push(filter.leader);
    }
    if (filter?.state) {
      sql += " AND status = ?";
      params.push(filter.state);
    }
    sql += " ORDER BY created_at DESC";
    if (filter?.limit && filter.limit > 0) {
      sql += " LIMIT ?";
      params.push(filter.limit);
    }
    const rows = conn.prepare(sql).all(...params) as RegistryRow[];
    return rows.map((row) => {
      const memberRows = conn
        .prepare("SELECT * FROM op1_team_members WHERE team_id = ?")
        .all(row.team_id) as MemberRow[];
      return rowToTeamRun(row, memberRows.map(rowToMember));
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return [];
    }
    throw err;
  }
}

export function deleteTeamRunFromDb(teamRunId: string, db?: DatabaseSync): boolean {
  const conn = resolveDb(db);
  try {
    const result = conn.prepare("DELETE FROM op1_team_registry WHERE team_id = ?").run(teamRunId);
    // CASCADE handles members, tasks, messages
    return result.changes > 0;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return false;
    }
    throw err;
  }
}

// ── Team Task CRUD ──────────────────────────────────────────────────────────

export function saveTeamTaskToDb(task: TeamTask, db?: DatabaseSync): void {
  const conn = resolveDb(db);
  try {
    conn
      .prepare(
        `INSERT OR REPLACE INTO op1_team_tasks
         (task_id, team_id, title, description, status, assigned_to, blocked_by_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        task.id,
        task.teamRunId,
        task.subject,
        task.description,
        task.status,
        task.owner ?? null,
        task.blockedBy.length > 0 ? JSON.stringify(task.blockedBy) : null,
        task.createdAt,
        task.updatedAt,
      );
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

export function loadTeamTasksFromDb(teamRunId: string, db?: DatabaseSync): TeamTask[] {
  const conn = resolveDb(db);
  try {
    const rows = conn
      .prepare("SELECT * FROM op1_team_tasks WHERE team_id = ?")
      .all(teamRunId) as TaskRow[];
    return rows.map(rowToTask);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return [];
    }
    throw err;
  }
}

export function loadTeamTaskByIdFromDb(
  teamRunId: string,
  taskId: string,
  db?: DatabaseSync,
): TeamTask | null {
  const conn = resolveDb(db);
  try {
    const row = conn
      .prepare("SELECT * FROM op1_team_tasks WHERE team_id = ? AND task_id = ?")
      .get(teamRunId, taskId) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return null;
    }
    throw err;
  }
}

export function deleteTeamTaskFromDb(
  teamRunId: string,
  taskId: string,
  db?: DatabaseSync,
): boolean {
  const conn = resolveDb(db);
  try {
    const result = conn
      .prepare("DELETE FROM op1_team_tasks WHERE team_id = ? AND task_id = ?")
      .run(teamRunId, taskId);
    return result.changes > 0;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return false;
    }
    throw err;
  }
}

// ── Team Message CRUD ───────────────────────────────────────────────────────

export function appendTeamMessageToDb(msg: TeamMessage, db?: DatabaseSync): void {
  const conn = resolveDb(db);
  try {
    conn
      .prepare(
        `INSERT INTO op1_team_messages
         (team_id, message_id, from_agent, to_agent, content, created_at, read_by_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        msg.teamRunId,
        msg.id,
        msg.from,
        msg.to,
        msg.content,
        msg.timestamp,
        msg.readBy ? JSON.stringify(msg.readBy) : null,
      );
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return;
    }
    throw err;
  }
}

export function loadTeamMessagesFromDb(
  teamRunId: string,
  filter?: { from?: string; to?: string; since?: number },
  db?: DatabaseSync,
): TeamMessage[] {
  const conn = resolveDb(db);
  try {
    let sql = "SELECT * FROM op1_team_messages WHERE team_id = ?";
    const params: (string | number | null)[] = [teamRunId];
    if (filter?.from) {
      sql += " AND from_agent = ?";
      params.push(filter.from);
    }
    if (filter?.to) {
      sql += " AND to_agent = ?";
      params.push(filter.to);
    }
    if (filter?.since != null) {
      sql += " AND created_at > ?";
      params.push(filter.since);
    }
    sql += " ORDER BY created_at ASC";
    const rows = conn.prepare(sql).all(...params) as MessageRow[];
    return rows.map(rowToMessage);
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return [];
    }
    throw err;
  }
}

export function updateTeamMessageReadByInDb(
  teamRunId: string,
  messageId: string,
  readBy: Record<string, number>,
  db?: DatabaseSync,
): boolean {
  const conn = resolveDb(db);
  try {
    const result = conn
      .prepare("UPDATE op1_team_messages SET read_by_json = ? WHERE team_id = ? AND message_id = ?")
      .run(JSON.stringify(readBy), teamRunId, messageId);
    return result.changes > 0;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return false;
    }
    throw err;
  }
}

export function loadTeamMessageByIdFromDb(
  teamRunId: string,
  messageId: string,
  db?: DatabaseSync,
): TeamMessage | null {
  const conn = resolveDb(db);
  try {
    const row = conn
      .prepare("SELECT * FROM op1_team_messages WHERE team_id = ? AND message_id = ?")
      .get(teamRunId, messageId) as MessageRow | undefined;
    return row ? rowToMessage(row) : null;
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return null;
    }
    throw err;
  }
}

// ── Full store load/save (compat) ───────────────────────────────────────────

export function loadFullTeamStoreFromDb(db?: DatabaseSync): TeamStoreData {
  const conn = resolveDb(db);
  try {
    const runs: Record<string, TeamRun> = {};
    const tasks: Record<string, TeamTask[]> = {};
    const messages: Record<string, TeamMessage[]> = {};

    const registryRows = conn.prepare("SELECT * FROM op1_team_registry").all() as RegistryRow[];

    for (const row of registryRows) {
      const memberRows = conn
        .prepare("SELECT * FROM op1_team_members WHERE team_id = ?")
        .all(row.team_id) as MemberRow[];
      runs[row.team_id] = rowToTeamRun(row, memberRows.map(rowToMember));
    }

    const taskRows = conn.prepare("SELECT * FROM op1_team_tasks").all() as TaskRow[];
    for (const row of taskRows) {
      const list = tasks[row.team_id] ?? [];
      list.push(rowToTask(row));
      tasks[row.team_id] = list;
    }

    const msgRows = conn
      .prepare("SELECT * FROM op1_team_messages ORDER BY created_at ASC")
      .all() as MessageRow[];
    for (const row of msgRows) {
      const list = messages[row.team_id] ?? [];
      list.push(rowToMessage(row));
      messages[row.team_id] = list;
    }

    return { runs, tasks, messages };
  } catch (err) {
    if (err instanceof Error && err.message.includes("no such table")) {
      return { runs: {}, tasks: {}, messages: {} };
    }
    throw err;
  }
}
