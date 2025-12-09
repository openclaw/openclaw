import net from "node:net";

import { getHealthSnapshot, type HealthSummary } from "../commands/health.js";
import { getStatusSummary, type StatusSummary } from "../commands/status.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { type AgentEventPayload, onAgentEvent } from "./agent-events.js";
import {
  emitHeartbeatEvent,
  getLastHeartbeatEvent,
  type HeartbeatEventPayload,
  onHeartbeatEvent,
} from "./heartbeat-events.js";

type ControlRequest = {
  type: "request";
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

type ControlResponse = {
  type: "response";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: string;
};

type ControlEvent = {
  type: "event";
  event: string;
  payload: unknown;
};

type Handlers = {
  setHeartbeats?: (enabled: boolean) => Promise<void> | void;
};

type ControlServer = {
  close: () => Promise<void>;
  broadcastHeartbeat: (evt: HeartbeatEventPayload) => void;
  broadcastAgentEvent: (evt: AgentEventPayload) => void;
};

const DEFAULT_PORT = 18789;

export async function startControlChannel(
  handlers: Handlers = {},
  opts: { port?: number; runtime?: RuntimeEnv } = {},
): Promise<ControlServer> {
  const port = opts.port ?? DEFAULT_PORT;
  const runtime = opts.runtime ?? defaultRuntime;

  const clients = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    clients.add(socket);

    // Seed relay status + last heartbeat for new clients.
    write(socket, {
      type: "event",
      event: "relay-status",
      payload: { state: "running" },
    });
    const last = getLastHeartbeatEvent();
    if (last)
      write(socket, { type: "event", event: "heartbeat", payload: last });

    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        handleLine(socket, line.trim());
      }
    });

    socket.on("error", () => {
      /* ignore */
    });

    socket.on("close", () => {
      clients.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const stopHeartbeat = onHeartbeatEvent((evt) => broadcast("heartbeat", evt));
  const stopAgent = onAgentEvent((evt) => broadcast("agent", evt));

  const handleLine = async (socket: net.Socket, line: string) => {
    if (!line) return;
    const started = Date.now();
    let parsed: ControlRequest;
    try {
      parsed = JSON.parse(line) as ControlRequest;
    } catch (err) {
      runtime.log?.(
        `control: parse error (${String(err)}) on line: ${line.slice(0, 200)}`,
      );
      return write(socket, {
        type: "response",
        id: "",
        ok: false,
        error: `parse error: ${String(err)}`,
      });
    }

    if (parsed.type !== "request" || !parsed.id) {
      return write(socket, {
        type: "response",
        id: parsed.id ?? "",
        ok: false,
        error: "unsupported frame",
      });
    }

    const respond = (payload: unknown, ok = true, error?: string) =>
      write(socket, {
        type: "response",
        id: parsed.id,
        ok,
        payload: ok ? payload : undefined,
        error: ok ? undefined : error,
      });

    try {
      runtime.log?.(`control: recv ${parsed.method}`);
      switch (parsed.method) {
        case "ping": {
          respond({ pong: true, ts: Date.now() });
          break;
        }
        case "health": {
          const summary = await getHealthSnapshot();
          respond(summary satisfies HealthSummary);
          break;
        }
        case "status": {
          const summary = await getStatusSummary();
          respond(summary satisfies StatusSummary);
          break;
        }
        case "last-heartbeat": {
          respond(getLastHeartbeatEvent());
          break;
        }
        case "set-heartbeats": {
          const enabled = Boolean(parsed.params?.enabled);
          if (handlers.setHeartbeats) await handlers.setHeartbeats(enabled);
          respond({ ok: true });
          break;
        }
        default:
          respond(undefined, false, `unknown method: ${parsed.method}`);
          break;
      }
      runtime.log?.(
        `control: ${parsed.method} responded in ${Date.now() - started}ms`,
      );
    } catch (err) {
      runtime.log?.(
        `control: ${parsed.method} failed in ${Date.now() - started}ms: ${String(err)}`,
      );
      respond(undefined, false, String(err));
    }
  };

  const write = (socket: net.Socket, frame: ControlResponse | ControlEvent) => {
    try {
      socket.write(`${JSON.stringify(frame)}\n`);
    } catch {
      // ignore
    }
  };

  const broadcast = (event: string, payload: unknown) => {
    const frame: ControlEvent = { type: "event", event, payload };
    const line = `${JSON.stringify(frame)}\n`;
    for (const client of [...clients]) {
      try {
        client.write(line);
      } catch {
        clients.delete(client);
      }
    }
  };

  runtime.log?.(`control channel listening on 127.0.0.1:${port}`);

  return {
    close: async () => {
      stopHeartbeat();
      stopAgent();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const client of [...clients]) {
        client.destroy();
      }
      clients.clear();
    },
    broadcastHeartbeat: (evt: HeartbeatEventPayload) => {
      emitHeartbeatEvent(evt);
      broadcast("heartbeat", evt);
    },
    broadcastAgentEvent: (evt: AgentEventPayload) => {
      broadcast("agent", evt);
    },
  };
}
