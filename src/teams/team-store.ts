/**
 * Team run store — SQLite-backed CRUD for team runs and members.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emitTeamEvent } from "./team-events.js";
import {
  deleteTeamRunFromDb,
  listTeamRunsFromDb,
  loadFullTeamStoreFromDb,
  loadTeamRunFromDb,
  saveTeamRunToDb,
} from "./team-store-sqlite.js";
import type { TeamMember, TeamRun, TeamRunState, TeamStoreData } from "./types.js";

// ─── Sweep constants ──────────────────────────────────────────────────
/** Mark active runs as failed if not updated within this window. */
const TEAM_RUN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Load the full store from SQLite (compat wrapper). */
export function loadTeamStore(): TeamStoreData {
  return loadFullTeamStoreFromDb();
}

/** Save the full store to SQLite (compat wrapper — saves only runs). */
export function saveTeamStore(data: TeamStoreData): void {
  // Save all runs (which includes their members via saveTeamRunToDb)
  for (const run of Object.values(data.runs)) {
    saveTeamRunToDb(run);
  }
}

/** Create a new team run. */
export function createTeamRun(opts: {
  name: string;
  leader: string;
  leaderSession: string;
}): TeamRun {
  const now = Date.now();
  const run: TeamRun = {
    id: randomUUID(),
    name: opts.name,
    leader: opts.leader,
    leaderSession: opts.leaderSession,
    members: [],
    state: "active",
    createdAt: now,
    updatedAt: now,
  };
  saveTeamRunToDb(run);
  emitTeamEvent({
    type: "team_run_created",
    teamRunId: run.id,
    name: run.name,
    leader: run.leader,
  });
  return run;
}

/** Get a team run by ID. */
export function getTeamRun(id: string): TeamRun | null {
  return loadTeamRunFromDb(id);
}

/** List team runs with optional filters. */
export function listTeamRuns(filter?: {
  leader?: string;
  state?: TeamRunState;
  limit?: number;
}): TeamRun[] {
  return listTeamRunsFromDb(filter);
}

/** Add a member to a team run. */
export function addTeamMember(
  teamRunId: string,
  member: { agentId: string; sessionKey: string; role?: string },
): TeamMember | null {
  const run = loadTeamRunFromDb(teamRunId);
  if (!run) {
    return null;
  }

  const entry: TeamMember = {
    agentId: member.agentId,
    sessionKey: member.sessionKey,
    role: member.role,
    state: "idle",
    joinedAt: Date.now(),
  };
  run.members.push(entry);
  run.updatedAt = Date.now();
  saveTeamRunToDb(run);
  emitTeamEvent({
    type: "team_member_joined",
    teamRunId,
    agentId: entry.agentId,
    role: entry.role,
  });
  return entry;
}

/** Update a member's state within a team run. */
export function updateMemberState(
  teamRunId: string,
  agentId: string,
  state: "idle" | "running" | "done",
): boolean {
  const run = loadTeamRunFromDb(teamRunId);
  if (!run) {
    return false;
  }

  const member = run.members.find((m) => m.agentId === agentId);
  if (!member) {
    return false;
  }

  member.state = state;
  run.updatedAt = Date.now();
  saveTeamRunToDb(run);
  emitTeamEvent({ type: "team_member_state_changed", teamRunId, agentId, state });
  return true;
}

/** Complete or fail a team run. */
export function completeTeamRun(id: string, state: "completed" | "failed"): TeamRun | null {
  const run = loadTeamRunFromDb(id);
  if (!run) {
    return null;
  }

  run.state = state;
  run.completedAt = Date.now();
  run.updatedAt = Date.now();

  // Mark all members as done
  for (const member of run.members) {
    member.state = "done";
  }

  saveTeamRunToDb(run);
  emitTeamEvent({ type: "team_run_completed", teamRunId: id, state });
  return run;
}

/** Delete a team run and all associated tasks/messages. */
export function deleteTeamRun(id: string): boolean {
  const exists = loadTeamRunFromDb(id);
  if (!exists) {
    return false;
  }
  deleteTeamRunFromDb(id);
  emitTeamEvent({ type: "team_run_completed", teamRunId: id, state: "failed" });
  return true;
}

/**
 * Sweep stale active team runs and mark them as failed.
 * Called on gateway startup and optionally on demand.
 *
 * Two conditions trigger a stale-mark:
 *   1. TTL: run has been active but not updated in > 24h.
 *   2. Orphan: the leader's session transcript file no longer exists on disk.
 *
 * Returns the number of runs swept.
 */
export function sweepStaleTeamRuns(): number {
  const runs = listTeamRunsFromDb({ state: "active" });
  const now = Date.now();
  let swept = 0;

  for (const run of runs) {
    let reason: string | null = null;

    // 1. TTL check
    if (now - run.updatedAt > TEAM_RUN_TTL_MS) {
      reason = "ttl_expired";
    }

    // 2. Orphan check — leader session transcript must exist
    if (!reason) {
      const agentId = run.leader;
      const sessionsDir = path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions");
      const transcriptPath = path.join(sessionsDir, `${run.leaderSession}.jsonl`);
      if (!fs.existsSync(transcriptPath)) {
        reason = "orphaned";
      }
    }

    if (reason) {
      run.state = "failed";
      run.completedAt = now;
      run.updatedAt = now;
      for (const member of run.members) {
        member.state = "done";
      }
      saveTeamRunToDb(run);
      swept++;
    }
  }

  return swept;
}
