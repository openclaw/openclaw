/**
 * Team run store — simple JSON-file-backed CRUD for team runs and members.
 * Reads/writes on every call (no caching, no locking).
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emitTeamEvent } from "./team-events.js";
import type { TeamMember, TeamRun, TeamRunState, TeamStoreData } from "./types.js";

/** Resolve the teams store file path. */
export function resolveTeamStorePath(): string {
  return path.join(os.homedir(), ".openclaw", "teams", "teams.json");
}

/** Load the full store from disk (returns empty store if file missing). */
export function loadTeamStore(): TeamStoreData {
  const filePath = resolveTeamStorePath();
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as TeamStoreData;
  } catch {
    return { runs: {}, tasks: {}, messages: {} };
  }
}

/** Write the full store to disk atomically (write to .tmp, rename). */
export function saveTeamStore(data: TeamStoreData): void {
  const filePath = resolveTeamStorePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

/** Create a new team run. */
export function createTeamRun(opts: {
  name: string;
  leader: string;
  leaderSession: string;
}): TeamRun {
  const store = loadTeamStore();
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
  store.runs[run.id] = run;
  saveTeamStore(store);
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
  const store = loadTeamStore();
  return store.runs[id] ?? null;
}

/** List team runs with optional filters. */
export function listTeamRuns(filter?: {
  leader?: string;
  state?: TeamRunState;
  limit?: number;
}): TeamRun[] {
  const store = loadTeamStore();
  let runs = Object.values(store.runs);

  if (filter?.leader) {
    runs = runs.filter((r) => r.leader === filter.leader);
  }
  if (filter?.state) {
    runs = runs.filter((r) => r.state === filter.state);
  }
  runs.sort((a, b) => b.createdAt - a.createdAt); // most recent first
  if (filter?.limit && filter.limit > 0) {
    runs = runs.slice(0, filter.limit);
  }
  return runs;
}

/** Add a member to a team run. */
export function addTeamMember(
  teamRunId: string,
  member: { agentId: string; sessionKey: string; role?: string },
): TeamMember | null {
  const store = loadTeamStore();
  const run = store.runs[teamRunId];
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
  saveTeamStore(store);
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
  const store = loadTeamStore();
  const run = store.runs[teamRunId];
  if (!run) {
    return false;
  }

  const member = run.members.find((m) => m.agentId === agentId);
  if (!member) {
    return false;
  }

  member.state = state;
  run.updatedAt = Date.now();
  saveTeamStore(store);
  emitTeamEvent({ type: "team_member_state_changed", teamRunId, agentId, state });
  return true;
}

/** Complete or fail a team run. */
export function completeTeamRun(id: string, state: "completed" | "failed"): TeamRun | null {
  const store = loadTeamStore();
  const run = store.runs[id];
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

  saveTeamStore(store);
  emitTeamEvent({ type: "team_run_completed", teamRunId: id, state });
  return run;
}
