import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type TranscriptLine = {
  message?: Record<string, unknown>;
};

const sessionEntryState = vi.hoisted(() => ({
  transcriptPath: "",
  sessionId: "",
}));

vi.mock("../session-utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...original,
    loadSessionEntry: () => ({
      cfg: {},
      storePath: path.join(path.dirname(sessionEntryState.transcriptPath), "sessions.json"),
      entry: {
        sessionId: sessionEntryState.sessionId,
        sessionFile: sessionEntryState.transcriptPath,
      },
      canonicalKey: "main",
    }),
  };
});

const { chatHandlers } = await import("./chat.js");

function createActiveRun(sessionKey: string, sessionId: string) {
  const now = Date.now();
  return {
    controller: new AbortController(),
    sessionId,
    sessionKey,
    startedAtMs: now,
    expiresAtMs: now + 30_000,
  };
}

async function writeTranscriptHeader(transcriptPath: string, sessionId: string) {
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp: new Date(0).toISOString(),
    cwd: "/tmp",
  };
  await fs.writeFile(transcriptPath, `${JSON.stringify(header)}\n`, "utf-8");
}

async function readTranscriptLines(transcriptPath: string): Promise<TranscriptLine[]> {
  const raw = await fs.readFile(transcriptPath, "utf-8");
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as TranscriptLine;
      } catch {
        return {};
      }
    });
}

function setMockSessionEntry(transcriptPath: string, sessionId: string) {
  sessionEntryState.transcriptPath = transcriptPath;
  sessionEntryState.sessionId = sessionId;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chat abort transcript persistence", () => {
  it("persists run-scoped abort partial with rpc metadata and idempotency", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chat-abort-run-"));
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    const sessionId = "sess-main";
    const runId = "idem-abort-run-1";
    await writeTranscriptHeader(transcriptPath, sessionId);

    setMockSessionEntry(transcriptPath, sessionId);
    const respond = vi.fn();
    const context = {
      chatAbortControllers: new Map([[runId, createActiveRun("main", sessionId)]]),
      chatRunBuffers: new Map([[runId, "Partial from run abort"]]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
      chatAbortedRuns: new Map<string, number>(),
      removeChatRun: vi
        .fn()
        .mockReturnValue({ sessionKey: "main", clientRunId: "client-idem-abort-run-1" }),
      agentRunSeq: new Map<string, number>([
        [runId, 2],
        ["client-idem-abort-run-1", 3],
      ]),
      broadcast: vi.fn(),
      nodeSendToSession: vi.fn(),
      logGateway: { warn: vi.fn() },
    };

    await chatHandlers["chat.abort"]({
      params: { sessionKey: "main", runId },
      respond,
      context: context as never,
    });

    const [ok1, payload1] = respond.mock.calls.at(-1) ?? [];
    expect(ok1).toBe(true);
    expect(payload1).toMatchObject({ aborted: true, runIds: [runId] });

    context.chatAbortControllers.set(runId, createActiveRun("main", sessionId));
    context.chatRunBuffers.set(runId, "Partial from run abort");
    context.chatDeltaSentAt.set(runId, Date.now());

    await chatHandlers["chat.abort"]({
      params: { sessionKey: "main", runId },
      respond,
      context: context as never,
    });

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = lines
      .map((line) => line.message)
      .filter(
        (message): message is Record<string, unknown> =>
          Boolean(message) && message?.idempotencyKey === `${runId}:assistant`,
      );

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      stopReason: "stop",
      idempotencyKey: `${runId}:assistant`,
      openclawAbort: {
        aborted: true,
        origin: "rpc",
        runId,
      },
    });
  });

  it("persists session-scoped abort partials with rpc metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chat-abort-session-"));
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    const sessionId = "sess-main";
    await writeTranscriptHeader(transcriptPath, sessionId);

    setMockSessionEntry(transcriptPath, sessionId);
    const respond = vi.fn();
    const context = {
      chatAbortControllers: new Map([
        ["run-a", createActiveRun("main", sessionId)],
        ["run-b", createActiveRun("main", sessionId)],
      ]),
      chatRunBuffers: new Map([
        ["run-a", "Session abort partial"],
        ["run-b", "   "],
      ]),
      chatDeltaSentAt: new Map([
        ["run-a", Date.now()],
        ["run-b", Date.now()],
      ]),
      chatAbortedRuns: new Map<string, number>(),
      removeChatRun: vi
        .fn()
        .mockImplementation((run: string) => ({ sessionKey: "main", clientRunId: run })),
      agentRunSeq: new Map<string, number>(),
      broadcast: vi.fn(),
      nodeSendToSession: vi.fn(),
      logGateway: { warn: vi.fn() },
    };

    await chatHandlers["chat.abort"]({
      params: { sessionKey: "main" },
      respond,
      context: context as never,
    });

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true });
    expect(payload.runIds).toEqual(expect.arrayContaining(["run-a", "run-b"]));

    const lines = await readTranscriptLines(transcriptPath);
    const runAPersisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === "run-a:assistant");
    const runBPersisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === "run-b:assistant");

    expect(runAPersisted).toMatchObject({
      idempotencyKey: "run-a:assistant",
      openclawAbort: {
        aborted: true,
        origin: "rpc",
        runId: "run-a",
      },
    });
    expect(runBPersisted).toBeUndefined();
  });

  it("persists /stop partials with stop-command metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-chat-stop-"));
    const transcriptPath = path.join(dir, "sess-main.jsonl");
    const sessionId = "sess-main";
    await writeTranscriptHeader(transcriptPath, sessionId);

    setMockSessionEntry(transcriptPath, sessionId);
    const respond = vi.fn();
    const context = {
      chatAbortControllers: new Map([["run-stop-1", createActiveRun("main", sessionId)]]),
      chatRunBuffers: new Map([["run-stop-1", "Partial from /stop"]]),
      chatDeltaSentAt: new Map([["run-stop-1", Date.now()]]),
      chatAbortedRuns: new Map<string, number>(),
      removeChatRun: vi.fn().mockReturnValue({ sessionKey: "main", clientRunId: "client-stop-1" }),
      agentRunSeq: new Map<string, number>([["run-stop-1", 1]]),
      broadcast: vi.fn(),
      nodeSendToSession: vi.fn(),
      logGateway: { warn: vi.fn() },
      dedupe: {
        get: vi.fn(),
      },
    };

    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "main",
        message: "/stop",
        idempotencyKey: "idem-stop-req",
      },
      respond,
      context: context as never,
      client: undefined,
    });

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true, runIds: ["run-stop-1"] });

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === "run-stop-1:assistant");

    expect(persisted).toMatchObject({
      idempotencyKey: "run-stop-1:assistant",
      openclawAbort: {
        aborted: true,
        origin: "stop-command",
        runId: "run-stop-1",
      },
    });
  });
});
