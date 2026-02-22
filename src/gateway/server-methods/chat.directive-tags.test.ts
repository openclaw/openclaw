import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";

const mockState = vi.hoisted(() => ({
  transcriptPath: "",
  sessionId: "sess-1",
  finalText: "[[reply_to_current]]",
}));

vi.mock("../session-utils.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...original,
    loadSessionEntry: () => ({
      cfg: {},
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
  dispatchInboundMessage: vi.fn(
    async (params: {
      dispatcher: {
        sendFinalReply: (payload: { text: string }) => boolean;
        markComplete: () => void;
        waitForIdle: () => Promise<void>;
      };
    }) => {
      params.dispatcher.sendFinalReply({ text: mockState.finalText });
      params.dispatcher.markComplete();
      await params.dispatcher.waitForIdle();
      return { ok: true };
    },
  ),
}));

const { chatHandlers } = await import("./chat.js");

function createTranscriptFixture(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const transcriptPath = path.join(dir, "sess.jsonl");
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: mockState.sessionId,
      timestamp: new Date(0).toISOString(),
      cwd: "/tmp",
    })}\n`,
    "utf-8",
  );
  mockState.transcriptPath = transcriptPath;
}

function extractFirstTextBlock(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const message = (payload as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const first = content[0];
  if (!first || typeof first !== "object") {
    return undefined;
  }
  const firstText = (first as { text?: unknown }).text;
  return typeof firstText === "string" ? firstText : undefined;
}

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
    } as GatewayRequestContext["logGateway"],
  };
}

describe("chat directive tag stripping for non-streaming final payloads", () => {
  it("chat.inject keeps message defined when directive tag is the only content", async () => {
    createTranscriptFixture("openclaw-chat-inject-directive-only-");
    const respond = vi.fn();
    const context = createChatContext();

    await chatHandlers["chat.inject"]({
      params: { sessionKey: "main", message: "[[reply_to_current]]" },
      respond,
      req: {} as never,
      client: null as never,
      isWebchatConnect: () => false,
      context: context as GatewayRequestContext,
    });

    expect(respond).toHaveBeenCalled();
    const [ok, payload] = respond.mock.calls.at(-1) ?? [];
    expect(ok).toBe(true);
    expect(payload).toMatchObject({ ok: true });
    const chatCall = (context.broadcast as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(chatCall?.[0]).toBe("chat");
    expect(chatCall?.[1]).toEqual(
      expect.objectContaining({
        state: "final",
        message: expect.any(Object),
      }),
    );
    expect(extractFirstTextBlock(chatCall?.[1])).toBe("");
  });

  it("chat.send non-streaming final keeps message defined for directive-only assistant text", async () => {
    createTranscriptFixture("openclaw-chat-send-directive-only-");
    mockState.finalText = "[[reply_to_current]]";
    const respond = vi.fn();
    const context = createChatContext();

    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "main",
        message: "hello",
        idempotencyKey: "idem-directive-only",
      },
      respond,
      req: {} as never,
      client: null,
      isWebchatConnect: () => false,
      context: context as GatewayRequestContext,
    });

    await vi.waitFor(() => {
      expect((context.broadcast as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    });

    const chatCall = (context.broadcast as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(chatCall?.[0]).toBe("chat");
    expect(chatCall?.[1]).toEqual(
      expect.objectContaining({
        runId: "idem-directive-only",
        state: "final",
        message: expect.any(Object),
      }),
    );
    expect(extractFirstTextBlock(chatCall?.[1])).toBe("");
  });
});
