import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
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

async function createTranscriptFixture(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const sessionId = "sess-main";
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  await writeTranscriptHeader(transcriptPath, sessionId);
  setMockSessionEntry(transcriptPath, sessionId);
  return { transcriptPath, sessionId };
}

function createChatAbortContext(overrides: Record<string, unknown> = {}): {
  chatAbortControllers: Map<string, ReturnType<typeof createActiveRun>>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  chatBlockBases: Map<string, string>;
  chatLastBlockTexts: Map<string, string>;
  deleteChatRunBufferState: (clientRunId: string) => void;
  chatAbortedRuns: Map<string, number>;
  removeChatRun: ReturnType<typeof vi.fn>;
  agentRunSeq: Map<string, number>;
  broadcast: ReturnType<typeof vi.fn>;
  nodeSendToSession: ReturnType<typeof vi.fn>;
  logGateway: { warn: ReturnType<typeof vi.fn> };
  dedupe?: { get: ReturnType<typeof vi.fn> };
} {
  const chatRunBuffers = new Map<string, string>();
  const chatDeltaSentAt = new Map<string, number>();
  const chatBlockBases = new Map<string, string>();
  const chatLastBlockTexts = new Map<string, string>();

  return {
    chatAbortControllers: new Map(),
    chatRunBuffers,
    chatDeltaSentAt,
    chatBlockBases,
    chatLastBlockTexts,
    deleteChatRunBufferState: (clientRunId: string) => {
      chatRunBuffers.delete(clientRunId);
      chatDeltaSentAt.delete(clientRunId);
      chatBlockBases.delete(clientRunId);
      chatLastBlockTexts.delete(clientRunId);
    },
    chatAbortedRuns: new Map<string, number>(),
    removeChatRun: vi
      .fn()
      .mockImplementation((run: string) => ({ sessionKey: "main", clientRunId: run })),
    agentRunSeq: new Map<string, number>(),
    broadcast: vi.fn(),
    nodeSendToSession: vi.fn(),
    logGateway: { warn: vi.fn() },
    ...overrides,
  };
}

async function invokeChatAbort(
  context: ReturnType<typeof createChatAbortContext>,
  params: { sessionKey: string; runId?: string },
  respond: ReturnType<typeof vi.fn>,
) {
  await chatHandlers["chat.abort"]({
    params,
    respond: respond as never,
    context: context as never,
    req: {} as never,
    client: null,
    isWebchatConnect: () => false,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chat abort transcript persistence", () => {
  it("persists run-scoped abort partial with rpc metadata and idempotency", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture("openclaw-chat-abort-run-");
    const runId = "idem-abort-run-1";
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", sessionId)]]),
      chatRunBuffers: new Map([[runId, "Partial from run abort"]]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
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
    });

    await invokeChatAbort(context, { sessionKey: "main", runId }, respond);

    const [ok1, payload1] = respond.mock.calls.at(-1) ?? [];
    expect(ok1).toBe(true);
    expect(payload1).toMatchObject({ aborted: true, runIds: [runId] });

    context.chatAbortControllers.set(runId, createActiveRun("main", sessionId));
    context.chatRunBuffers.set(runId, "Partial from run abort");
    context.chatDeltaSentAt.set(runId, Date.now());

    await invokeChatAbort(context, { sessionKey: "main", runId }, respond);

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
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-session-",
    );
    const respond = vi.fn();
    const context = createChatAbortContext({
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
    });

    await invokeChatAbort(context, { sessionKey: "main" }, respond);

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
    const { transcriptPath, sessionId } = await createTranscriptFixture("openclaw-chat-stop-");
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([["run-stop-1", createActiveRun("main", sessionId)]]),
      chatRunBuffers: new Map([["run-stop-1", "Partial from /stop"]]),
      chatDeltaSentAt: new Map([["run-stop-1", Date.now()]]),
      removeChatRun: vi.fn().mockReturnValue({ sessionKey: "main", clientRunId: "client-stop-1" }),
      agentRunSeq: new Map<string, number>([["run-stop-1", 1]]),
      dedupe: {
        get: vi.fn(),
      },
    });

    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "main",
        message: "/stop",
        idempotencyKey: "idem-stop-req",
      },
      respond,
      context: context as never,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
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

  it("skips run-scoped transcript persistence when partial text is blank", async () => {
    const { transcriptPath, sessionId } = await createTranscriptFixture(
      "openclaw-chat-abort-run-blank-",
    );
    const runId = "idem-abort-run-blank";
    const respond = vi.fn();
    const context = createChatAbortContext({
      chatAbortControllers: new Map([[runId, createActiveRun("main", sessionId)]]),
      chatRunBuffers: new Map([[runId, "  \n\t  "]]),
      chatDeltaSentAt: new Map([[runId, Date.now()]]),
    });

    await invokeChatAbort(context, { sessionKey: "main", runId }, respond);

    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ aborted: true, runIds: [runId] });

    const lines = await readTranscriptLines(transcriptPath);
    const persisted = lines
      .map((line) => line.message)
      .find((message) => message?.idempotencyKey === `${runId}:assistant`);
    expect(persisted).toBeUndefined();
  });
});
