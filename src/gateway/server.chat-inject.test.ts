import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks();

describe("chat.inject", () => {
  test("chat.inject appends message to transcript and broadcasts", async () => {
    // Set up session store with a valid session
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-inject-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    const sessionId = `sess-inject-${Date.now()}`;
    const transcriptPath = path.join(dir, `${sessionId}.jsonl`);

    // Create session store
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    // Create empty transcript file
    await fs.writeFile(transcriptPath, "", "utf-8");

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    // Call chat.inject
    const res = await rpcReq(ws, "chat.inject", {
      sessionKey: "main",
      message: "This is an injected message",
      label: "Subagent",
    });

    expect(res.ok).toBe(true);
    expect((res.payload as { messageId?: string })?.messageId).toBeDefined();

    // Verify transcript was appended
    const transcriptContent = await fs.readFile(transcriptPath, "utf-8");
    const lines = transcriptContent.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.type).toBe("message");
    expect(entry.message.role).toBe("assistant");
    expect(entry.message.stopReason).toBe("injected");
    expect(entry.message.content[0].text).toContain("[Subagent]");
    expect(entry.message.content[0].text).toContain("This is an injected message");

    ws.close();
    await server.close();
  });

  test("chat.inject fails for non-existent session", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-inject-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");

    // Create empty session store
    await fs.writeFile(testState.sessionStorePath, JSON.stringify({}), "utf-8");

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "chat.inject", {
      sessionKey: "nonexistent",
      message: "This should fail",
    });

    expect(res.ok).toBe(false);
    expect((res.error as { message?: string })?.message).toMatch(/session not found/i);

    ws.close();
    await server.close();
  });

  test("chat.inject fails for missing transcript file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-inject-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    const sessionId = `sess-no-transcript-${Date.now()}`;

    // Create session store without transcript file
    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "chat.inject", {
      sessionKey: "main",
      message: "This should fail",
    });

    expect(res.ok).toBe(false);
    expect((res.error as { message?: string })?.message).toMatch(/transcript file not found/i);

    ws.close();
    await server.close();
  });

  test("chat.inject works without label", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-inject-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    const sessionId = `sess-no-label-${Date.now()}`;
    const transcriptPath = path.join(dir, `${sessionId}.jsonl`);

    await fs.writeFile(
      testState.sessionStorePath,
      JSON.stringify(
        {
          main: {
            sessionId,
            updatedAt: Date.now(),
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    await fs.writeFile(transcriptPath, "", "utf-8");

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const res = await rpcReq(ws, "chat.inject", {
      sessionKey: "main",
      message: "Message without label",
    });

    expect(res.ok).toBe(true);

    const transcriptContent = await fs.readFile(transcriptPath, "utf-8");
    const entry = JSON.parse(transcriptContent.trim());
    expect(entry.message.content[0].text).toBe("Message without label");
    expect(entry.message.content[0].text).not.toContain("[");

    ws.close();
    await server.close();
  });
});
