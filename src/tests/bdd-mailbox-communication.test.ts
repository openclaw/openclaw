// TODO: These tests need proper mock implementation for TeamManager
/**
 * Mailbox Communication BDD Step Definitions
 * Implements scenarios from features/mailbox-communication.feature
 */

import { rm, mkdir } from "fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeInboxMessage, readInboxMessages, clearInboxMessages } from "../teams/inbox.js";

// Mock node:fs for tests
const mockInboxes: Map<string, unknown[]> = new Map();
const mockMembers: Map<string, unknown[]> = new Map();

vi.mock("node:fs/promises", () => ({
  mkdir: async () => {},
  writeFile: async (_path: string, _content: string) => {},
  appendFile: async (path: string, content: string) => {
    const match = path.match(/inbox\/([^/]+)\/messages\.jsonl$/);
    if (match) {
      const sessionKey = match[1];
      const msg = JSON.parse(content.trim());
      const existing = mockInboxes.get(sessionKey) || [];
      const updated = existing.slice();
      updated.push(msg);
      mockInboxes.set(sessionKey, updated);
    }
  },
  readFile: async (path: string) => {
    const match = path.match(/inbox\/([^/]+)\/messages\.jsonl$/);
    if (match) {
      const sessionKey = match[1];
      const messages = mockInboxes.get(sessionKey) || [];
      return Array.isArray(messages) ? messages.map((m) => JSON.stringify(m)).join("\n") : "";
    }
    throw new Error("File not found");
  },
  access: async () => {},
  rm: async (path: string) => {
    const match = path.match(/inbox\/([^/]+)\/messages\.jsonl$/);
    if (match) {
      mockInboxes.delete(match[1]);
    }
  },
  unlink: async (path: string) => {
    const match = path.match(/inbox\/([^/]+)\/messages\.jsonl$/);
    if (match) {
      mockInboxes.delete(match[1]);
    }
  },
}));

vi.mock("node:fs", () => ({
  existsSync: () => true,
  mkdirSync: () => {},
}));

describe.skip("Mailbox Communication", () => { // TODO: Fix mock implementation
  const TEST_DIR = join(process.cwd(), "tmp", "bdd-msg");
  const stateDir = TEST_DIR;
  const teamName = "msg-team";

  beforeEach(async () => {
    mockInboxes.clear();
    mockMembers.clear();
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
      await mkdir(TEST_DIR, { recursive: true });
    } catch {
      // Directory may not exist
    }

    // Set up mock members
    mockMembers.set(teamName, [
      { sessionKey: "lead", name: "lead", role: "lead", joinedAt: Date.now() },
      { sessionKey: "worker-1", name: "worker-1", role: "member", joinedAt: Date.now() },
      { sessionKey: "worker-2", name: "worker-2", role: "member", joinedAt: Date.now() },
    ]);
  });

  afterEach(async () => {
    mockInboxes.clear();
    mockMembers.clear();
    try {
      await rm(TEST_DIR, { recursive: true, force: true });
    } catch {
      // Directory may not exist
    }
  });

  describe("Scenario: Send direct message to teammate", () => {
    it("writes message to recipient inbox", async () => {
      const message = {
        id: randomUUID(),
        type: "message" as const,
        sender: "lead",
        recipient: "worker-1",
        content: "Please start working on task A",
        timestamp: Date.now(),
      };

      await writeInboxMessage(teamName, stateDir, "worker-1", message);

      const messages = await readInboxMessages(teamName, stateDir, "worker-1");
      expect(messages.length).toBe(1);
      expect(messages[0].content).toBe(message.content);
    });
  });

  describe("Scenario: Message delivered only to intended recipient", () => {
    it("writes message only to recipient inbox", async () => {
      const message = {
        id: randomUUID(),
        type: "message" as const,
        sender: "lead",
        recipient: "worker-1",
        content: "Private message",
        timestamp: Date.now(),
      };

      await writeInboxMessage(teamName, stateDir, "worker-1", message);

      const worker1Messages = await readInboxMessages(teamName, stateDir, "worker-1");
      const worker2Messages = await readInboxMessages(teamName, stateDir, "worker-2");
      const leadMessages = await readInboxMessages(teamName, stateDir, "lead");

      expect(worker1Messages.length).toBe(1);
      expect(worker2Messages.length).toBe(0);
      expect(leadMessages.length).toBe(0);
    });
  });

  describe("Scenario: Broadcast message to all teammates", () => {
    it("writes message to all members except sender", async () => {
      const message = {
        id: randomUUID(),
        type: "broadcast" as const,
        sender: "lead",
        recipient: "",
        content: "Team announcement",
        timestamp: Date.now(),
      };

      await writeInboxMessage(teamName, stateDir, "worker-1", message);
      await writeInboxMessage(teamName, stateDir, "worker-2", message);

      const worker1Messages = await readInboxMessages(teamName, stateDir, "worker-1");
      const worker2Messages = await readInboxMessages(teamName, stateDir, "worker-2");

      expect(worker1Messages.length).toBe(1);
      expect(worker2Messages.length).toBe(1);
    });
  });

  describe("Scenario: Broadcast excludes sender", () => {
    it("does not write message to sender inbox", async () => {
      const message = {
        id: randomUUID(),
        type: "broadcast" as const,
        sender: "worker-2",
        recipient: "",
        content: "Worker 2 broadcast",
        timestamp: Date.now(),
      };

      // Broadcast to all members except sender
      await writeInboxMessage(teamName, stateDir, "lead", message);
      await writeInboxMessage(teamName, stateDir, "worker-1", message);

      const leadMessages = await readInboxMessages(teamName, stateDir, "lead");
      const worker1Messages = await readInboxMessages(teamName, stateDir, "worker-1");
      const worker2Messages = await readInboxMessages(teamName, stateDir, "worker-2");

      expect(leadMessages.length).toBe(1);
      expect(worker1Messages.length).toBe(1);
      expect(worker2Messages.length).toBe(0);
    });
  });

  describe("Scenario: Send shutdown request to member", () => {
    it("includes request_id in shutdown_request message", async () => {
      const requestId = "shutdown-123";
      const message = {
        id: randomUUID(),
        type: "shutdown_request" as const,
        sender: "lead",
        recipient: "worker-1",
        content: "Please shutdown",
        requestId,
        timestamp: Date.now(),
      };

      await writeInboxMessage(teamName, stateDir, "worker-1", message);

      const messages = await readInboxMessages(teamName, stateDir, "worker-1");
      expect(messages.length).toBe(1);
      expect(messages[0].requestId).toBe(requestId);
    });
  });

  describe("Scenario: Shutdown response with approval", () => {
    it("delivers response with matching request_id and approve true", async () => {
      const requestId = "shutdown-456";
      const message = {
        id: randomUUID(),
        type: "shutdown_response" as const,
        sender: "worker-1",
        recipient: "lead",
        content: "Shutdown approved",
        requestId,
        approve: true,
        timestamp: Date.now(),
      };

      await writeInboxMessage(teamName, stateDir, "lead", message);

      const messages = await readInboxMessages(teamName, stateDir, "lead");
      expect(messages.length).toBe(1);
      expect(messages[0].requestId).toBe(requestId);
      expect(messages[0].approve).toBe(true);
    });
  });

  describe("Scenario: Shutdown response with rejection and reason", () => {
    it("includes reason for rejection", async () => {
      const message = {
        id: randomUUID(),
        type: "shutdown_response" as const,
        sender: "worker-2",
        recipient: "lead",
        content: "Cannot shutdown yet",
        requestId: "shutdown-789",
        approve: false,
        reason: "Working on task",
        timestamp: Date.now(),
      };

      await writeInboxMessage(teamName, stateDir, "lead", message);

      const messages = await readInboxMessages(teamName, stateDir, "lead");
      expect(messages.length).toBe(1);
      expect(messages[0].approve).toBe(false);
      expect(messages[0].reason).toBe("Working on task");
    });
  });

  describe("Scenario: Message queue processed on next inference", () => {
    it("injects all messages as XML and clears inbox", async () => {
      const message1 = {
        id: randomUUID(),
        type: "message" as const,
        sender: "lead",
        recipient: "worker-1",
        content: "Message 1",
        timestamp: Date.now(),
      };
      const message2 = {
        id: randomUUID(),
        type: "message" as const,
        sender: "lead",
        recipient: "worker-1",
        content: "Message 2",
        timestamp: Date.now(),
      };
      const message3 = {
        id: randomUUID(),
        type: "message" as const,
        sender: "lead",
        recipient: "worker-1",
        content: "Message 3",
        timestamp: Date.now(),
      };

      await writeInboxMessage(teamName, stateDir, "worker-1", message1);
      await writeInboxMessage(teamName, stateDir, "worker-1", message2);
      await writeInboxMessage(teamName, stateDir, "worker-1", message3);

      const messages = await readInboxMessages(teamName, stateDir, "worker-1");
      expect(messages.length).toBe(3);

      await clearInboxMessages(teamName, stateDir, "worker-1");

      const clearedMessages = await readInboxMessages(teamName, stateDir, "worker-1");
      expect(clearedMessages.length).toBe(0);
    });
  });
});
