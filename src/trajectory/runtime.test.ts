import fs from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  trackSqliteStatementExecutions,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  inspectOpenClawAgentDatabaseOwner,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
// Trajectory runtime tests cover event recording and runtime file handling.
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { createLargeTrajectoryUsage } from "./export.test-helpers.js";
import { TRAJECTORY_RUNTIME_EVENT_MAX_BYTES } from "./paths.js";
import * as runtimeStoreWriter from "./runtime-store-writer.js";
import {
  loadSqliteTrajectoryRuntimeEvents,
  loadSqliteTrajectoryRuntimeEventRowsSync,
} from "./runtime-store.sqlite.js";
import { createTrajectoryRuntimeRecorder, toTrajectoryToolDefinitions } from "./runtime.js";

type TrajectoryRuntimeRecorder = NonNullable<
  Awaited<ReturnType<typeof createTrajectoryRuntimeRecorder>>
>;

const tempDirs = createTempDirTracker();

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

function expectTrajectoryRuntimeRecorder(
  recorder: Awaited<ReturnType<typeof createTrajectoryRuntimeRecorder>>,
): TrajectoryRuntimeRecorder {
  return expectDefined(recorder, "Expected trajectory runtime recorder");
}

let writes: string[];
beforeEach(() => {
  writes = [];
});

async function createCapturedRuntimeRecorder(
  params?: Partial<Parameters<typeof createTrajectoryRuntimeRecorder>[0]>,
) {
  vi.spyOn(runtimeStoreWriter, "createSqliteTrajectoryRuntimeSink").mockResolvedValueOnce({
    write: (_event, line) => writes.push(line),
    flush: async () => {},
    describeFlushState: () => undefined,
  });
  return expectTrajectoryRuntimeRecorder(
    await createTrajectoryRuntimeRecorder({
      sessionId: "session-1",
      sessionFile: "/tmp/session.jsonl",
      ...params,
    }),
  );
}

function captured(index = 0) {
  return JSON.parse(expectDefined(writes[index], "captured event"));
}

async function captureEvent(type: string, data: Record<string, unknown>) {
  const recorder = await createCapturedRuntimeRecorder();
  recorder.recordEvent(type, data);
  return captured();
}

function expectBoundedCapture() {
  expect(writes).toHaveLength(1);
  expect(Buffer.byteLength(expectDefined(writes[0], "captured event"), "utf8")).toBeLessThanOrEqual(
    TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1,
  );
}

function oversizedMessages() {
  return Array.from({ length: 12 }, (_value, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message-${index} ${"x".repeat(32_000)}`,
  }));
}

async function createMarkerRecorder() {
  const storePath = path.join(
    tempDirs.make("openclaw-trajectory-runtime-"),
    "agents/main/sessions/sessions.json",
  );
  const target = {
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    storePath,
  };
  await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 10 });
  const recorder = expectTrajectoryRuntimeRecorder(
    await createTrajectoryRuntimeRecorder({
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      sessionFile: formatSqliteSessionFileMarker(target),
    }),
  );
  return { recorder, storePath, sessionKey: target.sessionKey };
}

describe("trajectory runtime", () => {
  it("records runtime payloads without credential masking by default", async () => {
    const recorder = await createCapturedRuntimeRecorder({
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "responses",
      workspaceDir: "/tmp/workspace",
    });

    recorder.recordEvent("context.compiled", {
      systemPrompt: "system prompt",
      headers: [{ name: "Authorization", value: "Bearer sk-test-secret-token" }],
      command: "curl -H 'Authorization: Bearer sk-other-secret-token'",
      oauth: "ya29.fake-access-token-with-enough-length",
      apple: "abcd-efgh-ijkl-mnop",
      tools: toTrajectoryToolDefinitions([
        { name: "z-tool", parameters: { z: 1 } },
        { name: "a-tool", description: "alpha", parameters: { a: 1 } },
        { name: " ", description: "ignored" },
      ]),
    });

    expect(writes).toHaveLength(1);
    const parsed = captured();
    expect(parsed.type).toBe("context.compiled");
    expect(parsed.source).toBe("runtime");
    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.data.tools).toEqual([
      { name: "a-tool", description: "alpha", parameters: { a: 1 } },
      { name: "z-tool", parameters: { z: 1 } },
    ]);
    expect(JSON.stringify(parsed.data)).toContain("sk-test-secret-token");
    expect(JSON.stringify(parsed.data)).toContain("sk-other-secret-token");
    expect(JSON.stringify(parsed.data)).toContain("ya29.fake-access-token");
    expect(JSON.stringify(parsed.data)).toContain("abcd-efgh-ijkl-mnop");
  });

  it("records SQLite marker runtime events without active JSONL sidecars", async () => {
    const { recorder: runtimeRecorder, storePath, sessionKey } = await createMarkerRecorder();
    runtimeRecorder.recordEvent("context.compiled", {
      prompt: "hello",
    });
    runtimeRecorder.recordEvent("model.completed", {
      usage: { input: 1, output: 2, total: 3 },
    });
    expect(runtimeRecorder.describeFlushState()).toContain("pendingRows=2");
    const database = openOpenClawAgentDatabase(
      toDatabaseOptions(resolveSqliteReadScope({ sessionKey, storePath })),
    );
    const statements = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["trajectory"],
      (sql) => (sql.includes("trajectory_runtime_events") ? "trajectory" : null),
    );
    try {
      await runtimeRecorder.flush();
      expect.soft(statements.counts.trajectory).toBe(0);
    } finally {
      statements.restore();
    }

    await expect(
      loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }),
    ).resolves.toEqual([
      expect.objectContaining({ source: "runtime", type: "context.compiled" }),
      expect.objectContaining({ source: "runtime", type: "model.completed" }),
    ]);
    expect(fs.existsSync(path.join(path.dirname(storePath), "trajectory", "session-1.jsonl"))).toBe(
      false,
    );
  });

  it.each(["committed", "uncommitted"])(
    "prepares a %s canonical target without caller-thread SQL",
    async (state) => {
      // Attempt dispatch stopped passing legacy `sqlite:` markers and now hands
      // the canonical session key plus a complete target. Recording must not
      // depend on the marker, or every harness capture silently disappears.
      const tempDir = tempDirs.make("openclaw-trajectory-runtime-");
      const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
      const sessionKey = "agent:main:main";
      await replaceSessionEntry(
        { sessionKey: state === "committed" ? sessionKey : "agent:main:other", storePath },
        { sessionId: "session-1", updatedAt: 10 },
      );
      const sql = observeHostDataSql();
      const recorder = await createTrajectoryRuntimeRecorder({
        sessionId: "session-1",
        sessionKey,
        sessionFile: sessionKey,
        sessionTarget: { agentId: "main", sessionId: "session-1", sessionKey, storePath },
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "responses",
        workspaceDir: "/tmp/workspace",
      });

      sql.restore();
      expect(sql.queries).toEqual([]);
      const runtimeRecorder = expectTrajectoryRuntimeRecorder(recorder);
      runtimeRecorder.recordEvent("session.started");
      await runtimeRecorder.flush();

      await expect(
        loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath }),
      ).resolves.toEqual([expect.objectContaining({ source: "runtime", type: "session.started" })]);
    },
  );

  it.each(["caller-env", "cwd"] as const)(
    "keeps queued logical-agent trajectory writes on their captured shared store (%s)",
    async (change) => {
      const callerRoot = tempDirs.make("openclaw-trajectory-caller-root-");
      const originalState = path.join(callerRoot, "state");
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(callerRoot);
      try {
        const env = {
          ...process.env,
          OPENCLAW_STATE_DIR: change === "cwd" ? "state" : originalState,
        };
        const capturedEnv = { ...env, OPENCLAW_STATE_DIR: originalState };
        const otherState = tempDirs.make("openclaw-trajectory-other-state-");
        const storePath = path.join(tempDirs.make("openclaw-shared-trajectory-"), "shared.sqlite");
        await replaceSessionEntry(
          { agentId: "main", env: capturedEnv, sessionKey: "agent:main:unrelated", storePath },
          { sessionId: "unrelated", updatedAt: 1 },
        );
        const target = {
          agentId: "ops",
          sessionKey: "agent:ops:trace",
          sessionId: "ops-session",
          storePath,
          env: capturedEnv,
        };
        await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
        const recorder = expectTrajectoryRuntimeRecorder(
          await createTrajectoryRuntimeRecorder({
            env,
            sessionId: target.sessionId,
            sessionKey: target.sessionKey,
            sessionTarget: target,
          }),
        );
        recorder.recordEvent("session.started");
        recorder.recordEvent("session.ended", { status: "success" });
        await closeOpenClawAgentDatabasesAsync();
        closeOpenClawAgentDatabasesForTest();
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const reservation = runOpenClawAgentWorkerWrite(
          { agentId: "main", env: capturedEnv, path: storePath },
          async () => {
            entered.resolve();
            await release.promise;
          },
        );
        let flush: Promise<void> | undefined;
        try {
          await entered.promise;
          flush = recorder.flush();
          void flush.catch(() => {});
          if (change === "cwd") {
            cwd.mockReturnValue(otherState);
          } else {
            env.OPENCLAW_STATE_DIR = otherState;
          }
          await setImmediate();
          expect(recorder.describeFlushState()).toContain("pendingRows=2");
          release.resolve();
          await reservation;
          await flush;
        } finally {
          release.resolve();
          await reservation;
          await flush?.catch(() => {});
        }
        expect(fs.readdirSync(otherState)).toEqual([]);
        expect(
          (await loadSqliteTrajectoryRuntimeEvents(target)).map((event) => event.type),
        ).toEqual(["session.started", "session.ended"]);
        expect(loadSqliteTrajectoryRuntimeEventRowsSync({ ...target, tailEvents: 1 })).toEqual([
          expect.objectContaining({
            seq: 1,
            event: expect.objectContaining({
              sessionId: target.sessionId,
              sessionKey: target.sessionKey,
              type: "session.ended",
            }),
          }),
        ]);
        expect(inspectOpenClawAgentDatabaseOwner(storePath)).toMatchObject({
          status: "owned",
          agentId: "main",
        });
        expect(
          await loadSqliteTrajectoryRuntimeEvents({
            agentId: "main",
            env: capturedEnv,
            sessionId: "unrelated",
            storePath,
          }),
        ).toEqual([]);
      } finally {
        cwd.mockRestore();
      }
    },
  );

  it.each(["marker", "requested key", "target agent", "stored session"] as const)(
    "rejects a conflicting %s",
    async (conflict) => {
      const storePath = path.join(tempDirs.make("openclaw-trajectory-runtime-"), "sessions.json");
      const target = {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath,
      };
      if (conflict === "stored session") {
        await replaceSessionEntry(target, { sessionId: "other-session", updatedAt: 1 });
      }
      const input =
        conflict === "marker"
          ? {
              sessionFile: formatSqliteSessionFileMarker({ ...target, sessionId: "other-session" }),
            }
          : {
              sessionKey: conflict === "requested key" ? "agent:main:other" : undefined,
              sessionTarget: {
                ...target,
                sessionKey: conflict === "target agent" ? "agent:worker:main" : target.sessionKey,
              },
            };
      expect(
        await createTrajectoryRuntimeRecorder({ sessionId: target.sessionId, ...input }),
      ).toBeNull();
    },
  );

  it("stores bounded oversized runtime events in SQLite", async () => {
    const { recorder: runtimeRecorder, storePath } = await createMarkerRecorder();
    const usage = createLargeTrajectoryUsage();
    runtimeRecorder.recordEvent("model.completed", {
      usage,
      messagesSnapshot: oversizedMessages(),
    });
    await runtimeRecorder.flush();

    const [event] = await loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath });
    expect(event).toMatchObject({
      type: "model.completed",
      data: {
        truncated: true,
        reason: "trajectory-event-size-limit",
        usage,
      },
    });
    expect(event?.data?.messagesSnapshot).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThanOrEqual(
      TRAJECTORY_RUNTIME_EVENT_MAX_BYTES,
    );
  });

  it("bounds oversized prompts before compact preservation", async () => {
    const parsed = await captureEvent("context.compiled", {
      prompt: "x".repeat(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES + 1),
    });
    expectBoundedCapture();
    expect(parsed.data.truncated).toBeUndefined();
    expect(parsed.data.prompt.truncated).toBe(true);
    expect(parsed.data.prompt.reason).toBe("trajectory-field-size-limit");
  });

  it("keeps normal schema-v1 event payloads unchanged", async () => {
    const data = {
      finalPromptText: "inspect",
      prompt: "inspect",
      systemPrompt: "system prompt",
      messages: [{ role: "user", content: "inspect" }],
      messagesSnapshot: [{ role: "assistant", content: "done" }],
      imagesCount: 0,
    };

    const recorder = await createCapturedRuntimeRecorder();
    const slices = vi.spyOn(Array.prototype, "slice");
    let copiedKeyLists: number;
    try {
      recorder.recordEvent("prompt.submitted", data);
      copiedKeyLists = slices.mock.contexts.filter((keys) => keys.includes("imagesCount")).length;
    } finally {
      slices.mockRestore();
    }
    const parsed = captured();
    expect(copiedKeyLists).toBe(0);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.data).toEqual(data);
    expect(JSON.stringify(parsed.data)).toBe(JSON.stringify(data));
    expect(parsed.data.truncated).toBeUndefined();
  });

  it("preserves non-JSON leaves and custom JSON results in captured events", async () => {
    const recorder = await createCapturedRuntimeRecorder();
    const error = new Error("synthetic failure");
    error.stack = "synthetic stack";
    recorder.recordEvent("tool.result", {
      count: 123n,
      callback: () => {},
      values: [undefined, Number.NaN, 1n, () => {}],
      custom: {
        toJSON: () => ({
          count: 456n,
          error,
          bytes: new Uint8Array([1, 2]),
          callback: () => {},
        }),
      },
    });

    expect(captured().data).toEqual({
      count: "123",
      callback: "[Function]",
      values: [null, null, "1", "[Function]"],
      custom: {
        count: "456",
        error: { name: "Error", message: "synthetic failure", stack: "synthetic stack" },
        bytes: { type: "Uint8Array", data: "AQI=" },
        callback: "[Function]",
      },
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    recorder.recordEvent("tool.result", { toJSON: () => circular });
    recorder.recordEvent("session.ended", { status: "success" });
    expect(writes).toHaveLength(2);
    expect(captured(1).seq).toBe(2);
  });

  it("keeps structured tool output and usage below the event byte limit", async () => {
    const recorder = await createCapturedRuntimeRecorder();
    const contentItems = Array.from({ length: 64 }, (_, index) => ({
      type: "inputText",
      text: `line ${String(index)}`,
    }));
    const usage = { input: 120, output: 30, total: 150 };

    recorder.recordEvent("tool.result", {
      toolCallId: "call-1",
      name: "exec",
      success: true,
      contentItems,
    });
    recorder.recordEvent("model.completed", { messagesSnapshot: contentItems, usage });
    recorder.recordEvent("model.completed", { usage, messagesSnapshot: contentItems });

    const events = writes.map((line) => JSON.parse(line));
    expect(events[0].data.contentItems).toEqual(contentItems);
    expect(events[1].data.usage).toEqual(usage);
    expect(events[2].data.usage).toEqual(usage);
    for (const line of writes) {
      expect(Buffer.byteLength(line)).toBeLessThan(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES);
      expect(line).not.toContain("[Truncated]");
    }
  });

  it("retains explicit array and object capture-limit markers", async () => {
    const event = await captureEvent("tool.result", {
      contentItems: Array.from({ length: 65 }, () => ({ output: "line" })),
      result: Object.fromEntries(
        Array.from({ length: 65 }, (_, index) => [`field${String(index)}`, index]),
      ),
    });

    expect(event.data.contentItems).toHaveLength(65);
    expect(event.data.contentItems[0]).toEqual({ output: "line" });
    expect(event.data.contentItems[64]).toMatchObject({
      truncated: true,
      reason: "trajectory-array-size-limit",
      originalLength: 65,
    });
    expect(event.data.result["_truncated"]).toMatchObject({
      truncated: true,
      reason: "trajectory-object-size-limit",
      originalKeys: 65,
    });
  });

  it("preserves tool identity and outcome when oversized result content is dropped", async () => {
    const outcome = {
      toolCallId: "call-1",
      name: "exec",
      status: "completed",
      success: true,
      isError: false,
    };
    const parsed = await captureEvent("tool.result", {
      ...outcome,
      contentItems: Array.from({ length: 64 }, () => ({
        type: "inputText",
        text: "x".repeat(8192),
      })),
    });

    const line = expectDefined(writes[0], "captured event");
    expect(parsed.data).toMatchObject({
      ...outcome,
      truncated: true,
      droppedFields: ["contentItems"],
    });
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(TRAJECTORY_RUNTIME_EVENT_MAX_BYTES);
  });

  it("preserves raw usage in oversized non-final completions", async () => {
    const usage = {
      ...createLargeTrajectoryUsage(),
      note: "Authorization: Bearer sk-inline-secret-token",
      apiKey: "sk-test-secret-token",
      authorization: "Bearer sk-other-secret-token",
    };
    const promptCache = { readTokens: 333_824, writeTokens: 51_130 };
    const recorder = await createCapturedRuntimeRecorder();

    recorder.recordEvent("model.completed", {
      usage,
      promptCache,
      assistantTexts: ["done"],
      finalPromptText: "inspect",
      messagesSnapshot: oversizedMessages(),
    });

    expectBoundedCapture();
    const parsed = captured();
    expect(parsed.type).toBe("model.completed");
    expect(parsed.data).toMatchObject({
      truncated: true,
      reason: "trajectory-event-size-limit",
      usage,
      promptCache,
      assistantTexts: ["done"],
      finalPromptText: "inspect",
    });
    expect(parsed.data.finalPromptTextOriginalLength).toBeUndefined();
    expect(parsed.data.messagesSnapshot).toBeUndefined();
    expect(parsed.data.droppedFields).toEqual(["messagesSnapshot"]);
    const secondUsage = { input: 12, output: 3, total: 15 };
    recorder.recordEvent("model.completed", {
      usage: secondUsage,
      assistantTexts: ["final answer"],
    });
    expect(writes).toHaveLength(2);
    expect(captured().data.usage).toEqual(usage);
    expect(captured(1).data).toMatchObject({
      usage: secondUsage,
      assistantTexts: ["final answer"],
    });
    expect(captured(1).data.truncated).toBeUndefined();
  });
  it("preserves stopReason while dropping oversized preserved fields to keep runtime events bounded", async () => {
    const oversizedUsage = Object.fromEntries(
      Array.from({ length: 64 }, (_value, index) => [`field-${index}`, "x".repeat(5_000)]),
    );
    const outcome = {
      threadId: "thread-compact",
      turnId: "turn-compact",
      timedOut: true,
      yieldDetected: false,
      aborted: true,
      promptError: "terminal prompt error",
      prompt: "summarize the incident timeline",
      promptCache: { readTokens: 333_824, writeTokens: 51_130 },
      stopReason: "length",
    };
    const parsed = await captureEvent("model.completed", {
      ...outcome,
      usage: oversizedUsage,
      assistantTexts: Array.from(
        { length: 12 },
        (_value, index) => `assistant-${index} ${"x".repeat(32_000)}`,
      ),
      messagesSnapshot: [{ role: "user", content: "x".repeat(32_000) }],
    });

    expectBoundedCapture();
    expect(parsed.data).toMatchObject({
      truncated: true,
      reason: "trajectory-event-size-limit",
      ...outcome,
    });
    expect(parsed.data.usage).toBeUndefined();
    expect(parsed.data.assistantTexts).toBeUndefined();
    expect(parsed.data.droppedFields).toEqual(
      expect.arrayContaining(["usage", "assistantTexts", "messagesSnapshot"]),
    );
  });

  it("drops repeated conversation fields in priority order", async () => {
    const prompt = "summarize the incident timeline";
    const messageBlocks = oversizedMessages();
    const parsed = await captureEvent("context.compiled", {
      prompt,
      messagesSnapshot: messageBlocks,
      messages: messageBlocks,
      systemPrompt: "x".repeat(32_760),
      tools: Array.from({ length: 7 }, (_value, index) => ({
        name: `tool-${index}`,
        description: "x".repeat(32_760),
      })),
    });

    expect(parsed.data.prompt).toBe(prompt);
    expect(parsed.data.tools).toHaveLength(7);
    expect(parsed.data.messagesSnapshot).toBeUndefined();
    expect(parsed.data.messages).toBeUndefined();
    expect(parsed.data.systemPrompt).toBeUndefined();
    expect(parsed.data.droppedFields).toEqual(["messagesSnapshot", "messages", "systemPrompt"]);
    expectBoundedCapture();
  });

  it("caps large final prompts and records their original length", async () => {
    const finalPromptText = `prompt-${"🙂".repeat(4_096)}`;
    const parsed = await captureEvent("model.completed", Object.freeze({ finalPromptText }));
    expect(Buffer.byteLength(parsed.data.finalPromptText, "utf8")).toBeLessThanOrEqual(4 * 1024);
    expect(Buffer.byteLength(parsed.data.finalPromptText, "utf8")).toBeGreaterThan(4 * 1024 - 4);
    expect(parsed.data.finalPromptTextOriginalLength).toBe(finalPromptText.length);
  });

  it("does not record runtime events when explicitly disabled", async () => {
    const recorder = await createTrajectoryRuntimeRecorder({
      env: {
        OPENCLAW_TRAJECTORY: "0",
      },
      sessionId: "session-1",
      sessionKey: "agent:main:session-1",
      sessionFile: "/tmp/session.jsonl",
    });

    expect(recorder).toBeNull();
  });
});
