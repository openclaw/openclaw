import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendSupervisorDecisionOutcomeRecord,
  buildSupervisorDecisionOutcomeRecord,
  readSupervisorDecisionOutcomeRecords,
  resolveSupervisorOutcomeRecordPath,
} from "./outcome-record.js";

describe("supervisor outcome records", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("resolves a per-session outcome path parallel to sessions", () => {
    const sessionFile = "/tmp/openclaw/agents/main/sessions/sess-1.jsonl";
    expect(resolveSupervisorOutcomeRecordPath(sessionFile)).toBe(
      "/tmp/openclaw/agents/main/supervisor-outcomes/sess-1.jsonl",
    );
  });

  it("appends outcome jsonl records", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-supervisor-outcomes-"));
    cleanup.push(tmpDir);
    const sessionFile = path.join(tmpDir, "agents", "main", "sessions", "sess-1.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "", "utf-8");

    const record = buildSupervisorDecisionOutcomeRecord({
      decisionId: "dec-1",
      sessionKey: "agent:main:thread-1",
      sessionId: "sess-1",
      signal: "runtime_applied",
      payload: { action: "append" },
    });

    await appendSupervisorDecisionOutcomeRecord({ sessionFile, record });

    const content = await fs.readFile(resolveSupervisorOutcomeRecordPath(sessionFile), "utf-8");
    const parsed = JSON.parse(content.trim()) as { signal: string; decisionId: string };
    expect(parsed).toMatchObject({
      signal: "runtime_applied",
      decisionId: "dec-1",
    });
  });

  it("reads all recorded outcomes for a session", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-supervisor-outcomes-read-"));
    cleanup.push(tmpDir);
    const sessionFile = path.join(tmpDir, "agents", "main", "sessions", "sess-1.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "", "utf-8");

    await appendSupervisorDecisionOutcomeRecord({
      sessionFile,
      record: buildSupervisorDecisionOutcomeRecord({
        decisionId: "dec-1",
        sessionKey: "agent:main:thread-1",
        sessionId: "sess-1",
        signal: "runtime_applied",
        payload: { action: "append" },
      }),
    });
    await appendSupervisorDecisionOutcomeRecord({
      sessionFile,
      record: buildSupervisorDecisionOutcomeRecord({
        decisionId: "dec-1",
        sessionKey: "agent:main:thread-1",
        sessionId: "sess-1",
        signal: "presentation_planned",
        payload: { summary: { status: { planned: true } } },
      }),
    });
    await appendSupervisorDecisionOutcomeRecord({
      sessionFile,
      record: buildSupervisorDecisionOutcomeRecord({
        decisionId: "dec-1",
        sessionKey: "agent:main:thread-1",
        sessionId: "sess-1",
        signal: "status_scheduled",
        payload: { templateId: "status.redirecting_current_task" },
      }),
    });

    await expect(readSupervisorDecisionOutcomeRecords(sessionFile)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ signal: "runtime_applied" }),
        expect.objectContaining({ signal: "presentation_planned" }),
        expect.objectContaining({ signal: "status_scheduled" }),
      ]),
    );
  });
});
