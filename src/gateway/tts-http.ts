import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname } from "node:path";
import { loadConfig } from "../config/config.js";
import { textToSpeech } from "../tts/tts.js";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import {
  readJsonBodyOrError,
  sendInvalidRequest,
  sendMethodNotAllowed,
  sendUnauthorized,
} from "./http-common.js";
import { getBearerToken } from "./http-utils.js";

const AUDIO_CONTENT_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".opus": "audio/opus",
  ".ogg": "audio/ogg",
  ".webm": "audio/webm",
  ".wav": "audio/wav",
};

function resolveAudioContentType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return AUDIO_CONTENT_TYPES[ext] ?? "audio/mpeg";
}

type TtsHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
};

const MAX_BODY_BYTES = 16 * 1024;

export async function handleTtsHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: TtsHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/api/tts/synthesize") {
    return false;
  }

  if (req.method !== "POST") {
    sendMethodNotAllowed(res);
    return true;
  }

  const token = getBearerToken(req);
  const authResult = await authorizeGatewayConnect({
    auth: opts.auth,
    connectAuth: { token, password: token },
    req,
    trustedProxies: opts.trustedProxies,
  });
  if (!authResult.ok) {
    sendUnauthorized(res);
    return true;
  }

  const body = await readJsonBodyOrError(req, res, MAX_BODY_BYTES);
  if (body === undefined) {
    return true;
  }

  const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!text) {
    sendInvalidRequest(res, "Missing or empty `text` field.");
    return true;
  }

  const cfg = loadConfig();
  const result = await textToSpeech({ text, cfg });

  if (!result.success || !result.audioPath) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: result.error ?? "TTS conversion failed" }));
    return true;
  }

  try {
    const stat = statSync(result.audioPath);
    const contentType = resolveAudioContentType(result.audioPath);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", stat.size);
    const stream = createReadStream(result.audioPath);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: "Failed to stream audio file" }));
      } else {
        res.end();
      }
    });
    stream.pipe(res);
  } catch {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Failed to read audio file" }));
  }

  return true;
}
