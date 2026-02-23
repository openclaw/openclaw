/**
 * VNC screen-sharing gateway method + WebSocket-to-TCP proxy.
 *
 * Supports two modes:
 *   1. Local: Browser → Gateway WS → Gateway localhost:5900 (original behaviour)
 *   2. Tunnel: Browser → Gateway WS ↔ Node tunnel WS → Node localhost:5900
 *
 * Tunnel mode is activated when the browser connects to /vnc?nodeId=<id>.
 * The gateway invokes `vnc.tunnel.open` on the node, which opens a dedicated
 * WebSocket back to the gateway at /vnc-tunnel?tunnelId=<uuid>. Binary VNC
 * data is then relayed between the two WebSocket connections.
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { NodeRegistry } from "../node-registry.js";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_VNC_HOST = "127.0.0.1";
const DEFAULT_VNC_PORT = 5900;

/** Pending tunnel: gateway is waiting for the node to connect back. */
type PendingTunnel = {
  browserWs: WebSocket;
  nodeId: string;
  timer: ReturnType<typeof setTimeout>;
};

/** Active tunnel: both browser and node WebSockets are connected. */
type ActiveTunnel = {
  browserWs: WebSocket;
  nodeWs: WebSocket;
  nodeId: string;
};

const TUNNEL_TIMEOUT_MS = 15_000;

/**
 * Create a dedicated WebSocketServer for VNC proxying.
 * Returns an upgrade handler that can be installed on the HTTP server.
 */
export function createVncProxy(opts?: {
  vncHost?: string;
  vncPort?: number;
  nodeRegistry?: NodeRegistry;
}) {
  const vncHost = opts?.vncHost ?? process.env.BOT_VNC_HOST?.trim() ?? DEFAULT_VNC_HOST;
  const vncPort = Number(process.env.BOT_VNC_PORT?.trim() ?? opts?.vncPort ?? DEFAULT_VNC_PORT);
  const nodeRegistry = opts?.nodeRegistry;

  // --- Local VNC proxy (original) ---

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket) => {
    let tcp: Socket | null = null;

    tcp = createConnection({ host: vncHost, port: vncPort }, () => {
      // TCP connected to VNC server — pipe data both directions.
      tcp!.on("data", (data: Buffer) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
        }
      });

      tcp!.on("end", () => {
        ws.close(1000, "VNC server closed");
      });

      tcp!.on("error", (err) => {
        ws.close(1011, `VNC connection error: ${err.message}`);
      });
    });

    tcp.on("error", (err) => {
      ws.close(1011, `Cannot connect to VNC server at ${vncHost}:${vncPort}: ${err.message}`);
    });

    ws.on("message", (data: Buffer) => {
      if (tcp && !tcp.destroyed) {
        tcp.write(data);
      }
    });

    ws.on("close", () => {
      if (tcp && !tcp.destroyed) {
        tcp.end();
      }
    });

    ws.on("error", () => {
      if (tcp && !tcp.destroyed) {
        tcp.destroy();
      }
    });
  });

  // --- Tunnel registry ---

  const pendingTunnels = new Map<string, PendingTunnel>();
  const activeTunnels = new Map<string, ActiveTunnel>();
  const tunnelWss = new WebSocketServer({ noServer: true });

  /** Called when a node connects back at /vnc-tunnel?tunnelId=xxx */
  tunnelWss.on("connection", (nodeWs: WebSocket, _req: IncomingMessage) => {
    // The tunnelId is extracted and validated in handleTunnelUpgrade before
    // reaching this point. We stash it on the socket via a closure in
    // handleTunnelUpgrade so we can retrieve it here.
    const tunnelId = (nodeWs as WebSocket & { __tunnelId?: string }).__tunnelId;
    if (!tunnelId) {
      nodeWs.close(1008, "missing tunnel id");
      return;
    }
    const pending = pendingTunnels.get(tunnelId);
    if (!pending) {
      nodeWs.close(1008, "unknown or expired tunnel id");
      return;
    }

    clearTimeout(pending.timer);
    pendingTunnels.delete(tunnelId);

    const browserWs = pending.browserWs;
    if (browserWs.readyState !== WebSocket.OPEN) {
      nodeWs.close(1000, "browser disconnected");
      return;
    }

    const tunnel: ActiveTunnel = { browserWs, nodeWs, nodeId: pending.nodeId };
    activeTunnels.set(tunnelId, tunnel);

    // Relay: browser ↔ node
    browserWs.on("message", (data: Buffer) => {
      if (nodeWs.readyState === WebSocket.OPEN) {
        nodeWs.send(data);
      }
    });
    nodeWs.on("message", (data: Buffer) => {
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.send(data);
      }
    });

    const cleanup = () => {
      activeTunnels.delete(tunnelId);
      if (browserWs.readyState === WebSocket.OPEN) {
        browserWs.close(1000, "tunnel closed");
      }
      if (nodeWs.readyState === WebSocket.OPEN) {
        nodeWs.close(1000, "tunnel closed");
      }
    };
    browserWs.on("close", cleanup);
    browserWs.on("error", cleanup);
    nodeWs.on("close", cleanup);
    nodeWs.on("error", cleanup);
  });

  // --- Upgrade handlers ---

  /** Handle an HTTP upgrade for the /vnc path. Returns true if handled. */
  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/vnc") {
      return false;
    }
    const nodeId = url.searchParams.get("nodeId");
    if (nodeId && nodeRegistry) {
      // Tunnel mode: create pending tunnel and invoke node.
      handleTunnelBrowserUpgrade(req, socket, head, nodeId);
      return true;
    }
    // Local mode: connect to gateway's own VNC server.
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
    return true;
  }

  /** Start a tunnel: accept browser WS, invoke node, wait for node callback. */
  function handleTunnelBrowserUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    nodeId: string,
  ) {
    const node = nodeRegistry?.get(nodeId);
    if (!node) {
      const msg = `HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n`;
      socket.write(msg);
      socket.destroy();
      return;
    }
    // Accept the browser WebSocket first.
    const tempWss = new WebSocketServer({ noServer: true });
    tempWss.handleUpgrade(req, socket, head, (browserWs) => {
      const tunnelId = randomUUID();
      const timer = setTimeout(() => {
        pendingTunnels.delete(tunnelId);
        browserWs.close(1011, "tunnel timeout: node did not connect back");
      }, TUNNEL_TIMEOUT_MS);
      pendingTunnels.set(tunnelId, { browserWs, nodeId, timer });

      // Derive the HTTP URL for the node to connect back.
      const host = req.headers.host ?? "localhost";
      const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "http";
      const tunnelUrl = `${proto === "https" ? "wss" : "ws"}://${host}/vnc-tunnel?tunnelId=${tunnelId}`;

      // Invoke the node to open a VNC tunnel.
      void nodeRegistry!.invoke({
        nodeId,
        command: "vnc.tunnel.open",
        params: { tunnelId, tunnelUrl },
        timeoutMs: TUNNEL_TIMEOUT_MS,
      });
    });
  }

  /** Handle an HTTP upgrade for the /vnc-tunnel path (node callback). */
  function handleTunnelUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/vnc-tunnel") {
      return false;
    }
    const tunnelId = url.searchParams.get("tunnelId");
    if (!tunnelId || !pendingTunnels.has(tunnelId)) {
      const msg = `HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n`;
      socket.write(msg);
      socket.destroy();
      return true;
    }
    tunnelWss.handleUpgrade(req, socket, head, (ws) => {
      (ws as WebSocket & { __tunnelId?: string }).__tunnelId = tunnelId;
      tunnelWss.emit("connection", ws, req);
    });
    return true;
  }

  function close() {
    for (const [id, pending] of pendingTunnels) {
      clearTimeout(pending.timer);
      pending.browserWs.close(1001, "VNC proxy shutting down");
      pendingTunnels.delete(id);
    }
    for (const [id, tunnel] of activeTunnels) {
      tunnel.browserWs.close(1001, "VNC proxy shutting down");
      tunnel.nodeWs.close(1001, "VNC proxy shutting down");
      activeTunnels.delete(id);
    }
    for (const client of wss.clients) {
      client.close(1001, "VNC proxy shutting down");
    }
    wss.close();
    tunnelWss.close();
  }

  return { handleUpgrade, handleTunnelUpgrade, close, wss };
}

/** noVNC viewer HTML served at GET /vnc-viewer (self-contained, loads noVNC from CDN). */
export function vncViewerHtml(gatewayOrigin: string, nodeId?: string): string {
  const base = gatewayOrigin.replace(/^http/, "ws") + "/vnc";
  const wsUrl = nodeId ? `${base}?nodeId=${encodeURIComponent(nodeId)}` : base;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Hanzo Bot — Remote Desktop</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #0a0a0a; }
    #status { position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
      background: rgba(0,0,0,.75); color: #0f0; font: 13px/1.4 monospace;
      padding: 6px 16px; border-radius: 6px; z-index: 100; }
    #screen { width: 100%; height: 100%; }
  </style>
</head>
<body>
  <div id="status">Connecting…</div>
  <div id="screen"></div>
  <script type="module">
    import RFB from "https://cdn.jsdelivr.net/npm/@nicedash/novnc@1.5.0/+esm";
    const status = document.getElementById("status");
    const rfb = new RFB(document.getElementById("screen"), "${wsUrl}");
    rfb.scaleViewport = true;
    rfb.resizeSession = true;
    rfb.addEventListener("connect", () => { status.textContent = "Connected"; setTimeout(() => status.style.opacity = "0", 2000); });
    rfb.addEventListener("disconnect", (e) => { status.style.opacity = "1"; status.textContent = e.detail.clean ? "Disconnected" : "Connection lost"; });
    rfb.addEventListener("credentialsrequired", () => { status.textContent = "VNC password required"; const pw = prompt("VNC password:"); if (pw) rfb.sendCredentials({ password: pw }); });
  </script>
</body>
</html>`;
}

/** Gateway RPC handler: screen.vnc — returns connection info. */
export const vncHandlers: GatewayRequestHandlers = {
  "screen.vnc": async ({ respond }) => {
    respond(true, {
      available: true,
      viewerPath: "/vnc-viewer",
      wsPath: "/vnc",
      vncPort: Number(process.env.BOT_VNC_PORT?.trim() ?? DEFAULT_VNC_PORT),
      instructions: [
        "macOS: Enable Screen Sharing in System Settings → General → Sharing",
        "Linux: Start a VNC server (e.g. x11vnc) on port 5900",
        "Then open /vnc-viewer in your browser or connect any noVNC client to /vnc",
        "For remote nodes: /vnc-viewer?nodeId=<id> tunnels through the gateway",
      ],
    });
  },
};
