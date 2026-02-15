import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Guardrail: Ensure that when chat.send processes a slash command without starting an agent run,
// the user's command message is persisted to the session transcript (not just the assistant reply).
// Regression test for https://github.com/openclaw/openclaw/issues/12934
describe("chat.send command transcript – user message persistence", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("appends the user's command message to the transcript when a command is handled without an agent run", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chat-cmd-user-"));
    const transcriptPath = path.join(tempDir, "sess.jsonl");

    // Minimal Pi session header so SessionManager can open/append safely.
    fs.writeFileSync(
      transcriptPath,
      `${JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "sess-cmd-1",
        timestamp: new Date(0).toISOString(),
        cwd: "/tmp",
      })}\n`,
      "utf-8",
    );

    // Ensure no cached modules interfere with our mocks.
    vi.resetModules();

    // Mock loadSessionEntry to point at our temp transcript.
    vi.doMock("../session-utils.js", async (importOriginal) => {
      const original = await importOriginal();
      return {
        ...original,
        loadSessionEntry: () => ({
          cfg: { commands: {} },
          storePath: tempDir,
          canonicalKey: "test-session",
          entry: {
            sessionId: "sess-cmd-1",
            sessionFile: transcriptPath,
          },
        }),
      };
    });

    // Mock dispatchInboundMessage to simulate a command that resolves without starting an agent run.
    // It will deliver a "final" reply via the dispatcher's sendFinalReply method.
    vi.doMock("../../auto-reply/dispatch.js", () => ({
      dispatchInboundMessage: async (params: {
        dispatcher: {
          sendFinalReply: (payload: Record<string, unknown>) => boolean;
          waitForIdle: () => Promise<void>;
        };
      }) => {
        // Simulate the command producing a reply through the dispatcher.
        params.dispatcher.sendFinalReply({ text: "Current status: all good" });
        await params.dispatcher.waitForIdle();
        // Importantly: do NOT call replyOptions.onAgentRunStart, so agentRunStarted stays false.
        return {};
      },
    }));

    // Mock other dependencies that chat.send relies on.
    vi.doMock("../../agents/agent-scope.js", () => ({
      resolveSessionAgentId: () => undefined,
    }));
    vi.doMock("../../agents/model-selection.js", () => ({
      resolveThinkingDefault: () => "off",
    }));
    vi.doMock("../../agents/timeout.js", () => ({
      resolveAgentTimeoutMs: () => 60_000,
    }));
    vi.doMock("../../channels/reply-prefix.js", () => ({
      createReplyPrefixOptions: () => ({ onModelSelected: vi.fn() }),
    }));
    vi.doMock("../../sessions/send-policy.js", () => ({
      resolveSendPolicy: () => "allow",
    }));
    vi.doMock("./agent-timestamp.js", () => ({
      injectTimestamp: (msg: string) => msg,
      timestampOptsFromConfig: () => ({}),
    }));
    vi.doMock("../chat-abort.js", () => ({
      isChatStopCommandText: () => false,
      resolveChatRunExpiresAtMs: () => Date.now() + 60_000,
    }));
    vi.doMock("../chat-attachments.js", () => ({
      parseMessageWithAttachments: async (msg: string) => ({ message: msg, images: [] }),
    }));

    const { chatHandlers } = await import("./chat.js");

    const respond = vi.fn();
    const nodeSendToSession = vi.fn();
    const logGateway = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };

    // Use a deferred promise resolved by the broadcast mock to deterministically wait
    // for the .then() handler to complete instead of relying on timer-based synchronization.
    // Also resolve on error state so failures surface as assertions, not suite-level timeouts.
    let resolveFinished: () => void;
    let rejectFinished: (err: Error) => void;
    const finished = new Promise<void>((resolve, reject) => {
      resolveFinished = resolve;
      rejectFinished = reject;
    });
    const broadcast = vi.fn((_event: string, payload: Record<string, unknown>) => {
      if (payload.state === "final") {
        resolveFinished();
      } else if (payload.state === "error") {
        rejectFinished(new Error(`chat broadcast error: ${JSON.stringify(payload)}`));
      }
    });

    const context = {
      broadcast,
      nodeSendToSession,
      logGateway,
      agentRunSeq: new Map<string, number>(),
      chatAbortControllers: new Map(),
      chatRunBuffers: new Map(),
      chatDeltaSentAt: new Map(),
      chatAbortedRuns: new Map(),
      removeChatRun: vi.fn(),
      dedupe: new Map(),
      registerToolEventRecipient: vi.fn(),
    };

    await chatHandlers["chat.send"]({
      params: {
        sessionKey: "test-session",
        message: "/status",
        idempotencyKey: "run-1",
      },
      respond,
      context,
      // Provide a minimal stub matching GatewayClient so the handler exercises
      // the optional-chaining paths (connect, connId, caps) under realistic conditions.
      client: {
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: { id: "test", version: "1.0.0", platform: "test", mode: "test" },
        },
        connId: "test-conn",
      },
    });

    // Wait for broadcastChatFinal to fire — this happens after transcript writes complete.
    // Bounded timeout ensures failures surface as assertions instead of suite-level hangs.
    await Promise.race([
      finished,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for chat final broadcast")), 10_000),
      ),
    ]);

    // Read the transcript file and parse all entries.
    const rawContent = fs.readFileSync(transcriptPath, "utf-8");
    const lines = rawContent.split(/\r?\n/).filter(Boolean);

    // Expect: header(s) + user message + assistant message = at least 3 lines.
    expect(lines.length).toBeGreaterThanOrEqual(3);

    const entries = lines.slice(1).map((line) => JSON.parse(line) as Record<string, unknown>);
    const messages = entries.filter((e) => e.type === "message");

    // Verify that a user message was persisted.
    const userMessages = messages.filter((m) => {
      const msg = m.message as Record<string, unknown> | undefined;
      return msg?.role === "user";
    });
    expect(userMessages.length).toBeGreaterThanOrEqual(1);

    const userMsg = userMessages[0].message as Record<string, unknown>;
    // The user message content should include the original command text.
    const content = userMsg.content as Array<{ type: string; text: string }>;
    expect(content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("/status") }),
      ]),
    );

    // Also verify the assistant message is still persisted.
    const assistantMessages = messages.filter((m) => {
      const msg = m.message as Record<string, unknown> | undefined;
      return msg?.role === "assistant";
    });
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

    // Verify the user message comes BEFORE the assistant message (correct ordering).
    const userIdx = messages.indexOf(userMessages[0]);
    const assistantIdx = messages.indexOf(assistantMessages[0]);
    expect(userIdx).toBeLessThan(assistantIdx);
  });
});
