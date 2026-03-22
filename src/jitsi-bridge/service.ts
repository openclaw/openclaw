import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import express from "express";
import { AzureRealtimeTextClient } from "./azure-realtime-client.js";
import type { JitsiBridgeConfig } from "./config.js";
import { buildBridgePrompt } from "./prompts.js";
import { JitsiBridgeRoomStore } from "./room-store.js";
import type { JitsiBridgeRoomRecord } from "./types.js";

type JoinRoomBody = {
  headless?: boolean;
};

type CreateRoomBody = {
  topic?: string;
  id?: string;
  inviteEmail?: string;
  realtimeModel?: string;
};

type BriefingBody = {
  briefing: string;
  append?: boolean;
};

type RespondBody = {
  prompt: string;
};

function isPidRunning(pid: number | undefined): boolean {
  if (!pid || !Number.isFinite(pid)) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function tokenMatches(expected: string, provided: string): boolean {
  try {
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);
    if (expectedBuffer.length !== providedBuffer.length) {
      return false;
    }
    return timingSafeEqual(expectedBuffer, providedBuffer);
  } catch {
    return false;
  }
}

function normalizeJoinUrl(rawUrl: string): string {
  const [base, fragmentRaw] = rawUrl.split("#", 2);
  if (!fragmentRaw) {
    return `${base}#config.startWithAudioMuted=false&config.prejoinConfig.enabled=false`;
  }
  const entries = fragmentRaw
    .split("&")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !part.startsWith("config.startWithAudioMuted="))
    .filter((part) => !part.startsWith("config.prejoinPageEnabled="))
    .filter((part) => !part.startsWith("config.prejoinConfig.enabled="));
  entries.unshift("config.prejoinConfig.enabled=false");
  entries.unshift("config.prejoinPageEnabled=false");
  entries.unshift("config.startWithAudioMuted=false");
  return `${base}#${entries.join("&")}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPathParam(params: express.Request["params"], key: string): string {
  const value = params[key];
  return Array.isArray(value) ? value[0] || "" : value || "";
}

export function createJitsiBridgeApp(config: JitsiBridgeConfig): express.Express {
  const app = express();
  const roomStore = new JitsiBridgeRoomStore(
    config.stateDir,
    config.jitsiBaseUrl,
    config.publicBaseUrl,
    config.downstream.identity.roomTopicFallback,
  );
  app.use(express.json({ limit: "1mb" }));

  async function triggerJoin(
    room: JitsiBridgeRoomRecord,
    headless = true,
  ): Promise<{
    room: JitsiBridgeRoomRecord;
    statusCode: number;
  }> {
    if (isPidRunning(room.lastJoinPid)) {
      const current = await roomStore.update(room.id, (entry) => ({
        ...entry,
        status: entry.status === "joined" ? "joined" : "joining",
        updatedAt: new Date().toISOString(),
      }));
      return { room: current, statusCode: 200 };
    }
    const joinUrl = normalizeJoinUrl(room.jitsiUrl);
    const joinScript = path.resolve(process.cwd(), "scripts", "jitsi-join-room.ts");
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        joinScript,
        "--url",
        joinUrl,
        "--name",
        room.displayName,
        "--room-id",
        room.id,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          JITSI_BRIDGE_STATE_DIR: config.stateDir,
          PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: config.browserExecutablePath || "",
          JITSI_JOIN_HEADLESS: headless ? "1" : "0",
          JITSI_ROOM_ID: room.id,
          JITSI_BRIEFING: room.briefing,
          JITSI_REALTIME_MODEL: room.realtimeModel,
        },
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();
    const nextRoom = await roomStore.update(room.id, (current) => ({
      ...current,
      status: "joining",
      lastJoinPid: child.pid,
      lastError: undefined,
      updatedAt: new Date().toISOString(),
    }));
    return { room: nextRoom, statusCode: 202 };
  }

  async function triggerStop(room: JitsiBridgeRoomRecord): Promise<{
    room: JitsiBridgeRoomRecord;
    statusCode: number;
  }> {
    const pid = room.lastJoinPid;
    if (!pid || !Number.isFinite(pid)) {
      const next = await roomStore.update(room.id, (current) => ({
        ...current,
        status: "stopped",
        lastError: undefined,
        updatedAt: new Date().toISOString(),
      }));
      return { room: next, statusCode: 200 };
    }

    // Detached joiner runs in its own process group; kill group first, then fallback to pid.
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // Ignore missing/stale process errors.
      }
    }

    // Fast escalation to avoid long room leave delays.
    await sleep(1200);
    if (isPidRunning(pid)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Ignore missing/stale process errors.
        }
      }
    }

    const nextRoom = await roomStore.update(room.id, (current) => ({
      ...current,
      status: "stopped",
      lastJoinPid: undefined,
      lastError: undefined,
      updatedAt: new Date().toISOString(),
    }));
    return { room: nextRoom, statusCode: 200 };
  }

  async function loadRoomWithTokenOrReject(
    req: express.Request,
    res: express.Response,
  ): Promise<JitsiBridgeRoomRecord | null> {
    const roomId = readPathParam(req.params, "roomId");
    const room = await roomStore.get(roomId);
    if (!room) {
      res.status(404).send("Unknown room");
      return null;
    }
    const token = typeof req.query.token === "string" ? req.query.token.trim() : "";
    if (!token || !tokenMatches(room.joinToken, token)) {
      res.status(403).send("Invalid token");
      return null;
    }
    return room;
  }

  app.get("/health", async (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/rooms", async (_req, res, next) => {
    try {
      res.json({ rooms: await roomStore.list() });
    } catch (error) {
      next(error);
    }
  });

  app.get("/rooms/:roomId", async (req, res, next) => {
    try {
      const room = await roomStore.get(req.params.roomId);
      if (!room) {
        res.status(404).json({ error: `Unknown room ${req.params.roomId}` });
        return;
      }
      res.json(room);
    } catch (error) {
      next(error);
    }
  });

  app.post("/rooms", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as CreateRoomBody;
      const room = await roomStore.create({
        id: body.id?.trim(),
        topic: body.topic,
        inviteEmail: body.inviteEmail?.trim() || config.inviteEmail,
        realtimeModel: body.realtimeModel?.trim() || config.realtimeModel,
        displayName: config.displayName,
      });
      res.status(201).json(room);
    } catch (error) {
      next(error);
    }
  });

  app.post("/rooms/:roomId/briefing", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as BriefingBody;
      if (typeof body.briefing !== "string" || !body.briefing.trim()) {
        res.status(400).json({ error: "briefing is required" });
        return;
      }
      const room = await roomStore.update(req.params.roomId, (current) => {
        const nextBriefing = body.append
          ? [current.briefing.trim(), body.briefing.trim()].filter(Boolean).join("\n\n")
          : body.briefing.trim();
        return {
          ...current,
          briefing: nextBriefing,
          status: "briefed",
          updatedAt: new Date().toISOString(),
        };
      });
      res.json(room);
    } catch (error) {
      next(error);
    }
  });

  app.post("/rooms/:roomId/respond", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as RespondBody;
      if (typeof body.prompt !== "string" || !body.prompt.trim()) {
        res.status(400).json({ error: "prompt is required" });
        return;
      }
      const room = await roomStore.get(req.params.roomId);
      if (!room) {
        res.status(404).json({ error: `Unknown room ${req.params.roomId}` });
        return;
      }
      const client = new AzureRealtimeTextClient(
        config.realtimeBaseUrl,
        config.realtimeApiKey,
        room.realtimeModel,
      );
      const text = await client.runTextTurn({
        instructions: buildBridgePrompt({
          briefing: room.briefing,
          roomId: room.id,
          promptConfig: config.downstream.prompt,
        }),
        inputText: body.prompt.trim(),
      });
      res.json({ text, roomId: room.id, model: room.realtimeModel });
    } catch (error) {
      next(error);
    }
  });

  app.post("/rooms/:roomId/join", async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as JoinRoomBody;
      const room = await roomStore.get(req.params.roomId);
      if (!room) {
        res.status(404).json({ error: `Unknown room ${req.params.roomId}` });
        return;
      }
      const result = await triggerJoin(room, body.headless !== false);
      res.status(result.statusCode).json(result.room);
    } catch (error) {
      next(error);
    }
  });

  app.post("/rooms/:roomId/stop", async (req, res, next) => {
    try {
      const room = await roomStore.get(req.params.roomId);
      if (!room) {
        res.status(404).json({ error: `Unknown room ${req.params.roomId}` });
        return;
      }
      const result = await triggerStop(room);
      res.status(result.statusCode).json(result.room);
    } catch (error) {
      next(error);
    }
  });

  app.get("/meeting/:roomId/start", async (req, res, next) => {
    try {
      const room = await loadRoomWithTokenOrReject(req, res);
      if (!room) {
        return;
      }
      const startPath = `/meeting/${encodeURIComponent(room.id)}/enter?token=${encodeURIComponent(room.joinToken)}`;
      res.status(200).type("html").send(`<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Meeting Start</title>
    <style>
      :root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f8fafc; color: #0f172a; }
      main { width: min(680px, 92vw); background: #ffffff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 24px; box-shadow: 0 8px 30px rgba(15,23,42,.08); }
      h1 { font-size: 1.3rem; margin: 0 0 8px; }
      p { margin: 0 0 14px; line-height: 1.45; }
      .id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #334155; }
      a.btn { display: inline-block; text-decoration: none; background: #0f172a; color: #fff; padding: 11px 16px; border-radius: 10px; font-weight: 600; }
      a.btn:hover { background: #1e293b; }
    </style>
  </head>
  <body>
    <main>
      <h1>Meeting bereit</h1>
      <p>Ein Klick startet den Bot-Join und leitet dich dann ins Meeting weiter.</p>
      <p class="id">Room: ${htmlEscape(room.id)}</p>
      <a class="btn" href="${startPath}">Join</a>
    </main>
  </body>
</html>`);
    } catch (error) {
      next(error);
    }
  });

  app.get("/meeting/:roomId/enter", async (req, res, next) => {
    try {
      const room = await loadRoomWithTokenOrReject(req, res);
      if (!room) {
        return;
      }
      await triggerJoin(room, true);
      res.redirect(302, room.jitsiUrl);
    } catch (error) {
      next(error);
    }
  });

  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
    },
  );

  return app;
}
