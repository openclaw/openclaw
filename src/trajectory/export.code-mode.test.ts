// Trajectory export keeps Code Mode evidence whole: large or unparseable tool text survives
// credential redaction, and nested calls appear as standard tool calls under their parent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { createNestedToolActivity } from "../sessions/nested-tool-activity.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { exportTrajectoryBundle } from "./export.js";
import {
  assistantMessage,
  messageEntry,
  sessionHeader,
  userMessage,
} from "./export.test-helpers.js";

const tempDirs: string[] = [];

afterAll(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("exportTrajectoryBundle Code Mode evidence", () => {
  it("keeps whole Code Mode output and nested tool calls while redacting credentials", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trajectory-code-mode-"));
    tempDirs.push(tmpDir);
    const outputDir = path.join(tmpDir, "bundle");
    const sessionTarget = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      storePath: path.join(tmpDir, "sessions.json"),
    };
    const records = Array.from({ length: 600 }, (_, index) => ({
      id: index,
      subject: `mail-${index}-marker`,
    }));
    const envelope = JSON.stringify({
      ok: true,
      result: { records },
      apiKey: "plain-api-key-value-123456",
      note: "Authorization: Bearer sk-exported-code-mode-secret",
    });
    expect(envelope.length).toBeGreaterThan(16 * 1024);
    const script = 'const rows = await tools.read({ path: "inbox.json" });\nreturn { rows: [rows';
    const nested = (
      id: string,
      toolName: string,
      input: unknown,
      result: { content: unknown[]; details?: unknown },
    ) => ({
      type: "message",
      id: `entry-${id}`,
      timestamp: "2026-04-01T05:46:42.000Z",
      message: createNestedToolActivity({
        runId: "run-1",
        scopeId: "scope-1",
        afterEntryId: "entry-exec",
        startOrder: 0,
        parentToolCallId: "call_exec",
        toolCallId: id,
        toolName,
        input,
        result,
        isError: false,
        startedAt: 1,
        timestamp: 2,
      }),
    });
    const entries = [
      sessionHeader(tmpDir),
      messageEntry("entry-user", null, userMessage("triage the inbox"), 40),
      messageEntry(
        "entry-exec",
        "entry-user",
        assistantMessage([
          { type: "toolCall", id: "call_exec", name: "exec", arguments: { code: script } },
        ]),
      ),
      {
        ...nested(
          "nested-read",
          "read",
          { path: "inbox.json" },
          { content: [{ type: "text", text: "mail-7-marker" }] },
        ),
        parentId: "entry-exec",
      },
      {
        ...nested(
          "nested-spawn",
          "sessions_spawn",
          { task: "summarize" },
          {
            content: [{ type: "text", text: "accepted" }],
            details: { status: "accepted", childSessionKey: "agent:main:subagent:child" },
          },
        ),
        parentId: "entry-nested-read",
      },
      messageEntry(
        "entry-exec-result",
        "entry-nested-spawn",
        {
          role: "toolResult",
          toolCallId: "call_exec",
          toolName: "exec",
          content: [{ type: "text", text: envelope }],
          isError: false,
          timestamp: 3,
        },
        43,
      ),
    ];
    await replaceTranscriptEvents(sessionTarget, entries);

    const bundle = await exportTrajectoryBundle({
      outputDir,
      sessionId: "session-1",
      workspaceDir: tmpDir,
      sessionTarget,
    });

    const bundleText = fs
      .readdirSync(outputDir)
      .map((file) => fs.readFileSync(path.join(outputDir, file), "utf8"))
      .join("\n");
    for (const text of [
      JSON.stringify(bundle.events),
      fs.readFileSync(path.join(outputDir, "session-branch.json"), "utf8"),
    ]) {
      for (const record of records) {
        expect(text).toContain(record.subject);
      }
      expect(text).toContain(JSON.stringify(script).slice(1, -1));
    }
    for (const secret of ["plain-api-key-value-123456", "sk-exported-code-mode-secret"]) {
      expect(bundleText).not.toContain(secret);
    }
    expect(bundleText).not.toMatch(/diagnostic JSON redacted|\[Truncated\]/u);
    const calls = bundle.events.filter((event) => event.type === "tool.call");
    expect(calls.map((event) => event.data)).toEqual([
      expect.objectContaining({ toolCallId: "call_exec", assistantEntryId: "entry-exec" }),
      {
        toolCallId: "nested-read",
        name: "read",
        arguments: { path: "inbox.json" },
        assistantEntryId: "entry-exec",
        parentToolCallId: "call_exec",
      },
      {
        toolCallId: "nested-spawn",
        name: "sessions_spawn",
        arguments: { task: "summarize" },
        assistantEntryId: "entry-exec",
        parentToolCallId: "call_exec",
      },
    ]);
    const nestedResult = bundle.events.find(
      (event) =>
        event.type === "tool.result" &&
        (event.data?.message as { toolCallId?: string } | undefined)?.toolCallId === "nested-spawn",
    );
    expect(nestedResult?.data).toEqual({
      parentToolCallId: "call_exec",
      message: {
        role: "toolResult",
        toolCallId: "nested-spawn",
        toolName: "sessions_spawn",
        content: [{ type: "text", text: "accepted" }],
        details: { status: "accepted", childSessionKey: "agent:main:subagent:child" },
        isError: false,
        timestamp: 2,
      },
    });
    expect(bundle.events.map((event) => event.type)).not.toContain("message.custom");
  });
});
