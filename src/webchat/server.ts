import http from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import fs from "node:fs";
import sharp from "sharp";

import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import { danger, info } from "../globals.js";
import { logDebug } from "../logger.js";
import { agentCommand } from "../commands/agent.js";
import type { RuntimeEnv } from "../runtime.js";

const WEBCHAT_DEFAULT_PORT = 18788;

type WebChatServerState = {
  server: http.Server;
  port: number;
};

let state: WebChatServerState | null = null;

function resolveWebRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));

  // 1) Packaged app: resources live next to the relay bundle at
  //    Contents/Resources/WebChat. The relay binary runs from
  //    Contents/Resources/Relay/bun, so walk up one and check.
  const packagedRoot = path.resolve(path.dirname(process.execPath), "../WebChat");
  if (fs.existsSync(packagedRoot)) return packagedRoot;

  // 2) Dev / source checkout: repo-relative path.
  return path.resolve(here, "../../apps/macos/Sources/Clawdis/Resources/WebChat");
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req
      .on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      .on("end", () => resolve(Buffer.concat(chunks)))
      .on("error", reject);
  });
}

function pickSessionId(sessionKey: string, store: Record<string, SessionEntry>): string | null {
  if (store[sessionKey]?.sessionId) return store[sessionKey].sessionId;
  const first = Object.values(store)[0]?.sessionId;
  return first ?? null;
}

function readSessionMessages(sessionId: string, storePath: string): any[] {
  const dir = path.dirname(storePath);
  const candidates = [path.join(dir, `${sessionId}.jsonl`), path.join(os.homedir(), ".tau/agent/sessions/clawdis", `${sessionId}.jsonl`)];
  let content: string | null = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        content = fs.readFileSync(p, "utf-8");
        break;
      } catch {
        // continue
      }
    }
  }
  if (!content) return [];

  const messages: any[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const msg = obj.message ?? obj;
      if (!msg?.role || !msg?.content) continue;
      messages.push({ role: msg.role, content: msg.content });
    } catch (err) {
      logDebug(`webchat history parse error: ${String(err)}`);
    }
  }
  return messages;
}

async function persistAttachments(
  attachments: any[],
  sessionId: string,
): Promise<{ placeholder: string; path: string }[]> {
  const out: { placeholder: string; path: string }[] = [];
  if (!attachments?.length) return out;

  const root = path.join(os.homedir(), ".clawdis", "webchat-uploads", sessionId);
  await fs.promises.mkdir(root, { recursive: true });

  let idx = 1;
  for (const att of attachments) {
    try {
      if (!att?.content || typeof att.content !== "string") continue;
      const mime = typeof att.mimeType === "string" ? att.mimeType : "application/octet-stream";
      const baseName = att.fileName || `${att.type || "attachment"}-${idx}`;
      const ext = mime.startsWith("image/") ? mime.split("/")[1] || "bin" : "bin";
      const fileName = `${baseName}.${ext}`.replace(/[^a-zA-Z0-9._-]/g, "_");
      const buf = Buffer.from(att.content, "base64");

      let finalBuf: Buffer = buf;
      let meta: { width?: number; height?: number } = {};

      if (att.type === "image") {
        const image = sharp(buf, { failOn: "none" });
        meta = await image.metadata();
        const needsResize =
          (meta.width && meta.width > 2000) || (meta.height && meta.height > 2000);
        if (needsResize) {
          const resized = await image
            .resize({ width: 2000, height: 2000, fit: "inside" })
            .toBuffer({ resolveWithObject: true });
          finalBuf = resized.data as Buffer;
          meta = { width: resized.info.width, height: resized.info.height };
        }
      }

      // Hard cap ~6MB after processing
      if (finalBuf.length > 6 * 1024 * 1024) {
        out.push({
          placeholder: `[Attachment too large: ${baseName} (${(finalBuf.length / 1024 / 1024).toFixed(1)} MB)]`,
          path: "",
        });
        idx += 1;
        continue;
      }

      const dest = path.join(root, fileName);
      await fs.promises.writeFile(dest, finalBuf);

      const sizeLabel = `${(finalBuf.length / 1024).toFixed(0)} KB`;
      const dimLabel = meta?.width && meta?.height ? `, ${meta.width}x${meta.height}` : "";
      const placeholder = `[Attachment saved: ${dest} (${mime}${dimLabel}, ${sizeLabel})]`;
      out.push({ placeholder, path: dest });
    } catch (err) {
      out.push({ placeholder: `[Attachment error: ${String(err)}]`, path: "" });
    }
    idx += 1;
  }

  return out;
}

function formatMessageWithAttachments(text: string, saved: { placeholder: string }[]): string {
  if (!saved || saved.length === 0) return text;
  const parts = [text, ...saved.map((s) => `\n\n${s.placeholder}`)];
  return parts.join("");
}

async function handleRpc(body: any, sessionKey: string): Promise<{ ok: boolean; payloads?: any[]; error?: string }> {
  const text: string = (body?.text ?? "").toString();
  if (!text.trim()) return { ok: false, error: "empty text" };
  const attachments = Array.isArray(body?.attachments) ? body.attachments : [];

  const cfg = loadConfig();
  const replyCfg = cfg.inbound?.reply;
  if (!replyCfg || replyCfg.mode !== "command") {
    return { ok: false, error: "agent command mode not configured" };
  }

  const storePath = replyCfg.session?.store
    ? resolveStorePath(replyCfg.session.store)
    : resolveStorePath(undefined);
  const store = loadSessionStore(storePath);
  const sessionId = pickSessionId(sessionKey, store) ?? crypto.randomUUID();

  // Run the agent in-process and capture JSON output instead of spawning the CLI.
  const logs: string[] = [];
  const runtime: RuntimeEnv = {
    log: (msg: string) => void logs.push(String(msg)),
    error: (_msg: string) => {},
    exit: (code: number) => {
      throw new Error(`agent exited ${code}`);
    },
  };

  try {
    const savedAttachments = await persistAttachments(attachments, sessionId);

    await agentCommand(
      {
        message: formatMessageWithAttachments(text, savedAttachments),
        sessionId,
        thinking: body?.thinking,
        deliver: Boolean(body?.deliver),
        to: body?.to,
        json: true,
      },
      runtime,
    );
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  const jsonLine = logs.find((l) => l.trim().startsWith("{"));
  if (!jsonLine) return { ok: false, error: "no agent output" };
  try {
    const parsed = JSON.parse(jsonLine);
    return { ok: true, payloads: parsed.payloads ?? [] };
  } catch (err) {
    return { ok: false, error: `parse error: ${String(err)}` };
  }
}

function notFound(res: http.ServerResponse) {
  res.statusCode = 404;
  res.end("Not Found");
}

export async function startWebChatServer(port = WEBCHAT_DEFAULT_PORT) {
  if (state) return state;

  const root = resolveWebRoot();
  const server = http.createServer(async (req, res) => {
    if (!req.url) return notFound(res);
    // enforce loopback only
    if (req.socket.remoteAddress && !req.socket.remoteAddress.startsWith("127.")) {
      res.statusCode = 403;
      res.end("loopback only");
      return;
    }

    const url = new URL(req.url, "http://127.0.0.1");
    const isInfo = url.pathname === "/webchat/info" || url.pathname === "/info";
    const isRpc = url.pathname === "/webchat/rpc" || url.pathname === "/rpc";

    if (isInfo) {
      const sessionKey = url.searchParams.get("session") ?? "main";
      const cfg = loadConfig();
      const sessionCfg = cfg.inbound?.reply?.session;
      const storePath = sessionCfg?.store
        ? resolveStorePath(sessionCfg.store)
        : resolveStorePath(undefined);
      const store = loadSessionStore(storePath);
      const sessionId = pickSessionId(sessionKey, store);
      const messages = sessionId ? readSessionMessages(sessionId, storePath) : [];
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          port,
          sessionKey,
          storePath,
          sessionId,
          initialMessages: messages,
          basePath: "/",
        }),
      );
      return;
    }

    if (isRpc && req.method === "POST") {
      const bodyBuf = await readBody(req);
      let body: any = {};
      try {
        body = JSON.parse(bodyBuf.toString("utf-8"));
      } catch {
        // ignore
      }
      const sessionKey = body.session || "main";
      const result = await handleRpc(body, sessionKey);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
      return;
    }

    if (url.pathname.startsWith("/webchat")) {
      let rel = url.pathname.replace(/^\/webchat\/?/, "");
      if (!rel || rel.endsWith("/")) rel = rel + "index.html";
      const filePath = path.join(root, rel);
      if (!filePath.startsWith(root)) return notFound(res);
      if (!fs.existsSync(filePath)) return notFound(res);
      const data = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const type =
        ext === ".html"
          ? "text/html"
          : ext === ".js"
            ? "application/javascript"
            : ext === ".css"
              ? "text/css"
              : "application/octet-stream";
      res.setHeader("Content-Type", type);
      res.end(data);
      return;
    }

    if (url.pathname === "/") {
      const filePath = path.join(root, "index.html");
      const data = fs.readFileSync(filePath);
      res.setHeader("Content-Type", "text/html");
      res.end(data);
      return;
    }

    // Static files from root (when served at /)
    const relPath = url.pathname.replace(/^\//, "");
    if (relPath) {
      const filePath = path.join(root, relPath);
      if (filePath.startsWith(root) && fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const type =
          ext === ".html"
            ? "text/html"
            : ext === ".js"
              ? "application/javascript"
              : ext === ".css"
                ? "text/css"
                : "application/octet-stream";
        res.setHeader("Content-Type", type);
        res.end(data);
        return;
      }
    }

    notFound(res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  state = { server, port };
  logDebug(info(`webchat server listening on 127.0.0.1:${port}`));
  return state;
}

export async function ensureWebChatServerFromConfig() {
  const cfg = loadConfig();
  if (cfg.webchat?.enabled === false) return null;
  const port = cfg.webchat?.port ?? WEBCHAT_DEFAULT_PORT;
  try {
    return await startWebChatServer(port);
  } catch (err) {
    logDebug(`webchat server failed to start: ${String(err)}`);
    throw err;
  }
}

export function getWebChatServer(): WebChatServerState | null {
  return state;
}

export async function stopWebChatServer() {
  if (!state) return;
  await new Promise<void>((resolve) => state?.server.close(() => resolve()));
  state = null;
}
