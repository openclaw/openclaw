import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";

// Regression test: chat.inject should auto-create the transcript file when it
// doesn't exist on disk, instead of failing with "transcript file not found".
// See: https://github.com/openclaw/openclaw/issues/36170

const mockState = vi.hoisted(() => ({
  transcriptPath: "",
  sessionId: "sess-inject-missing",
}));

vi.mock("../session-utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...original,
    loadSessionEntry: (_rawKey: string) => ({
      cfg: { session: { mainKey: "main" } },
      storePath: path.join(path.dirname(mockState.transcriptPath), "sessions.json"),
      entry: {
        sessionId: mockState.sessionId,
        sessionFile: mockState.transcriptPath,
      },
      canonicalKey: "main",
    }),
  };
});

vi.mock("../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: vi.fn(),
}));

const { chatHandlers } = await import("./chat.js");

function createChatContext(): Pick<
  GatewayRequestContext,
  | "broadcast"
  | "nodeSendToSession"
  | "agentRunSeq"
  | "chatAbortControllers"
  | "chatRunBuffers"
  | "chatDeltaSentAt"
  | "chatAbortedRuns"
  | "removeChatRun"
  | "dedupe"
  | "registerToolEventRecipient"
  | "logGateway"
> {
  return {
    broadcast: vi.fn() as unknown as GatewayRequestContext["broadcast"],
    nodeSendToSession: vi.fn() as unknown as GatewayRequestContext["nodeSendToSession"],
    agentRunSeq: new Map<string, number>(),
    chatAbortControllers: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatAbortedRuns: new Map(),
    removeChatRun: vi.fn(),
    dedupe: new Map(),
    registerToolEventRecipient: vi.fn(),
    logGateway: {
      warn: vi.fn(),
      debug: vi.fn(),
    } as unknown as GatewayRequestContext["logGateway"],
  };
}

describe("chat.inject with missing transcript file", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    mockState.transcriptPath = "";
  });

  it("succeeds and creates the transcript file when it does not exist on disk", async () => {
    // Set up a temp dir but do NOT create the transcript file — this is the
    // scenario that previously triggered "failed to write transcript: transcript
    // file not found" (ACP oneshot/run sessions where transcripts aren't pre-created).
    // Resolve symlinks on the temp dir up front (e.g. /tmp -> /private/tmp on macOS).
    // Without this, resolvePathWithinSessionsDir's safeRealpathSync on the directory
    // produces a real path while the non-existent file candidate stays unresolved,
    // causing path.relative to produce "../.." and trigger the sessionId fallback.
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chat-inject-missing-")),
    );
    mockState.transcriptPath = path.join(tmpDir, "sess.jsonl");

    // Confirm the file really doesn't exist before the call.
    expect(fs.existsSync(mockState.transcriptPath)).toBe(false);

    const respond = vi.fn();
    const context = createChatContext();

    await chatHandlers["chat.inject"]({
      params: { sessionKey: "main", message: "hello from ACP" },
      respond,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: context as GatewayRequestContext,
    });

    // The handler must succeed, not return an UNAVAILABLE error.
    expect(respond).toHaveBeenCalled();
    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ ok: true });

    // The transcript file must now exist on disk.
    expect(fs.existsSync(mockState.transcriptPath)).toBe(true);
  });

  it("appends cleanly to the same transcript on a second inject after auto-creation", async () => {
    // Guards against a regression where createIfMissing: true fixes the first
    // write but a subsequent append or rotation silently fails or overwrites.
    // Resolve symlinks up front for the same reason as the first test.
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chat-inject-append-")),
    );
    mockState.transcriptPath = path.join(tmpDir, "sess.jsonl");

    const invokeInject = async (message: string) => {
      const respond = vi.fn();
      await chatHandlers["chat.inject"]({
        params: { sessionKey: "main", message },
        respond,
        req: {} as never,
        client: null as never,
        isWebchatConnect: () => false,
        context: createChatContext() as GatewayRequestContext,
      });
      const [ok, payload] = respond.mock.calls.at(-1) ?? [];
      return { ok, payload };
    };

    // First call — auto-creates the transcript file.
    const first = await invokeInject("first message");
    expect(first.ok).toBe(true);
    expect(first.payload).toMatchObject({ ok: true });
    expect(fs.existsSync(mockState.transcriptPath)).toBe(true);
    const sizeAfterFirst = fs.statSync(mockState.transcriptPath).size;
    expect(sizeAfterFirst).toBeGreaterThan(0);

    // Second call — must append to the existing file, not fail or overwrite.
    const second = await invokeInject("second message");
    expect(second.ok).toBe(true);
    expect(second.payload).toMatchObject({ ok: true });

    // File must have grown — content from both writes is present.
    const sizeAfterSecond = fs.statSync(mockState.transcriptPath).size;
    expect(sizeAfterSecond).toBeGreaterThan(sizeAfterFirst);
  });
});
