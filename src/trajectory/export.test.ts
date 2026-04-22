import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { exportTrajectoryBundle } from "./export.js";
import type { TrajectoryEvent } from "./types.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trajectory-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("exportTrajectoryBundle", () => {
  it("exports merged runtime and transcript events plus convenience files", () => {
    const tmpDir = makeTempDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const runtimeFile = path.join(tmpDir, "session.trajectory.jsonl");
    const outputDir = path.join(tmpDir, "bundle");
    const sessionManager = SessionManager.open(sessionFile);

    sessionManager.appendSessionInfo("Trajectory Test");
    sessionManager.appendMessage({ role: "user", content: "hello" });
    sessionManager.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_1",
          name: "read",
          arguments: { filePath: path.join(tmpDir, "skills", "weather", "SKILL.md") },
        },
      ],
    });
    sessionManager.appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "README contents" }],
    });
    sessionManager.appendMessage({ role: "assistant", content: "done" });

    const runtimeEvents: TrajectoryEvent[] = [
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "session-1",
        source: "runtime",
        type: "session.started",
        ts: "2026-04-22T08:00:00.000Z",
        seq: 1,
        sourceSeq: 1,
        sessionId: "session-1",
        data: { trigger: "user" },
      },
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "session-1",
        source: "runtime",
        type: "context.compiled",
        ts: "2026-04-22T08:00:01.000Z",
        seq: 2,
        sourceSeq: 2,
        sessionId: "session-1",
        data: {
          systemPrompt: "system prompt",
          tools: [{ name: "read", parameters: { type: "object" } }],
        },
      },
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "session-1",
        source: "runtime",
        type: "trace.metadata",
        ts: "2026-04-22T08:00:01.500Z",
        seq: 3,
        sourceSeq: 3,
        sessionId: "session-1",
        data: {
          harness: { type: "openclaw", version: "0.1.0" },
          model: { provider: "openai", name: "gpt-5.4" },
          skills: {
            entries: [
              {
                id: "weather",
                filePath: path.join(tmpDir, "skills", "weather", "SKILL.md"),
              },
            ],
          },
        },
      },
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "session-1",
        source: "runtime",
        type: "prompt.submitted",
        ts: "2026-04-22T08:00:02.000Z",
        seq: 4,
        sourceSeq: 4,
        sessionId: "session-1",
        data: {
          prompt: "Please read the weather skill",
        },
      },
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "session-1",
        source: "runtime",
        type: "trace.artifacts",
        ts: "2026-04-22T08:00:03.000Z",
        seq: 5,
        sourceSeq: 5,
        sessionId: "session-1",
        data: {
          finalStatus: "success",
          assistantTexts: ["done"],
          itemLifecycle: {
            startedCount: 1,
            completedCount: 1,
            activeCount: 0,
          },
        },
      },
    ];
    fs.writeFileSync(
      runtimeFile,
      `${runtimeEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );

    const bundle = exportTrajectoryBundle({
      outputDir,
      sessionFile,
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      workspaceDir: tmpDir,
      runtimeFile,
      systemPrompt: "fallback prompt",
      tools: [{ name: "fallback" }],
    });

    expect(bundle.manifest.eventCount).toBeGreaterThanOrEqual(5);
    expect(bundle.manifest.runtimeEventCount).toBe(runtimeEvents.length);
    expect(fs.existsSync(path.join(outputDir, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "events.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "session.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "runtime.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "system-prompt.txt"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "tools.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "metadata.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "artifacts.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "prompts.json"))).toBe(true);
    expect(bundle.supplementalFiles).toEqual(["metadata.json", "artifacts.json", "prompts.json"]);

    const exportedEvents = fs
      .readFileSync(path.join(outputDir, "events.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as TrajectoryEvent);
    expect(exportedEvents.some((event) => event.type === "tool.call")).toBe(true);
    expect(exportedEvents.some((event) => event.type === "tool.result")).toBe(true);
    expect(exportedEvents.some((event) => event.type === "context.compiled")).toBe(true);

    const metadata = JSON.parse(fs.readFileSync(path.join(outputDir, "metadata.json"), "utf8")) as {
      skills?: { entries?: Array<{ id?: string; invoked?: boolean }> };
    };
    expect(metadata.skills?.entries?.[0]).toMatchObject({
      id: "weather",
      invoked: true,
    });
  });
});
