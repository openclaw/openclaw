import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readSessionMessagesTail } from "./session-utils.fs.js";

describe("readSessionMessagesTail", () => {
  test("reads last N messages from a large file in correct order", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tail-test-"));
    const filePath = path.join(tmpDir, "session.jsonl");

    try {
      // Create a file with 1000 messages
      const lines: string[] = [];
      for (let i = 0; i < 1000; i++) {
        lines.push(
          JSON.stringify({
            message: {
              role: "user",
              content: [{ type: "text", text: `msg-${i}` }],
              timestamp: 1000 + i,
            },
          }),
        );
      }
      fs.writeFileSync(filePath, lines.join("\n"), "utf-8");

      // Read last 50
      const messages = readSessionMessagesTail("test-session", undefined, filePath, 50) as any[];

      expect(messages.length).toBe(50);
      expect(messages[0].content[0].text).toBe("msg-950");
      expect(messages[49].content[0].text).toBe("msg-999");

      // Read last 5
      const messagesSmall = readSessionMessagesTail(
        "test-session",
        undefined,
        filePath,
        5,
      ) as any[];
      expect(messagesSmall.length).toBe(5);
      expect(messagesSmall[0].content[0].text).toBe("msg-995");
      expect(messagesSmall[4].content[0].text).toBe("msg-999");

      // Read more than exists (should get all 1000)
      const messagesAll = readSessionMessagesTail(
        "test-session",
        undefined,
        filePath,
        2000,
      ) as any[];
      expect(messagesAll.length).toBe(1000);
      expect(messagesAll[0].content[0].text).toBe("msg-0");
      expect(messagesAll[999].content[0].text).toBe("msg-999");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("handles empty files gracefully", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tail-test-empty-"));
    const filePath = path.join(tmpDir, "session.jsonl");
    try {
      fs.writeFileSync(filePath, "", "utf-8");
      const messages = readSessionMessagesTail("test-session", undefined, filePath, 50);
      expect(messages).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
