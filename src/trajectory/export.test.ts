import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { writeSqliteToolArtifact } from "../agents/filesystem/tool-artifact-store.sqlite.js";
import type { Message, Usage } from "../agents/pi-ai-contract.js";
import { replaceSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { exportTrajectoryBundle, resolveDefaultTrajectoryExportDir } from "./export.js";
import { recordTrajectoryRuntimeEvent } from "./runtime-store.sqlite.js";
import type { TrajectoryEvent } from "./types.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trajectory-"));
let tempDirId = 0;
const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;

function makeTempDir(): string {
  const dir = path.join(tempRoot, `case-${tempDirId++}`);
  fs.mkdirSync(dir, { recursive: true });
  if (process.env.OPENCLAW_STATE_DIR === originalOpenClawStateDir) {
    process.env.OPENCLAW_STATE_DIR = path.join(dir, "state");
  }
  return dir;
}

const emptyUsage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function userMessage(content: string): Message {
  return {
    role: "user",
    content,
    timestamp: 1,
  };
}

function assistantMessage(content: Extract<Message, { role: "assistant" }>["content"]): Message {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: emptyUsage,
    stopReason: "stop",
    timestamp: 2,
  };
}

function toolResultMessage(content: Extract<Message, { role: "toolResult" }>["content"]): Message {
  return {
    role: "toolResult",
    toolCallId: "call_1",
    toolName: "read",
    content,
    isError: false,
    timestamp: 3,
  };
}

function eventTypes(events: readonly Pick<TrajectoryEvent, "type">[]): string[] {
  return events.map((event) => event.type);
}

function recordRuntimeEvents(events: readonly TrajectoryEvent[]): void {
  for (const event of events) {
    recordTrajectoryRuntimeEvent({ agentId: "main", event });
  }
}

function writeSessionTranscript(entries: Record<string, unknown>[]): void {
  const header = entries.find((entry) => entry.type === "session") as { id?: unknown } | undefined;
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: typeof header?.id === "string" ? header.id : "session-1",
    events: entries,
  });
}

function writeSimpleSessionTranscript(
  workspaceDir: string,
  params: { userEntryTimestamp?: string | number } = {},
): void {
  const header = {
    type: "session",
    version: 3,
    id: "session-1",
    timestamp: "2026-04-01T05:46:39.000Z",
    cwd: workspaceDir,
  };
  const userEntry = {
    type: "message",
    id: "entry-user",
    parentId: null,
    timestamp: params.userEntryTimestamp ?? "2026-04-01T05:46:40.000Z",
    message: userMessage("hello"),
  };
  const assistantEntry = {
    type: "message",
    id: "entry-assistant",
    parentId: "entry-user",
    timestamp: "2026-04-01T05:46:41.000Z",
    message: assistantMessage([{ type: "text", text: "done" }]),
  };
  writeSessionTranscript([header, userEntry, assistantEntry]);
}

function writeToolCallOnlySessionTranscript(workspaceDir: string): void {
  const header = {
    type: "session",
    version: 3,
    id: "session-1",
    timestamp: "2026-04-01T05:46:39.000Z",
    cwd: workspaceDir,
  };
  const assistantEntry = {
    type: "message",
    id: "entry-assistant",
    parentId: null,
    timestamp: "2026-04-01T05:46:41.000Z",
    message: assistantMessage([
      {
        type: "toolCall",
        id: "call_1",
        name: "read",
        arguments: { filePath: "README.md" },
      },
    ]),
  };
  writeSessionTranscript([header, assistantEntry]);
}

function writeToolCallSessionTranscript(workspaceDir: string): void {
  const header = {
    type: "session",
    version: 3,
    id: "session-1",
    timestamp: "2026-04-01T05:46:39.000Z",
    cwd: workspaceDir,
    title: "Trajectory Test",
  };
  const entries = [
    header,
    {
      type: "message",
      id: "entry-user",
      parentId: null,
      timestamp: "2026-04-01T05:46:40.000Z",
      message: userMessage("hello"),
    },
    {
      type: "message",
      id: "entry-tool-call",
      parentId: "entry-user",
      timestamp: "2026-04-01T05:46:41.000Z",
      message: assistantMessage([
        {
          type: "toolCall",
          id: "call_1",
          name: "read",
          arguments: {
            filePath: path.join(workspaceDir, "skills", "weather", "SKILL.md"),
          },
        },
      ]),
    },
    {
      type: "message",
      id: "entry-tool-result",
      parentId: "entry-tool-call",
      timestamp: "2026-04-01T05:46:42.000Z",
      message: toolResultMessage([{ type: "text", text: "README contents" }]),
    },
    {
      type: "message",
      id: "entry-assistant",
      parentId: "entry-tool-result",
      timestamp: "2026-04-01T05:46:43.000Z",
      message: assistantMessage([{ type: "text", text: "done" }]),
    },
  ];
  writeSessionTranscript(entries);
}

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  if (originalOpenClawStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
  }
});

describe("exportTrajectoryBundle", () => {
  it("sanitizes session ids in default export directory names", () => {
    const outputDir = resolveDefaultTrajectoryExportDir({
      workspaceDir: "/tmp/workspace",
      sessionId: "../evil/session",
      now: new Date("2026-04-22T08:00:00.000Z"),
    });

    expect(outputDir).toBe(
      path.join(
        "/tmp/workspace",
        ".openclaw",
        "trajectory-exports",
        "openclaw-trajectory-___evil_-2026-04-22T08-00-00",
      ),
    );
  });

  it("refuses to write into an existing output directory", async () => {
    const tmpDir = makeTempDir();
    const outputDir = path.join(tmpDir, "bundle");
    writeSimpleSessionTranscript(tmpDir);
    fs.mkdirSync(outputDir);

    try {
      await exportTrajectoryBundle({
        outputDir,
        agentId: "main",
        sessionId: "session-1",
        workspaceDir: tmpDir,
      });
      throw new Error("expected trajectory export to reject an existing output directory");
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("EEXIST");
    }
  });

  it("does not synthesize prompt files from export-time fallbacks", async () => {
    const tmpDir = makeTempDir();
    const outputDir = path.join(tmpDir, "bundle");
    writeSimpleSessionTranscript(tmpDir);

    const bundle = await exportTrajectoryBundle({
      outputDir,
      agentId: "main",
      sessionId: "session-1",
      workspaceDir: tmpDir,
      systemPrompt: "fallback prompt",
      tools: [{ name: "fallback" }],
    });

    expect(bundle.supplementalFiles).not.toContain("prompts.json");
    expect(fs.existsSync(path.join(outputDir, "prompts.json"))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, "system-prompt.txt"))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, "tools.json"))).toBe(false);
  });

  it("preserves numeric transcript timestamps", async () => {
    const tmpDir = makeTempDir();
    const outputDir = path.join(tmpDir, "bundle");
    writeSimpleSessionTranscript(tmpDir, {
      userEntryTimestamp: Date.parse("2026-04-01T05:46:40.000Z"),
    });

    await exportTrajectoryBundle({
      outputDir,
      agentId: "main",
      sessionId: "session-1",
      workspaceDir: tmpDir,
    });

    const exportedEvents = fs
      .readFileSync(path.join(outputDir, "events.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as TrajectoryEvent);
    expect(exportedEvents.find((event) => event.type === "user.message")?.ts).toBe(
      "2026-04-01T05:46:40.000Z",
    );
  });

  it("includes run-scoped SQLite tool artifact metadata without embedding blobs", async () => {
    const tmpDir = makeTempDir();
    process.env.OPENCLAW_STATE_DIR = path.join(tmpDir, "state");
    const outputDir = path.join(tmpDir, "bundle");
    writeSimpleSessionTranscript(tmpDir);
    const event: TrajectoryEvent = {
      traceSchema: "openclaw-trajectory",
      schemaVersion: 1,
      traceId: "session-1",
      source: "runtime",
      type: "trace.artifacts",
      ts: "2026-04-01T05:46:42.000Z",
      seq: 1,
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      runId: "run-1",
      data: { finalStatus: "success" },
    };
    recordRuntimeEvents([event]);
    writeSqliteToolArtifact({
      agentId: "main",
      runId: "run-1",
      artifactId: "image_generate-call-1",
      kind: "tool/media-manifest",
      metadata: {
        toolName: "image_generate",
        mediaUrls: [path.join(tmpDir, "generated.png")],
      },
      blob: "large duplicated payload",
    });

    await exportTrajectoryBundle({
      outputDir,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      workspaceDir: tmpDir,
    });

    const artifacts = JSON.parse(fs.readFileSync(path.join(outputDir, "artifacts.json"), "utf8"));
    expect(artifacts.toolArtifacts).toEqual([
      expect.objectContaining({
        agentId: "main",
        runId: "run-1",
        artifactId: "image_generate-call-1",
        kind: "tool/media-manifest",
        metadata: {
          toolName: "image_generate",
          mediaUrls: ["$WORKSPACE_DIR/generated.png"],
        },
        size: "large duplicated payload".length,
      }),
    ]);
    expect(JSON.stringify(artifacts)).not.toContain("large duplicated payload");
    expect(JSON.stringify(artifacts)).not.toContain("blobBase64");
  });

  it("rejects legacy transcript files that were not imported into SQLite", async () => {
    const tmpDir = makeTempDir();
    const outputDir = path.join(tmpDir, "bundle");

    await expect(
      exportTrajectoryBundle({
        outputDir,
        agentId: "main",
        sessionId: "session-1",
        workspaceDir: tmpDir,
      }),
    ).rejects.toThrow(/Transcript is not in SQLite/u);
  });

  it("reads runtime trajectory events from SQLite before sorting", async () => {
    const tmpDir = makeTempDir();
    const outputDir = path.join(tmpDir, "bundle");
    writeSimpleSessionTranscript(tmpDir);
    recordRuntimeEvents([
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
      },
    ]);

    const bundle = await exportTrajectoryBundle({
      outputDir,
      agentId: "main",
      sessionId: "session-1",
      workspaceDir: tmpDir,
    });

    expect(bundle.manifest.runtimeEventCount).toBe(1);
    expect(eventTypes(bundle.events)).toContain("session.started");
  });

  it("counts expanded transcript events when enforcing the total event limit", async () => {
    const tmpDir = makeTempDir();
    const outputDir = path.join(tmpDir, "bundle");
    writeToolCallOnlySessionTranscript(tmpDir);

    await expect(
      exportTrajectoryBundle({
        outputDir,
        agentId: "main",
        sessionId: "session-1",
        workspaceDir: tmpDir,
        maxTotalEvents: 1,
      }),
    ).rejects.toThrow(/too many events \(2; limit 1\)/u);
  });

  it("skips runtime events for other sessions", async () => {
    const tmpDir = makeTempDir();
    const outputDir = path.join(tmpDir, "bundle");
    writeSimpleSessionTranscript(tmpDir);
    recordRuntimeEvents([
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "other-session",
        source: "runtime",
        type: "other-runtime",
        ts: "2026-04-22T08:00:00.000Z",
        seq: 1,
        sourceSeq: 1,
        sessionId: "other-session",
      },
    ]);

    const bundle = await exportTrajectoryBundle({
      outputDir,
      agentId: "main",
      sessionId: "session-1",
      workspaceDir: tmpDir,
    });

    expect(bundle.manifest.runtimeEventCount).toBe(0);
    expect(eventTypes(bundle.events)).not.toContain("other-runtime");
  });

  it("redacts non-workspace paths in strings that also contain workspace paths", async () => {
    const tmpDir = makeTempDir();
    const homeDir = makeTempDir();
    const outputDir = path.join(tmpDir, "bundle");
    const previousHome = process.env.HOME;
    writeSimpleSessionTranscript(tmpDir);
    recordRuntimeEvents([
      {
        traceSchema: "openclaw-trajectory",
        schemaVersion: 1,
        traceId: "session-1",
        source: "runtime",
        type: "mixed-paths",
        ts: "2026-04-22T08:00:00.000Z",
        seq: 1,
        sourceSeq: 1,
        sessionId: "session-1",
        data: {
          value: `workspace=${path.join(tmpDir, "inside.txt")} home=${path.join(
            homeDir,
            "secret.txt",
          )}`,
        },
      },
    ]);

    process.env.HOME = homeDir;
    try {
      await exportTrajectoryBundle({
        outputDir,
        agentId: "main",
        sessionId: "session-1",
        workspaceDir: tmpDir,
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
    }

    const events = fs.readFileSync(path.join(outputDir, "events.jsonl"), "utf8");
    expect(events).toContain("$WORKSPACE_DIR");
    expect(events).toContain("~");
    expect(events).not.toContain(tmpDir);
    expect(events).not.toContain(homeDir);
  });

  it("exports merged runtime and transcript events plus convenience files", async () => {
    const tmpDir = makeTempDir();
    const outputDir = path.join(tmpDir, "bundle");
    writeToolCallSessionTranscript(tmpDir);

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
        data: {
          trigger: "user",
          workspacePath: path.join(tmpDir, "inside.txt"),
          prefixOnlyPath: `${tmpDir}2/outside.txt`,
        },
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
          systemPrompt: `system prompt for ${path.join(tmpDir, "instructions.md")}`,
          tools: [
            {
              name: "read",
              description: `Reads ${path.join(tmpDir, "docs")}`,
              parameters: { type: "object" },
            },
          ],
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
          prompting: {
            systemPromptReport: {
              workspaceDir: tmpDir,
              injectedWorkspaceFiles: [{ path: path.join(tmpDir, "AGENTS.md") }],
            },
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
          finalPromptText: `final prompt from ${path.join(tmpDir, "prompt.txt")}`,
          itemLifecycle: {
            startedCount: 1,
            completedCount: 1,
            activeCount: 0,
          },
        },
      },
    ];
    recordRuntimeEvents(runtimeEvents);

    const bundle = await exportTrajectoryBundle({
      outputDir,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      workspaceDir: tmpDir,
      systemPrompt: "fallback prompt",
      tools: [{ name: "fallback" }],
    });

    expect(bundle.manifest.eventCount).toBeGreaterThanOrEqual(5);
    expect(bundle.manifest.runtimeEventCount).toBe(runtimeEvents.length);
    expect(fs.existsSync(path.join(outputDir, "manifest.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "events.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "session.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, "runtime.jsonl"))).toBe(false);
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
    const types = eventTypes(exportedEvents);
    expect(types).toContain("tool.call");
    expect(types).toContain("tool.result");
    expect(types).toContain("context.compiled");
    expect(JSON.stringify(exportedEvents)).toContain("$WORKSPACE_DIR/inside.txt");
    expect(JSON.stringify(exportedEvents)).not.toContain("$WORKSPACE_DIR2");

    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "manifest.json"), "utf8")) as {
      contents?: Array<{ path: string; mediaType: string; bytes: number }>;
      sourceFiles?: { session?: string; runtime?: string };
      workspaceDir?: string;
    };
    expect(manifest.workspaceDir).toBe("$WORKSPACE_DIR");
    expect(manifest.sourceFiles?.session).toBe("agent-db:main:transcript_events:session-1");
    expect(manifest.sourceFiles?.runtime).toBe("agent-db:main:trajectory_runtime_events:session-1");
    expect(manifest.contents?.map((entry) => entry.path).toSorted()).toEqual([
      "artifacts.json",
      "events.jsonl",
      "metadata.json",
      "prompts.json",
      "session-branch.json",
      "system-prompt.txt",
      "tools.json",
    ]);
    const emptyContents = (manifest.contents ?? []).filter((entry) => entry.bytes <= 0);
    expect(emptyContents).toEqual([]);

    const metadata = JSON.parse(fs.readFileSync(path.join(outputDir, "metadata.json"), "utf8")) as {
      skills?: { entries?: Array<{ id?: string; invoked?: boolean }> };
    };
    expect(metadata.skills?.entries?.[0]?.id).toBe("weather");
    expect(metadata.skills?.entries?.[0]?.invoked).toBe(true);
    const prompts = fs.readFileSync(path.join(outputDir, "prompts.json"), "utf8");
    const artifacts = fs.readFileSync(path.join(outputDir, "artifacts.json"), "utf8");
    const systemPrompt = fs.readFileSync(path.join(outputDir, "system-prompt.txt"), "utf8");
    const tools = fs.readFileSync(path.join(outputDir, "tools.json"), "utf8");
    expect(prompts).toContain("$WORKSPACE_DIR/AGENTS.md");
    expect(artifacts).toContain("$WORKSPACE_DIR/prompt.txt");
    expect(systemPrompt).toContain("$WORKSPACE_DIR/instructions.md");
    expect(tools).toContain("$WORKSPACE_DIR/docs");
    expect(`${prompts}\n${artifacts}\n${systemPrompt}\n${tools}`).not.toContain(tmpDir);
  });
});
