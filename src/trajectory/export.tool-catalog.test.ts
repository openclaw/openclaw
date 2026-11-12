import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { exportTrajectoryBundle } from "./export.js";
import { simpleSessionEntries } from "./export.test-helpers.js";
import { appendSqliteTrajectoryRuntimeEvents } from "./runtime-store.test-support.js";
import type { TrajectoryEvent } from "./types.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trajectory-tools-"));

afterAll(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("exportTrajectoryBundle", () => {
  it("keeps tool catalogs that follow a long compiled message list", async () => {
    const tmpDir = fs.mkdtempSync(path.join(tempRoot, "case-"));
    const sessionTarget = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      storePath: path.join(tmpDir, "sessions.json"),
    };
    const outputDir = path.join(tmpDir, "bundle");
    await replaceTranscriptEvents(sessionTarget, simpleSessionEntries(tmpDir));
    const secret = "sk-exported-session-secret";
    const messages = Array.from({ length: 64 }, (_, index) => ({
      role: "user",
      content: `message-${index}`,
    }));
    const tools = Array.from({ length: 20 }, (_, index) => ({
      name: `schema-tool-${index}`,
      description: index === 19 ? `lookup ${secret}` : `lookup ${index}`,
      parameters: { type: "object", properties: { query: { type: "string" } } },
    }));
    const event: TrajectoryEvent = {
      traceSchema: "openclaw-trajectory",
      schemaVersion: 1,
      traceId: "session-1",
      source: "runtime",
      type: "context.compiled",
      ts: "2026-04-22T08:00:00.000Z",
      seq: 1,
      sourceSeq: 1,
      sessionId: "session-1",
      data: { messages, tools, providerVisibleTools: tools },
    };
    appendSqliteTrajectoryRuntimeEvents(sessionTarget, [event]);

    await exportTrajectoryBundle({
      outputDir,
      sessionId: "session-1",
      workspaceDir: tmpDir,
      sessionTarget,
    });

    const compiled = fs
      .readFileSync(path.join(outputDir, "events.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as TrajectoryEvent)
      .find((item) => item.type === "context.compiled");
    const names = tools.map((tool) => ({ name: tool.name }));
    expect(compiled?.data?.tools).toMatchObject(names);
    expect(compiled?.data?.providerVisibleTools).toMatchObject(names);
    expect(compiled?.data?.messages).toEqual(messages);
    const exportedTools = JSON.parse(
      fs.readFileSync(path.join(outputDir, "tools.json"), "utf8"),
    ) as Array<{
      name: string;
    }>;
    expect(exportedTools.map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
    const bundleText = fs
      .readdirSync(outputDir)
      .map((file) => fs.readFileSync(path.join(outputDir, file), "utf8"))
      .join("\n");
    expect(bundleText).not.toContain(secret);
  });
});
