import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ResolvedGatewayAuth } from "./auth.js";
import { GatewayClient } from "./client.js";

export const VOICE_CONNECT_WS_PATH = "/voice-connect/ws";

export type VoiceConnectWss = {
  wss: WebSocketServer;
};

type ActiveRun = {
  runId: string;
  sessionKey: string;
  fullText: string;
  sentIdx: number;
  cancelled: boolean;
  ended: boolean;
};

const SENTENCE_REGEX = /[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g;

function buildGatewayWsUrl(req: IncomingMessage): string {
  const proto =
    String(req.headers["x-forwarded-proto"] ?? "")
      .toLowerCase()
      .includes("https") || (req.socket as { encrypted?: boolean }).encrypted === true
      ? "wss"
      : "ws";

  // Fallback to loopback to prevent SSRF via Host header injection.
  // When running behind a proxy, the proxy should set OPENCLAW_VOICE_CONNECT_UPSTREAM_WS
  // or use a host that resolves correctly to the gateway.
  return `${proto}://127.0.0.1:18789`;
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function flushPunctuationChunks(run: ActiveRun, ws: WebSocket): void {
  const pending = run.fullText.slice(run.sentIdx);
  if (!pending) {
    return;
  }

  let consumed = 0;
  const matches = pending.match(SENTENCE_REGEX) ?? [];
  for (const m of matches) {
    const chunk = m.trim();
    consumed += m.length;
    if (!chunk) {
      continue;
    }
    // Hold trailing fragment until lifecycle:end unless it clearly ends a sentence/newline.
    const terminal = /[.!?\n]$/.test(m);
    if (!terminal && consumed >= pending.length) {
      consumed -= m.length;
      break;
    }
    if (run.cancelled) {
      return;
    }
    sendJson(ws, {
      type: "assistant_text",
      text: chunk,
      runId: run.runId,
      sessionKey: run.sessionKey,
    });
    // Backward-compatible path used by current Voice Connect UI.
    sendJson(ws, {
      type: "browser_tts",
      text: chunk,
      runId: run.runId,
      sessionKey: run.sessionKey,
    });
  }

  run.sentIdx += consumed;
}

export function createVoiceConnectWss(opts: {
  maxPayloadBytes: number;
  resolvedAuth: ResolvedGatewayAuth;
}): VoiceConnectWss {
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayloadBytes });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    void handleVoiceConnectConnection(ws, req, opts.resolvedAuth);
  });

  return { wss };
}

async function handleVoiceConnectConnection(
  ws: WebSocket,
  req: IncomingMessage,
  resolvedAuth: ResolvedGatewayAuth,
): Promise<void> {
  const pingInterval = setInterval(() => {
    try {
      if (ws.readyState === ws.OPEN) {
        ws.ping();
      }
    } catch {
      // ignore
    }
  }, 15_000);

  let sessionKey = "agent:main:main";
  let activeRun: ActiveRun | null = null;
  let queue = Promise.resolve();

  const gateway = new GatewayClient({
    url: process.env.OPENCLAW_VOICE_CONNECT_UPSTREAM_WS ?? buildGatewayWsUrl(req),
    clientName: "openclaw-control-ui",
    mode: "ui",
    role: "operator",
    scopes: ["operator.read", "operator.write"],
    token: resolvedAuth.mode === "token" ? resolvedAuth.token : undefined,
    password: resolvedAuth.mode === "password" ? resolvedAuth.password : undefined,
    onEvent: (evt) => {
      if (evt.event !== "agent") {
        return;
      }
      const payload = (evt.payload ?? {}) as {
        runId?: string;
        sessionKey?: string;
        stream?: string;
        data?: { text?: string; phase?: string };
      };
      if (!activeRun || payload.runId !== activeRun.runId) {
        return;
      }
      if (payload.sessionKey && payload.sessionKey !== activeRun.sessionKey) {
        return;
      }
      if (activeRun.cancelled) {
        return;
      }

      if (payload.stream === "assistant" && typeof payload.data?.text === "string") {
        activeRun.fullText = payload.data.text;
        flushPunctuationChunks(activeRun, ws);
        return;
      }

      if (payload.stream === "lifecycle" && payload.data?.phase === "end") {
        // Flush any tail fragment.
        if (activeRun.fullText.length > activeRun.sentIdx && !activeRun.cancelled) {
          const tail = activeRun.fullText.slice(activeRun.sentIdx).trim();
          if (tail) {
            sendJson(ws, {
              type: "assistant_text",
              text: tail,
              runId: activeRun.runId,
              sessionKey: activeRun.sessionKey,
            });
            sendJson(ws, {
              type: "browser_tts",
              text: tail,
              runId: activeRun.runId,
              sessionKey: activeRun.sessionKey,
            });
          }
        }
        activeRun.ended = true;
        sendJson(ws, {
          type: "pipeline_done",
          runId: activeRun.runId,
          sessionKey: activeRun.sessionKey,
        });
        activeRun = null;
      }
    },
    onConnectError: (err) => {
      sendJson(ws, { type: "error", message: err.message || "gateway connect failed" });
    },
  });

  gateway.start();

  const cancelActiveRun = async (reason: string) => {
    const run = activeRun;
    if (!run) {
      return;
    }
    run.cancelled = true;
    activeRun = null; // clear before first await

    sendJson(ws, {
      type: "run_cancelled",
      reason,
      runId: run.runId,
      sessionKey: run.sessionKey,
    });
    // Best effort: /stop triggers abortChatRunsForSessionKey in chat handler.
    try {
      await gateway.request("chat.send", {
        sessionKey: run.sessionKey,
        message: "/stop",
        deliver: false,
        idempotencyKey: randomUUID(),
      });
    } catch {
      // no-op best effort
    }
    sendJson(ws, { type: "pipeline_done", runId: run.runId, sessionKey: run.sessionKey });
  };

  const submitUserText = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    if (activeRun) {
      await cancelActiveRun("superseded");
    }

    const runId = randomUUID();
    activeRun = {
      runId,
      sessionKey,
      fullText: "",
      sentIdx: 0,
      cancelled: false,
      ended: false,
    };

    sendJson(ws, { type: "status", status: "thinking", runId, sessionKey });

    try {
      await gateway.request(
        "chat.send",
        {
          sessionKey,
          message: trimmed,
          deliver: false,
          idempotencyKey: runId,
        },
        { expectFinal: false },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (activeRun?.runId === runId) {
        activeRun = null;
      }
      sendJson(ws, { type: "error", message: msg });
      sendJson(ws, { type: "pipeline_done", runId, sessionKey });
    }
  };

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      return;
    }

    const raw =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : "";
    if (!raw) {
      return;
    }

    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = typeof msg.type === "string" ? msg.type : "";

    if (type === "call_start") {
      const key = typeof msg.sessionKey === "string" ? msg.sessionKey.trim() : "";
      if (key) {
        sessionKey = key;
      }
      sendJson(ws, { type: "call_banner", text: `Voice session: ${sessionKey}`, sessionKey });
      queue = queue
        .then(() => submitUserText("Give a short spoken greeting and invite the caller to talk."))
        .catch(() => {});
      return;
    }

    if (type === "user_transcript" || type === "browser_transcript") {
      const text = typeof msg.text === "string" ? msg.text : "";
      queue = queue.then(() => submitUserText(text)).catch(() => {});
      return;
    }

    if (
      type === "cancel" ||
      type === "run.cancel" ||
      type === "tts.barge_in" ||
      type === "speech_start"
    ) {
      queue = queue.then(() => cancelActiveRun(type)).catch(() => {});
      return;
    }

    if (type === "end_call") {
      queue = queue
        .then(async () => {
          await cancelActiveRun("end_call");
          sendJson(ws, { type: "should_hangup", marker: "[end.call]" });
        })
        .catch(() => {});
    }
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    queue = queue
      .then(() => cancelActiveRun("socket_close"))
      .catch(() => {})
      .finally(() => {
        gateway.stop();
      });
  });

  ws.on("error", () => {
    clearInterval(pingInterval);
    gateway.stop();
  });
}
