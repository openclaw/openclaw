import { describe, expect, it } from "vitest";
import {
  createTeamRun,
  getTeamRun,
  listTeamRuns,
  addTeamMember,
  updateMemberState,
  completeTeamRun,
  loadTeamStore,
} from "./team-store.js";
import { useTeamStoreTestDb } from "./test-helpers.team-store.js";

describe("team-store", () => {
  useTeamStoreTestDb();

  // ── loadTeamStore ──────────────────────────────────────────────────

  describe("loadTeamStore", () => {
    it("returns empty store when no data exists", () => {
      const store = loadTeamStore();
      expect(store).toEqual({ runs: {}, tasks: {}, messages: {} });
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

    it("persists to database", () => {
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

    it("persists the completed state", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      completeTeamRun(run.id, "completed");
      const fetched = getTeamRun(run.id);
      expect(fetched!.state).toBe("completed");
      expect(fetched!.completedAt).toBeGreaterThan(0);
    });
  });
});
