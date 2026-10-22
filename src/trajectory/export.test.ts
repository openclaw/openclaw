// Trajectory export tests cover packaged trajectory output and metadata.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { Message } from "openclaw/plugin-sdk/llm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createReadTool } from "../agents/sessions/tools/read.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { exportTrajectoryBundle, resolveDefaultTrajectoryExportDir } from "./export.js";
import {
  assistantMessage,
  assistantText,
  messageEntry,
  sessionHeader,
  writeEntries,
  simpleSessionEntries,
  toolCallSessionEntries,
  userMessage,
  writeSimpleSessionFile,
  writeToolCallOnlySessionFile,
  writeToolCallSessionFile,
} from "./export.test-helpers.js";
import { TRAJECTORY_RUNTIME_FILE_MAX_BYTES } from "./paths.js";
import { appendSqliteTrajectoryRuntimeEvents } from "./runtime-store.test-support.js";
import type { TrajectoryEvent } from "./types.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-trajectory-"));
let tempDirId = 0;

function makeTempDir(): string {
  const dir = path.join(tempRoot, `case-${tempDirId++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function exportPaths() {
  const tmpDir = makeTempDir();
  return {
    tmpDir,
    sessionFile: path.join(tmpDir, "session.jsonl"),
    sessionTarget: {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      storePath: path.join(tmpDir, "sessions.json"),
    },
    outputDir: path.join(tmpDir, "bundle"),
  };
}

function readJson<T = Record<string, unknown>>(outputDir: string, file: string): T {
  return JSON.parse(fs.readFileSync(path.join(outputDir, file), "utf8"));
}

function readEvents(outputDir: string): TrajectoryEvent[] {
  return fs
    .readFileSync(path.join(outputDir, "events.jsonl"), "utf8")
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as TrajectoryEvent);
}

function eventTypes(events: readonly Pick<TrajectoryEvent, "type">[]): string[] {
  return events.map((event) => event.type);
}

function createRuntimeEvent(
  type: string,
  overrides: Partial<TrajectoryEvent> = {},
): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: "session-1",
    source: "runtime",
    type,
    ts: "2026-04-22T08:00:00.000Z",
    seq: 1,
    sessionId: "session-1",
    ...overrides,
  };
}

function runtimeAttemptEvents(
  rows: ReadonlyArray<readonly [type: string, runId: string, data?: Record<string, unknown>]>,
): TrajectoryEvent[] {
  return rows.map(([type, runId, data], index) =>
    createRuntimeEvent(type, {
      seq: index + 1,
      sourceSeq: index + 1,
      runId,
      ...(data ? { data } : {}),
    }),
  );
}

function exportFrom(
  tmpDir: string,
  options: Partial<Parameters<typeof exportTrajectoryBundle>[0]> = {},
) {
  return exportTrajectoryBundle({
    outputDir: path.join(tmpDir, "bundle"),
    sessionId: "session-1",
    workspaceDir: tmpDir,
    ...options,
  });
}

async function exportBranch(entries: readonly unknown[], sessionId = "session-1") {
  const { tmpDir, sessionFile } = exportPaths();
  writeEntries(sessionFile, [sessionHeader(tmpDir, sessionId), ...entries]);
  return exportFrom(tmpDir, { sessionFile, sessionId });
}

async function exportRuntimeArtifacts(
  runtimeEvents: readonly TrajectoryEvent[],
): Promise<Record<string, unknown> | undefined> {
  const { tmpDir, sessionTarget, outputDir } = exportPaths();
  await replaceTranscriptEvents(sessionTarget, simpleSessionEntries(tmpDir));
  appendSqliteTrajectoryRuntimeEvents(sessionTarget, runtimeEvents);
  await exportFrom(tmpDir, { sessionTarget });
  const artifactsFile = path.join(outputDir, "artifacts.json");
  return fs.existsSync(artifactsFile)
    ? (JSON.parse(fs.readFileSync(artifactsFile, "utf8")) as Record<string, unknown>)
    : undefined;
}

afterAll(async () => {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeStateDatabaseForTest();
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("exportTrajectoryBundle", () => {
  it.each([
    {
      name: "different session",
      sessionId: "other-session",
      sessionKey: "agent:main:other",
      requestedKey: "agent:main:requested",
    },
    {
      name: "key belonging to another agent",
      sessionId: "requested-session",
      sessionKey: "agent:worker:requested",
    },
    {
      name: "key mapped to another session",
      sessionId: "requested-session",
      sessionKey: "agent:main:stored-session",
      requestedKey: "agent:main:stored-session",
      stored: true,
    },
    { name: "legacy marker", sessionId: "stale-session", sessionKey: undefined },
  ])("rejects a mismatched $name", async ({ sessionId, sessionKey, requestedKey, stored }) => {
    const tmpDir = makeTempDir();
    const target = {
      agentId: "main",
      sessionId,
      sessionKey,
      storePath: path.join(tmpDir, "sessions.json"),
    };
    if (stored) {
      await replaceSessionEntry(
        { ...target, sessionKey: "agent:main:stored-session" },
        {
          sessionId: "stored-session",
          updatedAt: 1,
        },
      );
    }
    await expect(
      exportFrom(tmpDir, {
        sessionId: "requested-session",
        sessionKey: requestedKey,
        ...(sessionKey
          ? { sessionTarget: { ...target, sessionKey } }
          : { sessionFile: formatSqliteSessionFileMarker(target) }),
      }),
    ).rejects.toThrow(
      sessionKey
        ? "transcript target does not match the requested session"
        : "legacy marker does not match the requested session",
    );
  });

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
    const { tmpDir, sessionFile, outputDir } = exportPaths();
    writeSimpleSessionFile(sessionFile);
    fs.mkdirSync(outputDir);

    try {
      await exportFrom(tmpDir, { sessionFile });
      throw new Error("expected trajectory export to reject an existing output directory");
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("EEXIST");
    }
  });

  it("exports SQLite-backed runtime rows without a runtime JSONL sidecar", async () => {
    const tmpDir = makeTempDir();
    const storePath = path.join(tmpDir, "sessions.json");
    const sessionId = "session-1";
    const sessionKey = "agent:main:session-1";
    await replaceTranscriptEvents(
      {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath,
      },
      [
        sessionHeader(tmpDir, sessionId),
        messageEntry("entry-user", null, userMessage("hello from sqlite"), 40),
      ],
    );
    appendSqliteTrajectoryRuntimeEvents({ agentId: "main", sessionId, storePath }, [
      createRuntimeEvent("sqlite-runtime", {
        traceId: sessionId,
        ts: "2026-04-01T05:46:41.000Z",
        sourceSeq: 1,
        sessionId,
        sessionKey,
      }),
    ]);

    const bundle = await exportFrom(tmpDir, {
      sessionFile: formatSqliteSessionFileMarker({
        agentId: "main",
        sessionId,
        storePath,
      }),
      sessionId,
      sessionKey,
    });

    expect(bundle.manifest.runtimeEventCount).toBe(1);
    expect(bundle.manifest.sourceFiles.runtime).toBeUndefined();
    expect(eventTypes(bundle.events)).toContain("sqlite-runtime");
    expect(fs.existsSync(path.join(tmpDir, "trajectory", "session-1.jsonl"))).toBe(false);
  });

  it("exports logical-agent runtime events from a shared physical store", async () => {
    const tmpDir = makeTempDir();
    const storePath = path.join(tmpDir, "shared.sqlite");
    await replaceSessionEntry(
      { agentId: "main", sessionKey: "agent:main:unrelated", storePath },
      { sessionId: "unrelated", updatedAt: 1 },
    );
    const target = {
      agentId: "ops",
      sessionKey: "agent:ops:trace",
      sessionId: "session-1",
      storePath,
    };
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    appendSqliteTrajectoryRuntimeEvents(
      target,
      runtimeAttemptEvents([
        ["session.started", "ops-run"],
        ["session.ended", "ops-run", { status: "success" }],
      ]),
    );
    const bundle = await exportFrom(tmpDir, {
      sessionTarget: target,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
    });
    expect(bundle.manifest.runtimeEventCount).toBe(2);
    expect(
      bundle.events.filter((event) => event.source === "runtime").map((event) => event.type),
    ).toEqual(["session.started", "session.ended"]);
    expect(
      bundle.events
        .filter((event) => event.source === "runtime")
        .every((event) => event.runId === "ops-run"),
    ).toBe(true);
  });

  it("does not synthesize prompt files from export-time fallbacks", async () => {
    const { tmpDir, sessionFile, outputDir } = exportPaths();
    writeSimpleSessionFile(sessionFile);

    const bundle = await exportFrom(tmpDir, {
      sessionFile,
      systemPrompt: "fallback prompt",
      tools: [{ name: "fallback" }],
    });

    expect(bundle.supplementalFiles).not.toContain("prompts.json");
    expect(fs.existsSync(path.join(outputDir, "prompts.json"))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, "system-prompt.txt"))).toBe(false);
    expect(fs.existsSync(path.join(outputDir, "tools.json"))).toBe(false);
  });

  it("falls back to artifact files when the structured target is incomplete", async () => {
    const { tmpDir, sessionFile } = exportPaths();
    writeSimpleSessionFile(sessionFile);

    const bundle = await exportFrom(tmpDir, {
      sessionFile,
      sessionTarget: { agentId: "main", sessionKey: "agent:main:stale" } as never,
    });

    expect(eventTypes(bundle.events)).toEqual(["user.message", "assistant.message"]);
    expect(bundle.manifest.sourceFiles.session).toBe("$WORKSPACE_DIR/session.jsonl");
  });

  it("rejects an incomplete target that conflicts with a legacy marker", async () => {
    const tmpDir = makeTempDir();

    await expect(
      exportFrom(tmpDir, {
        sessionFile: formatSqliteSessionFileMarker({
          agentId: "worker",
          sessionId: "session-1",
          storePath: path.join(tmpDir, "sessions.json"),
        }),
        sessionTarget: { agentId: "main" } as never,
      }),
    ).rejects.toThrow("transcript target conflicts with the legacy marker");
  });

  it("exports usage from truncated model completion runtime events", async () => {
    const { tmpDir, sessionTarget, outputDir } = exportPaths();
    const usage = {
      input: 384_954,
      output: 5_624,
      cacheRead: 333_824,
      reasoningTokens: 2_038,
      total: 724_402,
    };
    const promptCache = { readTokens: 333_824, writeTokens: 51_130 };
    await replaceTranscriptEvents(sessionTarget, simpleSessionEntries(tmpDir));
    const runtimeEvent: TrajectoryEvent = createRuntimeEvent("model.completed", {
      ts: "2026-04-22T08:00:02.000Z",
      sourceSeq: 1,
      data: {
        truncated: true,
        originalBytes: 300_000,
        limitBytes: 256 * 1024,
        reason: "trajectory-event-size-limit",
        usage,
        promptCache,
        stopReason: "stop_sequence",
        droppedFields: ["messagesSnapshot"],
      },
    });
    appendSqliteTrajectoryRuntimeEvents(sessionTarget, [runtimeEvent]);

    await exportFrom(tmpDir, { sessionTarget });

    const artifacts = readJson(outputDir, "artifacts.json") as {
      usage?: unknown;
      promptCache?: unknown;
      stopReason?: unknown;
    };
    expect(artifacts.usage).toEqual(usage);
    expect(artifacts.promptCache).toEqual(promptCache);
    expect(artifacts.stopReason).toBe("stop_sequence");
  });

  const staleCompletion = {
    usage: { totalTokens: 10 },
    assistantTexts: ["stale completion"],
    stopReason: "length",
  };
  const currentCompletion = {
    usage: { totalTokens: 2 },
    assistantTexts: ["current completion"],
  };
  const staleArtifacts = {
    finalStatus: "error",
    stopReason: "length",
    itemLifecycle: { startedCount: 9, completedCount: 1, activeCount: 8 },
    lastToolError: { message: "stale tool failure" },
  };

  it.each([
    {
      name: "successive attempts that reuse a run id",
      runtimeEvents: runtimeAttemptEvents([
        ["session.started", "shared-run"],
        ["model.completed", "shared-run", staleCompletion],
        ["trace.artifacts", "shared-run", staleArtifacts],
        ["session.ended", "shared-run", { status: "error" }],
        ["session.started", "shared-run"],
        ["model.completed", "shared-run", currentCompletion],
        ["session.ended", "shared-run", { status: "success" }],
      ]),
    },
    {
      name: "distinct run ids with a delayed older terminal after newer completion",
      runtimeEvents: runtimeAttemptEvents([
        ["session.started", "old-run"],
        ["model.completed", "old-run", staleCompletion],
        ["trace.artifacts", "old-run", staleArtifacts],
        ["session.ended", "old-run", { status: "error" }],
        ["session.started", "new-run"],
        ["model.completed", "new-run", currentCompletion],
        ["session.ended", "new-run", { status: "success" }],
        ["session.ended", "old-run", { status: "error" }],
      ]),
    },
  ])("scopes artifacts to $name", async ({ runtimeEvents }) => {
    const artifacts = await exportRuntimeArtifacts(runtimeEvents);
    expect(artifacts).toMatchObject({
      finalStatus: "success",
      usage: { totalTokens: 2 },
      assistantTexts: ["current completion"],
    });
    expect(artifacts).not.toHaveProperty("stopReason");
    expect(artifacts).not.toHaveProperty("itemLifecycle");
    expect(artifacts).not.toHaveProperty("lastToolError");
  });

  it.each([
    {
      name: "timed tail with a delayed older same-run terminal",
      runtimeEvents: runtimeAttemptEvents([
        ["model.completed", "shared-run", staleCompletion],
        ["trace.artifacts", "shared-run", staleArtifacts],
        ["session.ended", "shared-run", { status: "error", startedAt: 100 }],
        ["model.completed", "shared-run", currentCompletion],
        [
          "session.ended",
          "shared-run",
          { status: "interrupted", stopReason: "aborted", startedAt: 200 },
        ],
        ["session.ended", "shared-run", { status: "error", stopReason: "length", startedAt: 100 }],
      ]),
      expectedUsage: true,
    },
    {
      name: "timestamp-free tail with reused run id and stale artifacts",
      runtimeEvents: runtimeAttemptEvents([
        ["model.completed", "shared-run", staleCompletion],
        ["trace.artifacts", "shared-run", staleArtifacts],
        ["session.ended", "shared-run", { status: "error", stopReason: "length" }],
        ["session.ended", "shared-run", { status: "interrupted", stopReason: "aborted" }],
      ]),
      expectedUsage: false,
    },
  ])("exports $name", async ({ runtimeEvents, expectedUsage }) => {
    const artifacts = await exportRuntimeArtifacts(runtimeEvents);

    expect(artifacts).toMatchObject({ finalStatus: "interrupted", stopReason: "aborted" });
    if (expectedUsage) {
      expect(artifacts).toMatchObject({
        usage: { totalTokens: 2 },
        assistantTexts: ["current completion"],
      });
    } else {
      expect(artifacts).not.toHaveProperty("usage");
    }
    expect(artifacts).not.toHaveProperty("itemLifecycle");
  });

  it("omits artifacts when the newest attempt has only started", async () => {
    const artifacts = await exportRuntimeArtifacts(
      runtimeAttemptEvents([
        ["session.started", "old-run"],
        ["model.completed", "old-run", staleCompletion],
        ["trace.artifacts", "old-run", staleArtifacts],
        ["session.ended", "old-run", { status: "error" }],
        ["session.started", "new-run"],
      ]),
    );

    expect(artifacts).toBeUndefined();
  });

  it.each(["evidence-line-1", '{"project":"Orion","ready":true}'])(
    "preserves paginated read evidence beginning with %s in exported trajectory events",
    async (firstLine) => {
      const tmpDir = makeTempDir();
      const sessionFile = path.join(tmpDir, "session.jsonl");
      const sourceFile = path.join(tmpDir, "evidence.txt");
      const outputDir = path.join(tmpDir, "bundle");
      fs.writeFileSync(
        sourceFile,
        `${[firstLine, ...Array.from({ length: 14 }, (_, index) => `evidence-line-${index + 2}`)].join("\n")}\n`,
        "utf8",
      );
      const readResult = await createReadTool(tmpDir).execute("call_1", {
        path: "evidence.txt",
        offset: 1,
        limit: 3,
      });
      const resultText = readResult.content.find((part) => part.type === "text")?.text;
      expect(resultText).toContain("[12 more lines in file. Use offset=4 to continue.]");
      writeToolCallSessionFile(sessionFile, expectDefined(resultText, "read result text"));

      await exportFrom(tmpDir, { sessionFile });

      const exportedEvents = readEvents(outputDir);
      const toolResult = exportedEvents.find((event) => event.type === "tool.result");

      expect(toolResult?.data).toMatchObject({
        message: {
          isError: false,
          content: [{ type: "text", text: resultText }],
        },
      });
    },
  );

  it.each([
    { content: "", MediaPath: "media/legacy.png", MediaType: "image/png" },
    { content: "empty", media: null },
  ])("rejects retired media fields in versionless transcript inputs: %j", async (fields) => {
    const { tmpDir, sessionFile } = exportPaths();
    writeSimpleSessionFile(sessionFile, {
      userMessage: { ...userMessage(""), ...fields } as unknown as Message,
    });
    await expect(exportFrom(tmpDir, { sessionFile })).rejects.toThrow(
      "retired top-level media fields",
    );
  });

  it("rejects retired media carriers in versionless runtime trajectories", async () => {
    const { tmpDir, sessionTarget } = exportPaths();
    await replaceTranscriptEvents(sessionTarget, simpleSessionEntries(tmpDir));
    const runtimeEvent: TrajectoryEvent = createRuntimeEvent("model.completed", {
      ts: "2026-04-22T08:00:02.000Z",
      data: {
        messagesSnapshot: [{ role: "user", content: "", media: [{ path: "media/legacy.png" }] }],
      },
    });
    appendSqliteTrajectoryRuntimeEvents(sessionTarget, [runtimeEvent]);

    await expect(exportFrom(tmpDir, { sessionTarget })).rejects.toThrow(
      "retired top-level media fields",
    );
  });

  it("allows empty retired media carriers in versionless runtime trajectories", async () => {
    const { tmpDir, sessionTarget } = exportPaths();
    await replaceTranscriptEvents(sessionTarget, simpleSessionEntries(tmpDir));
    const runtimeEvent: TrajectoryEvent = createRuntimeEvent("model.completed", {
      ts: "2026-04-22T08:00:02.000Z",
      data: {
        messagesSnapshot: [
          { role: "user", content: "empty", media: [], MediaPaths: [], MediaTypes: [] },
        ],
      },
    });
    appendSqliteTrajectoryRuntimeEvents(sessionTarget, [runtimeEvent]);

    await expect(exportFrom(tmpDir, { sessionTarget })).resolves.toBeDefined();
  });

  it.each([
    {
      name: "sparse",
      message: { __openclaw: { media: [{}, { path: "media/sparse.png" }] } },
      expectedPath: "media/sparse.png",
      expectedIndex: 1,
    },
    {
      name: "type-only",
      message: { __openclaw: { media: [{ contentType: "image/png" }] } },
      expectedPath: undefined,
    },
  ])("exports $name transcript rows as facts only", async (testCase) => {
    const { tmpDir, sessionFile, outputDir } = exportPaths();
    writeSimpleSessionFile(sessionFile, {
      userMessage: { ...userMessage(""), ...testCase.message } as unknown as Message,
    });

    await exportFrom(tmpDir, { sessionFile });

    const sessionBranch = readJson(outputDir, "session-branch.json") as {
      entries?: Array<{ type?: string; message?: Record<string, unknown> }>;
    };
    const exported = sessionBranch.entries?.find((entry) => entry.type === "message")?.message;
    const media = (exported?.["__openclaw"] as { media?: Array<{ path?: string }> })?.media;
    const expectedIndex = "expectedIndex" in testCase ? (testCase.expectedIndex ?? 0) : 0;
    expect(media?.[expectedIndex]?.path).toBe(testCase.expectedPath);
    expect(exported).not.toHaveProperty("MediaPath");
    expect(fs.readFileSync(path.join(outputDir, "events.jsonl"), "utf8")).not.toContain(
      '"MediaPath"',
    );
  });

  it("redacts broad secret patterns from every exported bundle file", async () => {
    const { tmpDir, sessionTarget, outputDir } = exportPaths();
    const rawSecrets = [
      "sk-exported-session-secret",
      "ghp_123456789012345678901234",
      "xoxb-1234567890-abcdefghijkl",
      "ya29.exported-access-token-with-enough-length",
      "ADMIN_PASSWORD=plain-text-password",
      "sk-top-level-export-secret",
    ];
    sessionTarget.sessionKey = expectDefined(rawSecrets[5], "synthetic session key");
    const header = sessionHeader(tmpDir);
    const userEntry = {
      ...messageEntry(
        "entry-user",
        null,
        userMessage(`user pasted ${rawSecrets[0]} keep-visible-marker`),
      ),
      timestamp: "2026-04-01T05:46:40.000Z",
    };
    const assistantEntry = {
      ...messageEntry(
        "entry-assistant",
        "entry-user",
        assistantMessage([
          {
            type: "toolCall",
            id: "call_1",
            name: "read",
            arguments: {
              [expectDefined(rawSecrets[5], "rawSecrets[5] test invariant")]:
                "secret-looking tool argument key",
              command: `curl -H 'Authorization: Bearer ${rawSecrets[1]}'`,
            },
          },
        ]),
      ),
      timestamp: "2026-04-01T05:46:41.000Z",
    };
    const compactionEntry = {
      type: "compaction",
      id: "entry-compaction",
      parentId: "entry-assistant",
      timestamp: "2026-04-01T05:46:42.000Z",
      summary: `compaction summary saw ${rawSecrets[2]}`,
      firstKeptEntryId: "entry-assistant",
      tokensBefore: 1024,
      details: { note: rawSecrets[3] },
    };
    const branchSummaryEntry = {
      type: "branch_summary",
      id: "entry-branch-summary",
      parentId: "entry-compaction",
      timestamp: "2026-04-01T05:46:43.000Z",
      fromId: "entry-assistant",
      summary: `branch summary saw ${rawSecrets[4]}`,
      details: { token: rawSecrets[0] },
    };
    await replaceTranscriptEvents(sessionTarget, [
      header,
      userEntry,
      assistantEntry,
      compactionEntry,
      branchSummaryEntry,
    ]);
    appendSqliteTrajectoryRuntimeEvents(sessionTarget, [
      Object.assign(
        createRuntimeEvent("context.compiled", {
          sourceSeq: 1,
          data: {
            systemPrompt: `system includes ${rawSecrets[1]}`,
            tools: [{ name: "danger", description: `tool mentions ${rawSecrets[2]}` }],
          },
        }),
        { apiKey: rawSecrets[5] },
      ),
      createRuntimeEvent("trace.metadata", {
        ts: "2026-04-22T08:00:01.000Z",
        seq: 2,
        sourceSeq: 2,
        data: {
          harness: { type: "openclaw", token: rawSecrets[3] },
          metadata: {
            [`https://example.test/callback?token=${rawSecrets[1]}`]: "secret-looking metadata key",
          },
          prompting: {
            skillsPrompt: `skills ${rawSecrets[4]}`,
            userPromptPrefixText: `prefix ${rawSecrets[0]}`,
          },
        },
      }),
      createRuntimeEvent("prompt.submitted", {
        ts: "2026-04-22T08:00:02.000Z",
        seq: 3,
        sourceSeq: 3,
        data: { prompt: `submitted ${rawSecrets[1]}` },
      }),
      createRuntimeEvent("trace.artifacts", {
        ts: "2026-04-22T08:00:03.000Z",
        seq: 4,
        sourceSeq: 4,
        runId: rawSecrets[5],
        data: {
          assistantTexts: [`assistant ${rawSecrets[2]}`],
          finalPromptText: `final ${rawSecrets[3]}`,
        },
      }),
    ]);

    const bundle = await exportFrom(tmpDir, { sessionTarget, sessionKey: rawSecrets[5] });

    const exportedBundleText = fs
      .readdirSync(outputDir)
      .map((file) => fs.readFileSync(path.join(outputDir, file), "utf8"))
      .join("\n");
    expect(exportedBundleText).toContain("keep-visible-marker");
    for (const secret of rawSecrets) {
      expect(exportedBundleText).not.toContain(secret);
    }
    expect(JSON.stringify(bundle.events)).not.toContain(rawSecrets[5]);
    expect(JSON.stringify(bundle.manifest)).not.toContain(rawSecrets[5]);
  });

  it("rejects oversized session transcript files before export", async () => {
    const { tmpDir, sessionFile } = exportPaths();
    fs.closeSync(fs.openSync(sessionFile, "w"));
    fs.truncateSync(sessionFile, 50 * 1024 * 1024 + 1);

    await expect(
      exportFrom(tmpDir, { sessionFile, sessionTarget: { agentId: "main" } as never }),
    ).rejects.toThrow(/session file is too large/u);
  });

  it("rejects oversized SQLite transcript store before parsing or creating output", async () => {
    const tmpDir = makeTempDir();
    const storePath = path.join(tmpDir, "sessions.json");
    const outputDir = path.join(tmpDir, "bundle");
    const sessionId = "session-byte-budget";
    const sessionKey = "agent:main:session-byte-budget";
    const oversizedContent = "x".repeat(TRAJECTORY_RUNTIME_FILE_MAX_BYTES + 1);

    await replaceTranscriptEvents({ agentId: "main", sessionId, sessionKey, storePath }, [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-04-01T05:46:39.000Z",
        cwd: tmpDir,
      },
      messageEntry("entry-user", null, userMessage(oversizedContent), 40),
    ]);

    await expect(
      exportFrom(tmpDir, {
        sessionFile: formatSqliteSessionFileMarker({
          agentId: "main",
          sessionId,
          storePath,
        }),
        sessionId,
        sessionKey,
      }),
    ).rejects.toThrow(/transcript store is too large to export/u);
    expect(fs.existsSync(outputDir)).toBe(false);
  });

  it("skips and reports malformed session jsonl rows without poisoning transcript export", async () => {
    const { tmpDir, sessionFile, outputDir } = exportPaths();
    const header = sessionHeader(tmpDir);
    const userEntry = {
      ...messageEntry("entry-user", null, userMessage("hello")),
      timestamp: Date.parse("2026-04-01T05:46:40.000Z"),
    };
    const assistantEntry = messageEntry("entry-assistant", "entry-user", assistantText("done"), 41);
    fs.writeFileSync(
      sessionFile,
      [
        JSON.stringify(header),
        "null",
        '{"type":',
        JSON.stringify({
          type: "message",
          id: "entry-corrupt",
          parentId: null,
          timestamp: "2026-04-01T05:46:39.500Z",
        }),
        JSON.stringify(userEntry),
        JSON.stringify(assistantEntry),
      ].join("\n") + "\n",
      "utf8",
    );

    const bundle = await exportFrom(tmpDir, { sessionFile });

    expect(bundle.manifest.transcriptEventCount).toBe(2);
    expect(eventTypes(bundle.events)).toEqual(["user.message", "assistant.message"]);
    expect(bundle.events.find((event) => event.type === "user.message")?.ts).toBe(
      "2026-04-01T05:46:40.000Z",
    );
    expect(bundle.manifest.warnings).toEqual([
      {
        source: "session",
        code: "invalid-session-row",
        count: 2,
        rows: [2, 4],
        message: "Skipped a session JSONL row that is not a session entry object.",
      },
      {
        source: "session",
        code: "invalid-session-json",
        count: 1,
        rows: [3],
        message: "Skipped a session JSONL row that is not valid JSON.",
      },
    ]);
    expect(readJson(outputDir, "manifest.json").warnings).toEqual(bundle.manifest.warnings);
  });

  it("reports incomplete transcript branches while exporting the reachable suffix", async () => {
    const bundle = await exportBranch([
      {
        ...messageEntry("orphan-tail", "missing-imported-parent", assistantText("reachable tail")),
        timestamp: "2026-04-01T05:46:40.000Z",
      },
    ]);

    expect(eventTypes(bundle.events)).toEqual(["assistant.message"]);
    expect(bundle.manifest.warnings).toEqual([
      {
        source: "session",
        code: "incomplete-session-branch",
        count: 1,
        rows: [2],
        message: "Exported the reachable session branch suffix after a missing parent link.",
      },
    ]);
  });

  it("exports supported current-version linear transcripts in file order", async () => {
    const bundle = await exportBranch(
      [
        messageEntry("linear-user", undefined, userMessage("hello"), 40),
        messageEntry("linear-assistant", undefined, assistantText("done"), 41),
        {
          type: "metadata",
          id: "linear-metadata",
          parentId: "linear-assistant",
          payload: { source: "plugin" },
        },
        messageEntry("side-assistant", "linear-assistant", assistantText("side"), 42),
        {
          type: "leaf",
          id: "active-leaf",
          parentId: "side-assistant",
          targetId: "linear-assistant",
          appendParentId: "linear-metadata",
        },
      ],
      "session-linear",
    );

    expect(eventTypes(bundle.events)).toEqual(["user.message", "assistant.message"]);
    expect(bundle.manifest.leafId).toBe("linear-assistant");
    expect(JSON.stringify(bundle.events)).not.toContain("side");
  });

  it("exports the branch selected by a terminal leaf control", async () => {
    const bundle = await exportBranch([
      messageEntry("active-tail", null, userMessage("active"), 40),
      messageEntry("inactive-tail", "active-tail", assistantText("side delivery"), 41),
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "inactive-tail",
        timestamp: "2026-04-01T05:46:42.000Z",
        targetId: "active-tail",
        appendParentId: null,
      },
    ]);

    expect(eventTypes(bundle.events)).toEqual(["user.message"]);
    expect(bundle.manifest.leafId).toBe("active-tail");
    expect(JSON.stringify(bundle.events)).not.toContain("side delivery");
  });

  it("normalizes an active descendant whose source parent is a leaf control", async () => {
    const bundle = await exportBranch([
      messageEntry("active-tail", null, userMessage("active"), 40),
      messageEntry("inactive-tail", "active-tail", assistantText("side delivery"), 41),
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "inactive-tail",
        timestamp: "2026-04-01T05:46:42.000Z",
        targetId: "active-tail",
      },
      messageEntry("replacement", "active-leaf", assistantText("replacement"), 43),
    ]);

    expect(eventTypes(bundle.events)).toEqual(["user.message", "assistant.message"]);
    expect(bundle.events.find((event) => event.entryId === "replacement")?.parentEntryId).toBe(
      "active-tail",
    );
    expect(JSON.stringify(bundle.events)).not.toContain("active-leaf");
    expect(JSON.stringify(bundle.events)).not.toContain("side delivery");
  });

  it("does not export append-parent history from an explicitly empty branch", async () => {
    const bundle = await exportBranch(
      [
        messageEntry("inactive-root", null, userMessage("inactive"), 40),
        {
          type: "leaf",
          id: "empty-leaf",
          parentId: "inactive-root",
          timestamp: "2026-04-01T05:46:41.000Z",
          targetId: null,
          appendParentId: null,
        },
        {
          type: "metadata",
          id: "plugin-metadata",
          parentId: "inactive-root",
        },
      ],
      "session-empty",
    );

    expect(bundle.events).toEqual([]);
    expect(bundle.manifest.transcriptEventCount).toBe(0);
  });

  it("traverses opaque append parents while exporting the active branch", async () => {
    const bundle = await exportBranch([
      messageEntry("active-root", null, userMessage("active"), 40),
      {
        type: "metadata",
        id: "plugin-metadata",
        parentId: "active-root",
      },
      messageEntry("side-delivery", "active-root", assistantText("side delivery"), 41),
      {
        type: "leaf",
        id: "active-leaf",
        parentId: "side-delivery",
        timestamp: "2026-04-01T05:46:42.000Z",
        targetId: "active-root",
        appendParentId: "plugin-metadata",
      },
      messageEntry("active-tail", "plugin-metadata", assistantText("active tail"), 43),
    ]);

    expect(eventTypes(bundle.events)).toEqual(["user.message", "assistant.message"]);
    expect(bundle.manifest.leafId).toBe("active-tail");
    expect(JSON.stringify(bundle.events)).toContain("active tail");
    expect(JSON.stringify(bundle.events)).not.toContain("side delivery");
    expect(bundle.events.find((event) => event.entryId === "active-tail")?.parentEntryId).toBe(
      "active-root",
    );
  });

  it("stops cyclic transcript branch export instead of hanging", async () => {
    const bundle = await exportBranch([
      messageEntry("entry-a", "entry-b", userMessage("cycle a"), 40),
      messageEntry("entry-b", "entry-a", assistantText("cycle b"), 41),
    ]);

    expect(eventTypes(bundle.events)).toEqual(["user.message", "assistant.message"]);
    expect(bundle.manifest.warnings).toEqual([
      {
        source: "session",
        code: "cyclic-session-branch",
        count: 1,
        rows: [3],
        message: "Stopped trajectory session branch export at a cyclic parent link.",
      },
    ]);
  });

  it("ignores retired runtime sidecars and pointers when exporting transcript artifacts", async () => {
    const { tmpDir, sessionFile } = exportPaths();
    writeSimpleSessionFile(sessionFile);
    const runtimeFile = path.join(tmpDir, "session.trajectory.jsonl");
    const pointedFile = path.join(tmpDir, "runtime", "session-1.jsonl");
    fs.mkdirSync(path.dirname(pointedFile));
    writeEntries(runtimeFile, [createRuntimeEvent("retired-adjacent")]);
    writeEntries(pointedFile, [createRuntimeEvent("retired-pointer")]);
    writeEntries(path.join(tmpDir, "session.trajectory-path.json"), [
      {
        traceSchema: "openclaw-trajectory-pointer",
        schemaVersion: 1,
        sessionId: "session-1",
        runtimeFile: pointedFile,
      },
    ]);

    const bundle = await exportFrom(tmpDir, { sessionFile });

    expect(bundle.manifest.runtimeEventCount).toBe(0);
    expect(bundle.manifest.sourceFiles.runtime).toBeUndefined();
    expect(eventTypes(bundle.events)).toEqual(["user.message", "assistant.message"]);
    expect(fs.readFileSync(runtimeFile, "utf8")).toContain("retired-adjacent");
    expect(fs.readFileSync(pointedFile, "utf8")).toContain("retired-pointer");
  });

  it("counts expanded transcript events when enforcing the total event limit", async () => {
    const { tmpDir, sessionFile } = exportPaths();
    writeToolCallOnlySessionFile(sessionFile);

    await expect(exportFrom(tmpDir, { sessionFile, maxTotalEvents: 1 })).rejects.toThrow(
      /too many events \(2; limit 1\)/u,
    );
  });

  it("skips runtime events for other sessions", async () => {
    const { tmpDir, sessionTarget } = exportPaths();
    await replaceTranscriptEvents(sessionTarget, simpleSessionEntries(tmpDir));
    const otherTarget = {
      ...sessionTarget,
      sessionId: "other-session",
      sessionKey: "agent:main:other",
    };
    await replaceSessionEntry(otherTarget, { sessionId: otherTarget.sessionId, updatedAt: 1 });
    appendSqliteTrajectoryRuntimeEvents(otherTarget, [
      createRuntimeEvent("other-runtime", {
        traceId: "other-session",
        sourceSeq: 1,
        sessionId: "other-session",
      }),
    ]);

    const bundle = await exportFrom(tmpDir, { sessionTarget });

    expect(bundle.manifest.runtimeEventCount).toBe(0);
    expect(eventTypes(bundle.events)).not.toContain("other-runtime");
    expect(bundle.manifest.warnings).toBeUndefined();
  });

  it("redacts non-workspace paths in strings that also contain workspace paths", async () => {
    const { tmpDir, sessionTarget } = exportPaths();
    const homeDir = makeTempDir();
    const outputDir = path.join(tmpDir, "bundle");
    const previousHome = process.env.HOME;
    await replaceTranscriptEvents(sessionTarget, simpleSessionEntries(tmpDir));
    appendSqliteTrajectoryRuntimeEvents(sessionTarget, [
      createRuntimeEvent("mixed-paths", {
        sourceSeq: 1,
        data: {
          value: `workspace=${path.join(tmpDir, "inside.txt")} home=${path.join(
            homeDir,
            "secret.txt",
          )}`,
        },
      }),
    ]);

    process.env.HOME = homeDir;
    try {
      await exportFrom(tmpDir, { sessionTarget });
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

  it("exports identical complete bundles from compressed, legacy, and mixed runtime rows", async () => {
    const { tmpDir, sessionTarget, outputDir } = exportPaths();
    await replaceTranscriptEvents(sessionTarget, toolCallSessionEntries(tmpDir));

    const runtimeEvents: TrajectoryEvent[] = [
      createRuntimeEvent("session.started", {
        sourceSeq: 1,
        data: {
          trigger: "user",
          workspacePath: path.join(tmpDir, "inside.txt"),
          prefixOnlyPath: `${tmpDir}2/outside.txt`,
        },
      }),
      createRuntimeEvent("context.compiled", {
        ts: "2026-04-22T08:00:01.000Z",
        seq: 2,
        sourceSeq: 2,
        data: {
          systemPrompt: `system prompt for ${path.join(tmpDir, "instructions.md")}\n${"Follow the conversation faithfully. 🦞\n".repeat(80)}`,
          tools: [
            {
              name: "read",
              description: `Reads ${path.join(tmpDir, "docs")}`,
              parameters: { type: "object" },
            },
          ],
        },
      }),
      createRuntimeEvent("trace.metadata", {
        ts: "2026-04-22T08:00:01.500Z",
        seq: 3,
        sourceSeq: 3,
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
      }),
      createRuntimeEvent("prompt.submitted", {
        ts: "2026-04-22T08:00:02.000Z",
        seq: 4,
        sourceSeq: 4,
        data: {
          prompt: "Please read the weather skill",
        },
      }),
      createRuntimeEvent("trace.artifacts", {
        ts: "2026-04-22T08:00:03.000Z",
        seq: 5,
        sourceSeq: 5,
        data: {
          finalStatus: "success",
          terminalError: "non_deliverable_terminal_turn",
          assistantTexts: ["done"],
          stopReason: "stop_sequence",
          finalPromptText: `final prompt from ${path.join(tmpDir, "prompt.txt")}\n${"A retained observation from the conversation.\n".repeat(80)}`,
          finalPromptTextOriginalLength: 12_345,
          itemLifecycle: {
            startedCount: 1,
            completedCount: 1,
            activeCount: 0,
          },
        },
      }),
    ];
    appendSqliteTrajectoryRuntimeEvents(sessionTarget, runtimeEvents);

    const exportAtFixedTime = async (directory: string) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-04-22T09:00:00.000Z"));
      try {
        return await exportFrom(tmpDir, {
          outputDir: directory,
          sessionTarget,
          sessionFile: path.join(tmpDir, "stale-session.jsonl"),
          sessionKey: "agent:main:session-1",
          systemPrompt: "fallback prompt",
          tools: [{ name: "fallback" }],
        });
      } finally {
        vi.useRealTimers();
      }
    };
    const bundle = await exportAtFixedTime(outputDir);

    expect(bundle.header?.id).toBe("session-1");
    expect(bundle.manifest.transcriptEventCount).toBe(5);
    expect(eventTypes(bundle.events.filter((event) => event.source === "transcript"))).toEqual([
      "user.message",
      "assistant.message",
      "tool.call",
      "tool.result",
      "assistant.message",
    ]);
    expect(bundle.manifest.sourceFiles.session).toMatch(/^agent:/u);
    expect(bundle.manifest.sourceFiles.session).not.toContain("stale-session");
    expect(fs.existsSync(path.join(tmpDir, "session-1.jsonl"))).toBe(false);
    expect(bundle.manifest.eventCount).toBeGreaterThanOrEqual(5);
    expect(bundle.manifest.runtimeEventCount).toBe(runtimeEvents.length);
    expect(fs.readdirSync(outputDir).toSorted()).toEqual([
      "artifacts.json",
      "events.jsonl",
      "manifest.json",
      "metadata.json",
      "prompts.json",
      "session-branch.json",
      "system-prompt.txt",
      "tools.json",
    ]);
    expect(bundle.supplementalFiles).toEqual(["metadata.json", "artifacts.json", "prompts.json"]);

    const exportedEvents = readEvents(outputDir);
    const types = eventTypes(exportedEvents);
    expect(types).toEqual(expect.arrayContaining(["tool.call", "tool.result", "context.compiled"]));
    expect(JSON.stringify(exportedEvents)).toContain("$WORKSPACE_DIR/inside.txt");
    expect(JSON.stringify(exportedEvents)).not.toContain("$WORKSPACE_DIR2");

    const manifest = readJson(outputDir, "manifest.json") as {
      contents?: Array<{ path: string; mediaType: string; bytes: number }>;
      sourceFiles?: { session?: string; runtime?: string };
      workspaceDir?: string;
    };
    expect(manifest.workspaceDir).toBe("$WORKSPACE_DIR");
    expect(manifest.sourceFiles?.session).toBe("agent:…on-1");
    expect(manifest.sourceFiles?.runtime).toBeUndefined();
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
    expect(emptyContents).toStrictEqual([]);

    const metadata = readJson(outputDir, "metadata.json") as {
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
    expect(JSON.parse(artifacts).finalPromptTextOriginalLength).toBe(12_345);
    expect(JSON.parse(artifacts).stopReason).toBe("stop_sequence");
    expect(artifacts).toContain("non_deliverable_terminal_turn");
    expect(systemPrompt).toContain("$WORKSPACE_DIR/instructions.md");
    expect(tools).toContain("$WORKSPACE_DIR/docs");
    expect(`${prompts}\n${artifacts}\n${systemPrompt}\n${tools}`).not.toContain(tmpDir);

    const options = toDatabaseOptions(resolveSqliteReadScope(sessionTarget));
    runOpenClawAgentWriteTransaction((database) => {
      const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
      const stored = executeSqliteQuerySync(
        database.db,
        db.selectFrom("trajectory_runtime_events").select("event_codec"),
      ).rows;
      expect(stored.filter((row) => row.event_codec === "br")).toHaveLength(2);
      for (const [seq, event] of runtimeEvents.entries()) {
        executeSqliteQuerySync(
          database.db,
          db
            .updateTable("trajectory_runtime_events")
            .set({
              event_json: JSON.stringify(event),
              event_payload: null,
              event_codec: null,
              event_utf8_bytes: null,
            })
            .where("session_id", "=", sessionTarget.sessionId)
            .where("seq", "=", seq),
        );
      }
    }, options);
    const legacyDir = path.join(tmpDir, "legacy-bundle");
    await exportAtFixedTime(legacyDir);

    runOpenClawAgentWriteTransaction((database) => {
      const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
      executeSqliteQuerySync(
        database.db,
        db
          .deleteFrom("trajectory_runtime_events")
          .where("session_id", "=", sessionTarget.sessionId)
          .where("seq", ">=", 2),
      );
    }, options);
    appendSqliteTrajectoryRuntimeEvents(sessionTarget, runtimeEvents.slice(2));
    const mixedDir = path.join(tmpDir, "mixed-bundle");
    await exportAtFixedTime(mixedDir);

    const artifactNames = fs.readdirSync(outputDir).toSorted();
    for (const directory of [legacyDir, mixedDir]) {
      expect(fs.readdirSync(directory).toSorted()).toEqual(artifactNames);
      for (const name of artifactNames) {
        expect(fs.readFileSync(path.join(directory, name))).toEqual(
          fs.readFileSync(path.join(outputDir, name)),
        );
      }
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
