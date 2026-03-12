import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

export const VOICE_CONNECT_WS_PATH = "/voice-connect/ws";

export type VoiceConnectWss = {
  wss: WebSocketServer;
};

export function createVoiceConnectWss(opts: { maxPayloadBytes: number }): VoiceConnectWss {
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayloadBytes });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    void handleVoiceConnectConnection(ws, req);
  });

  return { wss };
}

async function handleVoiceConnectConnection(ws: WebSocket, _req: IncomingMessage): Promise<void> {
  // Minimal stub backend:
  // - Accepts JSON messages: config, call_start
  // - Responds with a browser_tts greeting so the UI can validate the pipeline.
  // - Sends periodic WS pings to keep reverse proxies from idling out the connection.

  const pingInterval = setInterval(() => {
    try {
      if (ws.readyState === 1 /* OPEN */) {
        ws.ping();
      }
    } catch {
      // ignore
    }
  }, 15_000);

  ws.on("close", () => {
    clearInterval(pingInterval);
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      // Ignore audio frames in stub.
      return;
    }

    const raw =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : null;
    if (!raw) {
      return;
    }

    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (!msg || typeof msg !== "object") {
      return;
    }
    const m = msg as Record<string, unknown>;

    if (m.type === "call_start") {
      // Send a short greeting (browser TTS fallback path).
      const greeting = "Hey — NorthPointe here. I’m ready when you are. What’s on your mind?";
      ws.send(JSON.stringify({ type: "browser_tts", text: greeting }));
      ws.send(JSON.stringify({ type: "pipeline_done" }));
      return;
    }

    if (m.type === "browser_transcript") {
      const rawText = typeof m.text === "string" ? m.text : "";
      const text = rawText.trim();
      if (text.toLowerCase().includes("goodbye") || text.toLowerCase().includes("hang up")) {
        // Only honor [end.call] in the full implementation. For now: allow explicit user transcript to hang up.
        ws.send(JSON.stringify({ type: "should_hangup" }));
        ws.send(JSON.stringify({ type: "pipeline_done" }));
        return;
      }
      ws.send(JSON.stringify({ type: "browser_tts", text: `You said: ${text}` }));
      ws.send(JSON.stringify({ type: "pipeline_done" }));
    }
  });

  ws.on("error", () => {
    // noop
  });
}
