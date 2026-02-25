/**
 * Inbox Storage Tests
 * BDD tests for team message inbox operations
 */

import * as fs from "fs/promises";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  sanitizeSessionKey,
  ensureInboxDirectory,
  writeInboxMessage,
  readInboxMessages,
  clearInboxMessages,
} from "./inbox.js";

vi.mock("fs/promises");
vi.mock("path", () => ({
  join: vi.fn((...args: string[]) => args.join("/")),
}));

describe("Session Key Sanitization", () => {
  describe("Given a session key with dangerous characters", () => {
    it("When session key contains forward slash Then it should be replaced with underscore", () => {
      expect(sanitizeSessionKey("session/key")).toBe("session_key");
    });

    it("When session key contains backslash Then it should be replaced with underscore", () => {
      expect(sanitizeSessionKey("session\\key")).toBe("session_key");
    });

    it("When session key contains dot Then it should be replaced with underscore", () => {
      expect(sanitizeSessionKey("session.key")).toBe("session_key");
    });

    it("When session key contains colon Then it should be replaced with underscore", () => {
      expect(sanitizeSessionKey("session:key")).toBe("session_key");
    });

    it("When session key contains multiple dangerous characters Then all should be replaced", () => {
      expect(sanitizeSessionKey("session/.\\:key")).toBe("session____key");
    });
  });

  describe("Given a session key exceeding maximum length", () => {
    const longKey = "a".repeat(200);

    it("When sanitizing long session key Then it should be truncated to 100 characters", () => {
      const result = sanitizeSessionKey(longKey);
      expect(result).toHaveLength(100);
    });
  });

  describe("Given a normal session key", () => {
    it("When sanitizing normal session key Then it should remain unchanged", () => {
      expect(sanitizeSessionKey("session-abc123")).toBe("session-abc123");
    });

    it("When session key is empty Then it should return empty string", () => {
      expect(sanitizeSessionKey("")).toBe("");
    });

    it("When session key contains special characters like hyphen Then they should remain", () => {
      expect(sanitizeSessionKey("session-key-123")).toBe("session-key-123");
    });
  });
});

describe("Inbox Directory Creation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Given a team name and session key", () => {
    it("When ensuring inbox directory exists Then it should create the directory recursively", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      await ensureInboxDirectory("my-team", "/teams", "session-key-123");

      expect(fs.mkdir).toHaveBeenCalledWith("/teams/my-team/inbox/session-key-123", {
        recursive: true,
      });
    });

    it("When ensuring inbox directory exists Then it should return the inbox path", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      const result = await ensureInboxDirectory("my-team", "/teams", "session-key-123");

      expect(result).toBe("/teams/my-team/inbox/session-key-123");
    });
  });

  describe("Given a session key with dangerous characters", () => {
    it("When ensuring inbox directory exists Then it should use sanitized session key", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);

      await ensureInboxDirectory("my-team", "/teams", "session/.:key");

      expect(fs.mkdir).toHaveBeenCalledWith("/teams/my-team/inbox/session___key", {
        recursive: true,
      });
    });
  });
});

describe("Write Inbox Message", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Given a message to write", () => {
    const message = {
      id: "msg-123",
      from: "sender-session",
      to: "recipient-session",
      type: "message",
      content: "Hello world",
      timestamp: 1234567890,
    };

    it("When writing to inbox Then it should ensure directory exists", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.appendFile).mockResolvedValue(undefined);

      await writeInboxMessage("my-team", "/teams", "recipient-session", message);

      expect(fs.mkdir).toHaveBeenCalledWith("/teams/my-team/inbox/recipient-session", {
        recursive: true,
      });
    });

    it("When writing to inbox Then it should append to messages.jsonl", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.appendFile).mockResolvedValue(undefined);

      await writeInboxMessage("my-team", "/teams", "recipient-session", message);

      expect(fs.appendFile).toHaveBeenCalledWith(
        "/teams/my-team/inbox/recipient-session/messages.jsonl",
        JSON.stringify(message) + "\n",
        { mode: 0o600 },
      );
    });

    it("When writing to inbox Then it should set correct file permissions", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.appendFile).mockResolvedValue(undefined);

      await writeInboxMessage("my-team", "/teams", "recipient-session", message);

      const appendCall = vi.mocked(fs.appendFile).mock.calls[0];
      expect(appendCall[2]).toEqual({ mode: 0o600 });
    });
  });

  describe("Given multiple messages", () => {
    const messages = [
      { id: "msg-1", content: "First message" },
      { id: "msg-2", content: "Second message" },
    ];

    it("When writing multiple messages Then each should be on a separate line", async () => {
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.appendFile).mockResolvedValue(undefined);

      await writeInboxMessage("my-team", "/teams", "recipient-session", messages[0]);
      await writeInboxMessage("my-team", "/teams", "recipient-session", messages[1]);

      const firstCall = vi.mocked(fs.appendFile).mock.calls[0][1];
      const secondCall = vi.mocked(fs.appendFile).mock.calls[1][1];

      expect(firstCall).toBe(JSON.stringify(messages[0]) + "\n");
      expect(secondCall).toBe(JSON.stringify(messages[1]) + "\n");
    });
  });
});

describe("Read Inbox Messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Given existing messages in the inbox", () => {
    const messages = [
      { id: "msg-1", from: "sender-1", content: "First message", timestamp: 1234567890 },
      { id: "msg-2", from: "sender-2", content: "Second message", timestamp: 1234567891 },
    ];

    it("When reading messages Then it should return all messages", async () => {
      const jsonlContent = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
      vi.mocked(fs.readFile).mockResolvedValue(jsonlContent);

      const result = await readInboxMessages("my-team", "/teams", "session-key");

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(messages[0]);
      expect(result[1]).toEqual(messages[1]);
    });

    it("When reading messages Then it should read from correct file path", async () => {
      const jsonlContent = messages.map((m) => JSON.stringify(m)).join("\n") + "\n";
      vi.mocked(fs.readFile).mockResolvedValue(jsonlContent);

      await readInboxMessages("my-team", "/teams", "session-key");

      expect(fs.readFile).toHaveBeenCalledWith(
        "/teams/my-team/inbox/session-key/messages.jsonl",
        "utf-8",
      );
    });
  });

  describe("Given an empty inbox file", () => {
    it("When reading messages Then it should return empty array", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("");

      const result = await readInboxMessages("my-team", "/teams", "session-key");

      expect(result).toEqual([]);
    });
  });

  describe("Given a non-existent inbox file", () => {
    it("When reading messages Then it should return empty array", async () => {
      const error = new Error("ENOENT") as Error & { code?: string };
      error.code = "ENOENT";
      vi.mocked(fs.readFile).mockRejectedValue(error);

      const result = await readInboxMessages("my-team", "/teams", "session-key");

      expect(result).toEqual([]);
    });
  });

  describe("Given a file with extra whitespace", () => {
    const messages = [{ id: "msg-1", content: "Message" }];

    it("When reading messages Then it should filter empty lines", async () => {
      const jsonlContent = JSON.stringify(messages[0]) + "\n\n  \n";
      vi.mocked(fs.readFile).mockResolvedValue(jsonlContent);

      const result = await readInboxMessages("my-team", "/teams", "session-key");

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(messages[0]);
    });
  });

  describe("Given invalid JSON in messages file", () => {
    it("When reading messages Then it should throw parse error", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("invalid json\n");

      await expect(readInboxMessages("my-team", "/teams", "session-key")).rejects.toThrow();
    });
  });
});

describe("Clear Inbox Messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Given existing messages in the inbox", () => {
    it("When clearing messages Then it should delete messages.jsonl", async () => {
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      await clearInboxMessages("my-team", "/teams", "session-key");

      expect(fs.unlink).toHaveBeenCalledWith("/teams/my-team/inbox/session-key/messages.jsonl");
    });
  });

  describe("Given a non-existent messages file", () => {
    it("When clearing messages Then it should succeed without error", async () => {
      const error = new Error("ENOENT") as Error & { code?: string };
      error.code = "ENOENT";
      vi.mocked(fs.unlink).mockRejectedValue(error);

      await expect(clearInboxMessages("my-team", "/teams", "session-key")).resolves.not.toThrow();
    });
  });

  describe("Given an error other than ENOENT", () => {
    it("When clearing messages Then it should throw the error", async () => {
      const error = new Error("EACCES") as Error & { code?: string };
      error.code = "EACCES";
      vi.mocked(fs.unlink).mockRejectedValue(error);

      await expect(clearInboxMessages("my-team", "/teams", "session-key")).rejects.toThrow();
    });
  });
});

describe("End-to-End Inbox Operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Given a complete message lifecycle", () => {
    const message = {
      id: "msg-123",
      from: "sender-session",
      to: "recipient-session",
      type: "message",
      content: "Hello world",
      timestamp: 1234567890,
    };

    it("When writing and reading messages Then round-trip should succeed", async () => {
      // Setup: Create directory and write message
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.appendFile).mockResolvedValue(undefined);

      await writeInboxMessage("my-team", "/teams", "recipient-session", message);

      // Read back
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(message) + "\n");

      const result = await readInboxMessages("my-team", "/teams", "recipient-session");

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(message);
    });

    it("When writing, reading, and clearing Then operations should complete successfully", async () => {
      // Write message
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.appendFile).mockResolvedValue(undefined);

      await writeInboxMessage("my-team", "/teams", "recipient-session", message);

      // Read message
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(message) + "\n");

      const messages = await readInboxMessages("my-team", "/teams", "recipient-session");
      expect(messages).toHaveLength(1);

      // Clear message
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      await expect(
        clearInboxMessages("my-team", "/teams", "recipient-session"),
      ).resolves.not.toThrow();
      expect(fs.unlink).toHaveBeenCalledWith(
        "/teams/my-team/inbox/recipient-session/messages.jsonl",
      );
    });
  });
});
