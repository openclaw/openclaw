import fs from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import path from "node:path";
import { CURRENT_SESSION_VERSION } from "@mariozechner/pi-coding-agent";
import type { WebSocketServer } from "ws";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import type { CanvasHostHandler, CanvasHostServer } from "../canvas-host/server.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { resolveSessionFilePath } from "../config/sessions.js";
import { stopGmailWatcher } from "../hooks/gmail-watcher.js";
import type { HeartbeatRunner } from "../infra/heartbeat-runner.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { abortChatRunById, type ChatAbortControllerEntry } from "./chat-abort.js";
import { appendInjectedAssistantMessageToTranscript } from "./server-methods/chat-transcript-inject.js";
import { loadSessionEntry } from "./session-utils.js";

async function ensureTranscriptFile(params: { transcriptPath: string; sessionId: string }) {
  await fs.mkdir(path.dirname(params.transcriptPath), { recursive: true });
  try {
    await fs.access(params.transcriptPath);
    return;
  } catch {
    // create below
  }
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: params.sessionId,
    timestamp: new Date(0).toISOString(),
    cwd: process.cwd(),
  };
  await fs.writeFile(params.transcriptPath, `${JSON.stringify(header)}\n`, "utf-8");
}

async function injectRestartAbortNotice(params: {
  sessionKey: string;
  sessionId: string;
  runId: string;
}) {
  const { cfg, storePath, entry } = loadSessionEntry(params.sessionKey);
  if (!storePath) {
    return false;
  }
  const transcriptPath = resolveSessionFilePath(params.sessionId, entry, {
    sessionsDir: path.dirname(storePath),
    agentId: resolveSessionAgentId({ sessionKey: params.sessionKey, config: cfg }),
  });
  await ensureTranscriptFile({ transcriptPath, sessionId: params.sessionId });
  const appended = appendInjectedAssistantMessageToTranscript({
    transcriptPath,
    label: "OpenClaw",
    message: "The previous run was interrupted by a gateway restart before it could finish.",
    idempotencyKey: `shutdown-abort:${params.runId}`,
  });
  return appended.ok;
}

export function createGatewayCloseHandler(params: {
  bonjourStop: (() => Promise<void>) | null;
  tailscaleCleanup: (() => Promise<void>) | null;
  canvasHost: CanvasHostHandler | null;
  canvasHostServer: CanvasHostServer | null;
  stopChannel: (name: ChannelId, accountId?: string) => Promise<void>;
  pluginServices: PluginServicesHandle | null;
  cron: { stop: () => void };
  heartbeatRunner: HeartbeatRunner;
  updateCheckStop?: (() => void) | null;
  nodePresenceTimers: Map<string, ReturnType<typeof setInterval>>;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  tickInterval: ReturnType<typeof setInterval>;
  healthInterval: ReturnType<typeof setInterval>;
  dedupeCleanup: ReturnType<typeof setInterval>;
  mediaCleanup: ReturnType<typeof setInterval> | null;
  agentUnsub: (() => void) | null;
  heartbeatUnsub: (() => void) | null;
  chatRunState: { clear: () => void; abortedRuns: Map<string, number> };
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => { sessionKey: string; clientRunId: string } | undefined;
  agentRunSeq: Map<string, number>;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  clients: Set<{ socket: { close: (code: number, reason: string) => void } }>;
  configReloader: { stop: () => Promise<void> };
  browserControl: { stop: () => Promise<void> } | null;
  wss: WebSocketServer;
  httpServer: HttpServer;
  httpServers?: HttpServer[];
}) {
  return async (opts?: { reason?: string; restartExpectedMs?: number | null }) => {
    const reasonRaw = typeof opts?.reason === "string" ? opts.reason.trim() : "";
    const reason = reasonRaw || "gateway stopping";
    const restartExpectedMs =
      typeof opts?.restartExpectedMs === "number" && Number.isFinite(opts.restartExpectedMs)
        ? Math.max(0, Math.floor(opts.restartExpectedMs))
        : null;
    if (params.bonjourStop) {
      try {
        await params.bonjourStop();
      } catch {
        /* ignore */
      }
    }
    if (params.tailscaleCleanup) {
      await params.tailscaleCleanup();
    }
    if (params.canvasHost) {
      try {
        await params.canvasHost.close();
      } catch {
        /* ignore */
      }
    }
    if (params.canvasHostServer) {
      try {
        await params.canvasHostServer.close();
      } catch {
        /* ignore */
      }
    }
    for (const plugin of listChannelPlugins()) {
      await params.stopChannel(plugin.id);
    }
    if (params.pluginServices) {
      await params.pluginServices.stop().catch(() => {});
    }
    await stopGmailWatcher();
    params.cron.stop();
    params.heartbeatRunner.stop();
    try {
      params.updateCheckStop?.();
    } catch {
      /* ignore */
    }
    for (const timer of params.nodePresenceTimers.values()) {
      clearInterval(timer);
    }
    params.nodePresenceTimers.clear();
    for (const [runId, entry] of params.chatAbortControllers.entries()) {
      abortChatRunById(
        {
          chatAbortControllers: params.chatAbortControllers,
          chatRunBuffers: params.chatRunBuffers,
          chatDeltaSentAt: params.chatDeltaSentAt,
          chatAbortedRuns: params.chatRunState.abortedRuns,
          removeChatRun: params.removeChatRun,
          agentRunSeq: params.agentRunSeq,
          broadcast: params.broadcast,
          nodeSendToSession: params.nodeSendToSession,
        },
        { runId, sessionKey: entry.sessionKey, stopReason: "shutdown" },
      );
      await injectRestartAbortNotice({
        sessionKey: entry.sessionKey,
        sessionId: entry.sessionId,
        runId,
      });
    }
    params.broadcast("shutdown", {
      reason,
      restartExpectedMs,
    });
    clearInterval(params.tickInterval);
    clearInterval(params.healthInterval);
    clearInterval(params.dedupeCleanup);
    if (params.mediaCleanup) {
      clearInterval(params.mediaCleanup);
    }
    if (params.agentUnsub) {
      try {
        params.agentUnsub();
      } catch {
        /* ignore */
      }
    }
    if (params.heartbeatUnsub) {
      try {
        params.heartbeatUnsub();
      } catch {
        /* ignore */
      }
    }
    params.chatRunState.clear();
    for (const c of params.clients) {
      try {
        c.socket.close(1012, "service restart");
      } catch {
        /* ignore */
      }
    }
    params.clients.clear();
    await params.configReloader.stop().catch(() => {});
    if (params.browserControl) {
      await params.browserControl.stop().catch(() => {});
    }
    await new Promise<void>((resolve) => params.wss.close(() => resolve()));
    const servers =
      params.httpServers && params.httpServers.length > 0
        ? params.httpServers
        : [params.httpServer];
    for (const server of servers) {
      const httpServer = server as HttpServer & {
        closeIdleConnections?: () => void;
      };
      if (typeof httpServer.closeIdleConnections === "function") {
        httpServer.closeIdleConnections();
      }
      await new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
  };
}
