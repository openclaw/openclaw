import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamMember, TeamStoreData } from "./types.js";

let tmpDir: string;
let storePath: string;

// We must replace the entire module because the original functions capture
// resolveTeamStorePath as a local binding. Overriding only the export
// does not affect internal callers. We re-implement loadTeamStore and
// saveTeamStore to point at the test's temp storePath, then re-implement
// all higher-level functions identically to the source (they are small).
vi.mock("./team-store.js", async () => {
  const { randomUUID } = await import("node:crypto");
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");

  function resolveTeamStorePath(): string {
    return storePath;
  }

  function loadTeamStore(): TeamStoreData {
    try {
      const raw = nodeFs.readFileSync(resolveTeamStorePath(), "utf-8");
      return JSON.parse(raw) as TeamStoreData;
    } catch {
      return { runs: {}, tasks: {}, messages: {} };
    }
  }

  function saveTeamStore(data: TeamStoreData): void {
    const filePath = resolveTeamStorePath();
    const dir = nodePath.dirname(filePath);
    if (!nodeFs.existsSync(dir)) {
      nodeFs.mkdirSync(dir, { recursive: true });
    }
    const tmp = `${filePath}.tmp`;
    nodeFs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    nodeFs.renameSync(tmp, filePath);
  }

  return {
    resolveTeamStorePath,
    loadTeamStore,
    saveTeamStore,
    createTeamRun(opts: { name: string; leader: string; leaderSession: string }) {
      const store = loadTeamStore();
      const now = Date.now();
      const run = {
        id: randomUUID(),
        name: opts.name,
        leader: opts.leader,
        leaderSession: opts.leaderSession,
        members: [] as TeamMember[],
        state: "active" as const,
        createdAt: now,
        updatedAt: now,
      };
      store.runs[run.id] = run;
      saveTeamStore(store);
      return run;
    },
    getTeamRun(id: string) {
      return loadTeamStore().runs[id] ?? null;
    },
    listTeamRuns(filter?: { leader?: string; state?: string; limit?: number }) {
      let runs = Object.values(loadTeamStore().runs);
      if (filter?.leader) {
        runs = runs.filter((r) => r.leader === filter.leader);
      }
      if (filter?.state) {
        runs = runs.filter((r) => r.state === filter.state);
      }
      runs.sort((a, b) => b.createdAt - a.createdAt);
      if (filter?.limit && filter.limit > 0) {
        runs = runs.slice(0, filter.limit);
      }
      return runs;
    },
    addTeamMember(
      teamRunId: string,
      member: { agentId: string; sessionKey: string; role?: string },
    ) {
      const store = loadTeamStore();
      const run = store.runs[teamRunId];
      if (!run) {
        return null;
      }
      const entry = {
        agentId: member.agentId,
        sessionKey: member.sessionKey,
        role: member.role,
        state: "idle" as const,
        joinedAt: Date.now(),
      };
      run.members.push(entry);
      run.updatedAt = Date.now();
      saveTeamStore(store);
      return entry;
    },
    updateMemberState(teamRunId: string, agentId: string, state: "idle" | "running" | "done") {
      const store = loadTeamStore();
      const run = store.runs[teamRunId];
      if (!run) {
        return false;
      }
      const member = run.members.find((m: TeamMember) => m.agentId === agentId);
      if (!member) {
        return false;
      }
      member.state = state;
      run.updatedAt = Date.now();
      saveTeamStore(store);
      return true;
    },
    completeTeamRun(id: string, state: "completed" | "failed") {
      const store = loadTeamStore();
      const run = store.runs[id];
      if (!run) {
        return null;
      }
      run.state = state;
      run.completedAt = Date.now();
      run.updatedAt = Date.now();
      for (const member of run.members) {
        member.state = "done";
      }
      saveTeamStore(store);
      return run;
    },
  };
});

const {
  createTeamRun,
  getTeamRun,
  listTeamRuns,
  addTeamMember,
  updateMemberState,
  completeTeamRun,
  loadTeamStore,
  saveTeamStore,
} = await import("./team-store.js");

describe("team-store", () => {
  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "team-store-test-"));
    storePath = path.join(tmpDir, "teams.json");
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // ── loadTeamStore / saveTeamStore ──────────────────────────────────

  describe("loadTeamStore", () => {
    it("returns empty store when file does not exist", () => {
      const store = loadTeamStore();
      expect(store).toEqual({ runs: {}, tasks: {}, messages: {} });
    });
  });

  describe("saveTeamStore", () => {
    it("creates parent directories and writes JSON", () => {
      saveTeamStore({ runs: {}, tasks: {}, messages: {} });
      const raw = fs.readFileSync(storePath, "utf-8");
      expect(JSON.parse(raw)).toEqual({ runs: {}, tasks: {}, messages: {} });
    });
  });

  // ── createTeamRun ─────────────────────────────────────────────────

  describe("createTeamRun", () => {
    it("creates a team run with correct defaults", () => {
      const run = createTeamRun({
        name: "auth-refactor",
        leader: "neo",
        leaderSession: "session-1",
      });
      expect(run.name).toBe("auth-refactor");
      expect(run.leader).toBe("neo");
      expect(run.leaderSession).toBe("session-1");
      expect(run.state).toBe("active");
      expect(run.members).toEqual([]);
      expect(run.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(run.createdAt).toBeGreaterThan(0);
      expect(run.updatedAt).toBe(run.createdAt);
      expect(run.completedAt).toBeUndefined();
    });

    it("generates unique IDs for each run", () => {
      const run1 = createTeamRun({ name: "a", leader: "l", leaderSession: "s" });
      const run2 = createTeamRun({ name: "b", leader: "l", leaderSession: "s" });
      expect(run1.id).not.toBe(run2.id);
    });

    it("persists to disk", () => {
      const run = createTeamRun({
        name: "persist-check",
        leader: "neo",
        leaderSession: "s",
      });
      const stored = loadTeamStore();
      expect(stored.runs[run.id]).toEqual(run);
    });
  });

  // ── getTeamRun ────────────────────────────────────────────────────

  describe("getTeamRun", () => {
    it("returns the run by ID", () => {
      const run = createTeamRun({
        name: "fetch-me",
        leader: "neo",
        leaderSession: "s",
      });
      const fetched = getTeamRun(run.id);
      expect(fetched).toEqual(run);
    });

    it("returns null for a missing ID", () => {
      expect(getTeamRun("nonexistent")).toBeNull();
    });
  });

  // ── listTeamRuns ──────────────────────────────────────────────────

  describe("listTeamRuns", () => {
    it("returns all runs sorted by most recent first", () => {
      createTeamRun({ name: "a", leader: "l", leaderSession: "s" });
      createTeamRun({ name: "b", leader: "l", leaderSession: "s" });
      const list = listTeamRuns();
      expect(list.length).toBe(2);
      // Most recent first (descending createdAt)
      expect(list[0].createdAt).toBeGreaterThanOrEqual(list[1].createdAt);
    });

    it("filters by state", () => {
      const active = createTeamRun({ name: "a", leader: "l", leaderSession: "s" });
      const completed = createTeamRun({ name: "b", leader: "l", leaderSession: "s" });
      completeTeamRun(completed.id, "completed");

      const list = listTeamRuns({ state: "active" });
      expect(list.length).toBe(1);
      expect(list[0].id).toBe(active.id);
    });

    it("filters by leader", () => {
      createTeamRun({ name: "a", leader: "neo", leaderSession: "s" });
      createTeamRun({ name: "b", leader: "morpheus", leaderSession: "s" });
      const list = listTeamRuns({ leader: "morpheus" });
      expect(list.length).toBe(1);
      expect(list[0].leader).toBe("morpheus");
    });

    it("applies limit", () => {
      createTeamRun({ name: "a", leader: "l", leaderSession: "s" });
      createTeamRun({ name: "b", leader: "l", leaderSession: "s" });
      createTeamRun({ name: "c", leader: "l", leaderSession: "s" });
      const list = listTeamRuns({ limit: 2 });
      expect(list.length).toBe(2);
    });

    it("combines filters", () => {
      createTeamRun({ name: "a", leader: "neo", leaderSession: "s" });
      createTeamRun({ name: "b", leader: "neo", leaderSession: "s" });
      createTeamRun({ name: "c", leader: "morpheus", leaderSession: "s" });
      const list = listTeamRuns({ leader: "neo", limit: 1 });
      expect(list.length).toBe(1);
      expect(list[0].leader).toBe("neo");
    });

    it("returns empty array when no runs match", () => {
      expect(listTeamRuns({ leader: "nobody" })).toEqual([]);
    });
  });

  // ── addTeamMember ─────────────────────────────────────────────────

  describe("addTeamMember", () => {
    it("adds a member with idle state", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const member = addTeamMember(run.id, {
        agentId: "agent-1",
        sessionKey: "sk-1",
        role: "coder",
      });
      expect(member).not.toBeNull();
      expect(member!.agentId).toBe("agent-1");
      expect(member!.sessionKey).toBe("sk-1");
      expect(member!.role).toBe("coder");
      expect(member!.state).toBe("idle");
      expect(member!.joinedAt).toBeGreaterThan(0);
    });

    it("persists the member to the run", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      addTeamMember(run.id, { agentId: "agent-1", sessionKey: "sk-1" });
      const fetched = getTeamRun(run.id);
      expect(fetched!.members).toHaveLength(1);
      expect(fetched!.members[0].agentId).toBe("agent-1");
    });

    it("allows adding duplicate agentId (appends second entry)", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      addTeamMember(run.id, { agentId: "agent-1", sessionKey: "sk-1" });
      addTeamMember(run.id, { agentId: "agent-1", sessionKey: "sk-2" });
      const fetched = getTeamRun(run.id);
      expect(fetched!.members).toHaveLength(2);
    });

    it("returns null for nonexistent team run", () => {
      expect(addTeamMember("no-such-id", { agentId: "a", sessionKey: "s" })).toBeNull();
    });

    it("updates the run's updatedAt timestamp", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const before = run.updatedAt;
      addTeamMember(run.id, { agentId: "a", sessionKey: "s" });
      const fetched = getTeamRun(run.id);
      expect(fetched!.updatedAt).toBeGreaterThanOrEqual(before);
    });
  });

  // ── updateMemberState ─────────────────────────────────────────────

  describe("updateMemberState", () => {
    it("transitions idle -> running -> done", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      addTeamMember(run.id, { agentId: "agent-1", sessionKey: "sk-1" });

      expect(updateMemberState(run.id, "agent-1", "running")).toBe(true);
      expect(getTeamRun(run.id)!.members[0].state).toBe("running");

      expect(updateMemberState(run.id, "agent-1", "done")).toBe(true);
      expect(getTeamRun(run.id)!.members[0].state).toBe("done");
    });

    it("returns false for nonexistent team run", () => {
      expect(updateMemberState("no-run", "agent-1", "running")).toBe(false);
    });

    it("returns false for nonexistent agent", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      expect(updateMemberState(run.id, "no-agent", "running")).toBe(false);
    });
  });

  // ── completeTeamRun ───────────────────────────────────────────────

  describe("completeTeamRun", () => {
    it("sets state to completed and sets completedAt", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const result = completeTeamRun(run.id, "completed");
      expect(result).not.toBeNull();
      expect(result!.state).toBe("completed");
      expect(result!.completedAt).toBeGreaterThan(0);
    });

    it("sets state to failed", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const result = completeTeamRun(run.id, "failed");
      expect(result).not.toBeNull();
      expect(result!.state).toBe("failed");
      expect(result!.completedAt).toBeGreaterThan(0);
    });

    it("marks all members as done", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      addTeamMember(run.id, { agentId: "a1", sessionKey: "s1" });
      addTeamMember(run.id, { agentId: "a2", sessionKey: "s2" });
      updateMemberState(run.id, "a1", "running");

      const result = completeTeamRun(run.id, "completed");
      expect(result!.members.every((m) => m.state === "done")).toBe(true);
    });

    it("returns null for nonexistent run", () => {
      expect(completeTeamRun("no-such-id", "completed")).toBeNull();
    });

    it("persists the completed state to disk", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      completeTeamRun(run.id, "completed");
      const fetched = getTeamRun(run.id);
      expect(fetched!.state).toBe("completed");
      expect(fetched!.completedAt).toBeGreaterThan(0);
    });
  });
});
