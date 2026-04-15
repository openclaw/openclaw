import crypto from "node:crypto";

export type TeamRecord = {
  teamId: string;
  name: string;
  description?: string;
  members: string[];
  labels: string[];
  createdAt: number;
  updatedAt: number;
};

export type TeamCreateInput = {
  teamId?: string;
  name: string;
  description?: string;
  members?: string[];
  labels?: string[];
};

export type TeamUpdateInput = {
  name?: string;
  description?: string;
  members?: string[];
  labels?: string[];
};

const teams = new Map<string, TeamRecord>();

function normalizeList(values?: string[]): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return Array.from(
    new Set(
      values
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  );
}

function createTeamId(): string {
  return `team_${crypto.randomUUID().slice(0, 12)}`;
}

export function createTeam(input: TeamCreateInput): TeamRecord {
  const now = Date.now();
  const teamId = (input.teamId?.trim() || createTeamId()).toLowerCase();
  if (!teamId) {
    throw new Error("team id required");
  }
  if (teams.has(teamId)) {
    throw new Error(`team already exists: ${teamId}`);
  }
  const name = input.name.trim();
  if (!name) {
    throw new Error("team name required");
  }
  const team: TeamRecord = {
    teamId,
    name,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    members: normalizeList(input.members),
    labels: normalizeList(input.labels),
    createdAt: now,
    updatedAt: now,
  };
  teams.set(teamId, team);
  return { ...team };
}

export function getTeam(teamId: string): TeamRecord | null {
  const entry = teams.get(teamId.trim().toLowerCase());
  return entry ? { ...entry } : null;
}

export function listTeams(): TeamRecord[] {
  return [...teams.values()]
    .map((entry) => ({ ...entry }))
    .sort((left, right) => left.createdAt - right.createdAt);
}

export function updateTeam(teamId: string, patch: TeamUpdateInput): TeamRecord {
  const normalizedId = teamId.trim().toLowerCase();
  const current = teams.get(normalizedId);
  if (!current) {
    throw new Error(`team not found: ${normalizedId}`);
  }
  const next: TeamRecord = {
    ...current,
    ...(patch.name?.trim() ? { name: patch.name.trim() } : {}),
    ...(patch.description !== undefined
      ? patch.description.trim()
        ? { description: patch.description.trim() }
        : { description: undefined }
      : {}),
    ...(patch.members ? { members: normalizeList(patch.members) } : {}),
    ...(patch.labels ? { labels: normalizeList(patch.labels) } : {}),
    updatedAt: Date.now(),
  };
  teams.set(normalizedId, next);
  return { ...next };
}

export function deleteTeam(teamId: string): boolean {
  return teams.delete(teamId.trim().toLowerCase());
}

export function resetTeamRegistryForTests(): void {
  teams.clear();
}
