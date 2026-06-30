// `openclaw memory backfill` command (04-03): end-to-end seed → organize for one validated
// agent, foreground, resumable. Proves turns seed + spans/boxes appear after one run, a second
// run reports zero new turns / no duplicate spans (cursor-driven idempotency through the
// command), and that a coercion-prone --agent id is rejected before any resolution. DI: temp
// transcripts dir + DB env injected; runtime is a capture stub, never the real process runtime.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listBoxes, listSpans, getTurns } from "../agents/memory/turns-store.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { runMemoryBackfillCommand } from "./memory-backfill.js";

const AGENT_ID = "main";
const SESSION_KEY = "agent:main:main";

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function env(stateDir: string): NodeJS.ProcessEnv {
  return { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
}

function headerLine(id: string): string {
  return JSON.stringify({
    type: "session",
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp",
  });
}

function messageLine(opts: {
  id: string;
  role: "user" | "assistant";
  text: string;
  msgTs: number;
}): string {
  return JSON.stringify({
    type: "message",
    id: opts.id,
    parentId: null,
    timestamp: new Date(opts.msgTs).toISOString(),
    message: {
      role: opts.role,
      content: [{ type: "text", text: opts.text }],
      timestamp: opts.msgTs,
    },
  });
}

function writeTranscript(dir: string, name: string, lines: string[]): void {
  fs.writeFileSync(path.join(dir, name), `${lines.join("\n")}\n`, "utf8");
}

type CaptureRuntime = RuntimeEnv & { logs: string[]; errors: string[]; exitCode: number | null };

function captureRuntime(): CaptureRuntime {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    exitCode: null,
    log: (...args: unknown[]) => logs.push(args.join(" ")),
    error: (...args: unknown[]) => errors.push(args.join(" ")),
    exit(code: number) {
      this.exitCode = code;
    },
  };
}

function seedFixtures(transcriptsDir: string): void {
  writeTranscript(transcriptsDir, "fileA.jsonl", [
    headerLine("fileA"),
    messageLine({
      id: "a1",
      role: "user",
      text: "Deploy the NEBULA-73 telemetry service",
      msgTs: 100,
    }),
    messageLine({
      id: "a2",
      role: "assistant",
      text: "NEBULA-73 telemetry deployment finished",
      msgTs: 200,
    }),
  ]);
  writeTranscript(transcriptsDir, "fileB.jsonl", [
    headerLine("fileB"),
    messageLine({
      id: "b1",
      role: "user",
      text: "Review the billing reconciliation report",
      msgTs: 300,
    }),
  ]);
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("runMemoryBackfillCommand", () => {
  it("seeds then organizes, and a re-run is idempotent end-to-end", async () => {
    const transcriptsDir = tempDir("openclaw-mb-src-");
    const stateDir = tempDir("openclaw-mb-state-");
    seedFixtures(transcriptsDir);
    const dbOpts = { agentId: AGENT_ID, sessionKey: SESSION_KEY, env: env(stateDir) };

    const rt1 = captureRuntime();
    await runMemoryBackfillCommand({ agent: AGENT_ID, env: env(stateDir), transcriptsDir }, rt1);
    expect(rt1.exitCode).toBeNull();

    expect(getTurns(dbOpts)).toHaveLength(3);
    expect(listSpans(dbOpts).length).toBeGreaterThan(0);
    expect(listBoxes(dbOpts).length).toBeGreaterThan(0);

    const spansAfterFirst = listSpans(dbOpts).length;
    const boxesAfterFirst = listBoxes(dbOpts).length;

    // Second invocation resumes from the cursors: no new turns, no duplicate spans/boxes.
    const rt2 = captureRuntime();
    await runMemoryBackfillCommand({ agent: AGENT_ID, env: env(stateDir), transcriptsDir }, rt2);
    expect(rt2.exitCode).toBeNull();
    expect(rt2.logs.join("\n")).toContain("0 new turn(s)");
    expect(getTurns(dbOpts)).toHaveLength(3);
    expect(listSpans(dbOpts).length).toBe(spansAfterFirst);
    expect(listBoxes(dbOpts).length).toBe(boxesAfterFirst);
  });

  it("emits aggregate JSON when --json is set", async () => {
    const transcriptsDir = tempDir("openclaw-mb-json-src-");
    const stateDir = tempDir("openclaw-mb-json-state-");
    seedFixtures(transcriptsDir);

    const rt = captureRuntime();
    await runMemoryBackfillCommand(
      { agent: AGENT_ID, json: true, env: env(stateDir), transcriptsDir },
      rt,
    );
    const payload = JSON.parse(rt.logs.join("")) as {
      agentId: string;
      sessionKey: string;
      seed: { inserted: number };
    };
    expect(payload.agentId).toBe(AGENT_ID);
    expect(payload.sessionKey).toBe(SESSION_KEY);
    expect(payload.seed.inserted).toBe(3);
  });

  it("rejects a missing --agent without touching the store", async () => {
    const rt = captureRuntime();
    await runMemoryBackfillCommand({}, rt);
    expect(rt.exitCode).toBe(1);
    expect(rt.errors.join("\n")).toContain("--agent");
  });

  it("rejects a coercion-prone --agent id before any resolution", async () => {
    const rt = captureRuntime();
    await runMemoryBackfillCommand({ agent: "../other" }, rt);
    expect(rt.exitCode).toBe(1);
    expect(rt.errors.join("\n")).toContain("Invalid --agent");
  });
});
