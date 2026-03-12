import { describe, expect, it } from "vitest";
import { sendTeamMessage, listTeamMessages } from "./team-message-store.js";
import { createTeamRun } from "./team-store.js";
import { useTeamStoreTestDb } from "./test-helpers.team-store.js";

describe("team-message-store", () => {
  useTeamStoreTestDb();

  // ── sendTeamMessage ───────────────────────────────────────────────

  describe("sendTeamMessage", () => {
    it("creates a message with timestamp and unique ID", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const msg = sendTeamMessage({
        teamRunId: run.id,
        from: "agent-1",
        to: "agent-2",
        content: "Hello",
      });

      expect(msg.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(msg.teamRunId).toBe(run.id);
      expect(msg.from).toBe("agent-1");
      expect(msg.to).toBe("agent-2");
      expect(msg.content).toBe("Hello");
      expect(msg.timestamp).toBeGreaterThan(0);
    });

    it("generates unique IDs for each message", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const m1 = sendTeamMessage({
        teamRunId: run.id,
        from: "a",
        to: "b",
        content: "1",
      });
      const m2 = sendTeamMessage({
        teamRunId: run.id,
        from: "a",
        to: "b",
        content: "2",
      });
      expect(m1.id).not.toBe(m2.id);
    });

    it("supports broadcast messages", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const msg = sendTeamMessage({
        teamRunId: run.id,
        from: "leader",
        to: "broadcast",
        content: "Everyone sync up",
      });
      expect(msg.to).toBe("broadcast");
    });

    it("persists messages", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      sendTeamMessage({ teamRunId: run.id, from: "a", to: "b", content: "hi" });
      const msgs = listTeamMessages(run.id);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe("hi");
    });
  });

  // ── listTeamMessages ──────────────────────────────────────────────

  describe("listTeamMessages", () => {
    it("returns all messages for a team sorted by timestamp", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      sendTeamMessage({ teamRunId: run.id, from: "a", to: "b", content: "first" });
      sendTeamMessage({ teamRunId: run.id, from: "b", to: "a", content: "second" });

      const msgs = listTeamMessages(run.id);
      expect(msgs).toHaveLength(2);
      // Ascending order
      expect(msgs[0].content).toBe("first");
      expect(msgs[1].content).toBe("second");
      expect(msgs[0].timestamp).toBeLessThanOrEqual(msgs[1].timestamp);
    });

    it("returns empty array for a team with no messages", () => {
      expect(listTeamMessages("no-such-team")).toEqual([]);
    });

    it("does not return messages from other teams", () => {
      const run1 = createTeamRun({ name: "team1", leader: "l", leaderSession: "s" });
      const run2 = createTeamRun({ name: "team2", leader: "l", leaderSession: "s" });
      sendTeamMessage({ teamRunId: run1.id, from: "a", to: "b", content: "for team1" });
      sendTeamMessage({ teamRunId: run2.id, from: "a", to: "b", content: "for team2" });

      const msgs1 = listTeamMessages(run1.id);
      expect(msgs1).toHaveLength(1);
      expect(msgs1[0].content).toBe("for team1");
    });

    it("filters by from", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      sendTeamMessage({ teamRunId: run.id, from: "agent-1", to: "b", content: "from-1" });
      sendTeamMessage({ teamRunId: run.id, from: "agent-2", to: "b", content: "from-2" });

      const msgs = listTeamMessages(run.id, { from: "agent-1" });
      expect(msgs).toHaveLength(1);
      expect(msgs[0].from).toBe("agent-1");
    });

    it("filters by to", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      sendTeamMessage({ teamRunId: run.id, from: "a", to: "agent-1", content: "to-1" });
      sendTeamMessage({ teamRunId: run.id, from: "a", to: "broadcast", content: "to-all" });

      const msgs = listTeamMessages(run.id, { to: "agent-1" });
      expect(msgs).toHaveLength(1);
      expect(msgs[0].to).toBe("agent-1");
    });

    it("filters by since (timestamp)", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      const msg1 = sendTeamMessage({ teamRunId: run.id, from: "a", to: "b", content: "old" });

      // Use the first message's timestamp as the cutoff
      const cutoff = msg1.timestamp;

      sendTeamMessage({ teamRunId: run.id, from: "a", to: "b", content: "new" });

      const msgs = listTeamMessages(run.id, { since: cutoff });
      // Only messages with timestamp > cutoff
      expect(msgs.every((m) => m.timestamp > cutoff)).toBe(true);
    });

    it("combines from and to filters", () => {
      const run = createTeamRun({ name: "team", leader: "l", leaderSession: "s" });
      sendTeamMessage({ teamRunId: run.id, from: "a", to: "b", content: "a->b" });
      sendTeamMessage({ teamRunId: run.id, from: "a", to: "c", content: "a->c" });
      sendTeamMessage({ teamRunId: run.id, from: "b", to: "b", content: "b->b" });

      const msgs = listTeamMessages(run.id, { from: "a", to: "b" });
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe("a->b");
    });
  });
});
