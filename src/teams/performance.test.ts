/**
 * Performance Tests for Team Operations
 * Benchmarks for team task management performance
 */

import { rm, mkdir } from "fs/promises";
import { join } from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TeamManager } from "./manager.js";

describe("Performance Tests", () => {
  const testDir = join("/tmp", "openclaw-test-perf", crypto.randomUUID());

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe("Task Operations Performance", () => {
    it("should create tasks in under 50ms", async () => {
      const manager = new TeamManager("perf-team", testDir);

      const start = performance.now();
      manager.createTask("Test task", "Performance test task description", {
        activeForm: "Testing performance",
      });
      const end = performance.now();

      const duration = end - start;
      expect(duration).toBeLessThan(50);

      manager.close();
    });

    it("should claim tasks in under 10ms", async () => {
      const manager = new TeamManager("perf-team", testDir);

      // Create a task first
      const task = manager.createTask("Test task", "Performance test task description");

      // Measure claim time
      const start = performance.now();
      const result = manager.claimTask(task.id, "test-agent");
      const end = performance.now();

      const duration = end - start;
      expect(duration).toBeLessThan(10);
      expect(result.success).toBe(true);

      manager.close();
    });

    it("should list tasks in under 20ms", async () => {
      const manager = new TeamManager("perf-team", testDir);

      // Create multiple tasks
      for (let i = 0; i < 10; i++) {
        manager.createTask(`Task ${i}`, `Description ${i}`);
      }

      const start = performance.now();
      const tasks = manager.listTasks();
      const end = performance.now();

      const duration = end - start;
      expect(duration).toBeLessThan(20);
      expect(tasks.length).toBe(10);

      manager.close();
    });

    it("should handle bulk task creation efficiently", async () => {
      const manager = new TeamManager("perf-team", testDir);

      const taskCount = 100;
      const start = performance.now();

      for (let i = 0; i < taskCount; i++) {
        manager.createTask(`Task ${i}`, `Description ${i}`);
      }

      const end = performance.now();
      const duration = end - start;

      // 100 tasks should complete in under 500ms (5ms per task average)
      expect(duration).toBeLessThan(500);

      manager.close();
    });
  });

  describe("Message Operations Performance", () => {
    it("should send messages in under 30ms", async () => {
      const manager = new TeamManager("perf-team", testDir);

      // Add a member first
      manager.addMember("test-agent", "agent-1", "member");

      const start = performance.now();
      manager.storeMessage({
        id: crypto.randomUUID(),
        from: "lead",
        to: "test-agent",
        type: "message",
        content: "Test message",
        summary: "Test",
        timestamp: Date.now(),
        sender: "lead",
        recipient: "test-agent",
      });
      const end = performance.now();

      const duration = end - start;
      expect(duration).toBeLessThan(30);

      manager.close();
    });

    it("should deliver messages in under 10ms", async () => {
      const manager = new TeamManager("perf-team", testDir);

      // Add a member and store a message
      manager.addMember("test-agent", "agent-1", "member");
      manager.storeMessage({
        id: crypto.randomUUID(),
        from: "lead",
        to: "test-agent",
        type: "message",
        content: "Test message",
        summary: "Test",
        timestamp: Date.now(),
        sender: "lead",
        recipient: "test-agent",
      });

      const start = performance.now();
      const messages = manager.retrieveMessages("test-agent");
      const end = performance.now();

      const duration = end - start;
      expect(duration).toBeLessThan(10);
      expect(messages.length).toBe(1);

      manager.close();
    });

    it("should handle bulk message delivery efficiently", async () => {
      const manager = new TeamManager("perf-team", testDir);

      // Add members and store messages
      const recipient = "test-agent";
      manager.addMember(recipient, "agent-1", "member");

      const messageCount = 50;
      for (let i = 0; i < messageCount; i++) {
        manager.storeMessage({
          id: crypto.randomUUID(),
          from: "lead",
          to: recipient,
          type: "message",
          content: `Message ${i}`,
          summary: `Msg ${i}`,
          timestamp: Date.now(),
          sender: "lead",
          recipient,
        });
      }

      const start = performance.now();
      const messages = manager.retrieveMessages(recipient);
      const end = performance.now();

      const duration = end - start;
      // 50 messages should be retrieved in under 50ms
      expect(duration).toBeLessThan(50);
      expect(messages.length).toBe(messageCount);

      manager.close();
    });
  });

  describe("Member Operations Performance", () => {
    it("should add members efficiently", async () => {
      const manager = new TeamManager("perf-team", testDir);

      const start = performance.now();
      manager.addMember("test-member", "agent-1", "member");
      const end = performance.now();

      const duration = end - start;
      expect(duration).toBeLessThan(20);

      manager.close();
    });

    it("should list members efficiently", async () => {
      const manager = new TeamManager("perf-team", testDir);

      // Add multiple members
      for (let i = 0; i < 10; i++) {
        manager.addMember(`member-${i}`, `agent-${i}`, "member");
      }

      const start = performance.now();
      const members = manager.listMembers();
      const end = performance.now();

      const duration = end - start;
      expect(duration).toBeLessThan(10);
      expect(members.length).toBe(10);

      manager.close();
    });
  });

  describe("Complete Workflow Performance", () => {
    it("should handle complete team workflow efficiently", async () => {
      const manager = new TeamManager("perf-team", testDir);
      const teamSize = 5;
      const tasksPerMember = 10;

      // Add team members
      const start = performance.now();

      for (let i = 0; i < teamSize; i++) {
        manager.addMember(`member-${i}`, `agent-${i}`, "member");
      }

      // Create tasks
      const taskIds: string[] = [];
      for (let i = 0; i < teamSize * tasksPerMember; i++) {
        const task = manager.createTask(`Task ${i}`, `Description for task ${i}`);
        taskIds.push(task.id);
      }

      // List tasks
      let tasks = manager.listTasks();
      expect(tasks.length).toBe(teamSize * tasksPerMember);

      // Claim tasks
      for (let i = 0; i < teamSize * tasksPerMember; i++) {
        const memberIndex = i % teamSize;
        manager.claimTask(taskIds[i], `member-${memberIndex}`);
      }

      // Complete some tasks
      for (let i = 0; i < teamSize * tasksPerMember; i += 2) {
        manager.completeTask(taskIds[i]);
      }

      // List completed tasks
      tasks = manager.listTasks();
      const completedCount = tasks.filter((t) => t.status === "completed").length;

      const end = performance.now();
      const duration = end - start;

      // Full workflow should complete in under 2 seconds
      expect(duration).toBeLessThan(2000);
      expect(completedCount).toBe((teamSize * tasksPerMember) / 2);

      manager.close();
    });
  });
});
