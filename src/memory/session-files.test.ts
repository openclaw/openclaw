import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSessionEntry } from "./session-files.js";

describe("buildSessionEntry", () => {
  it("includes tool result artifact references in session content", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-files-"));
    const sessionFile = path.join(dir, "session.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: "session-1",
      timestamp: new Date().toISOString(),
      cwd: "/tmp",
    };
    const toolMessage = {
      type: "message",
      id: "msg-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolName: "exec",
        content: [{ type: "text", text: "placeholder" }],
        details: {
          artifactRef: {
            id: "art_123",
            summary: "command output",
            toolName: "exec",
          },
        },
      },
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify(toolMessage)}\n`,
      "utf-8",
    );

    const entry = await buildSessionEntry(sessionFile);
    expect(entry).toBeTruthy();
    expect(entry?.content).toContain("ToolResult (exec): command output [artifact:art_123]");
  });

  it("skips tool results without artifact refs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-files-"));
    const sessionFile = path.join(dir, "session.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: "session-1",
      timestamp: new Date().toISOString(),
      cwd: "/tmp",
    };
    const toolMessage = {
      type: "message",
      id: "msg-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "toolResult",
        toolName: "exec",
        content: [{ type: "text", text: "raw output" }],
      },
    };
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify(toolMessage)}\n`,
      "utf-8",
    );

    const entry = await buildSessionEntry(sessionFile);
    expect(entry?.content).toBe("");
  });
});
