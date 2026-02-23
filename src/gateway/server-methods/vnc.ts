/**
 * VNC screen-sharing gateway method + WebSocket-to-TCP proxy.
 *
 * Enables remote desktop access to the host machine via noVNC in the browser.
 * The gateway proxies a WebSocket connection at /vnc to the local VNC server
 * (macOS Screen Sharing on port 5900 by default).
 *
 * Usage:
 *   1. Enable macOS Screen Sharing (System Settings → General → Sharing → Screen Sharing)
 *   2. The gateway exposes /vnc as a WebSocket-to-TCP bridge
 *   3. Connect with any noVNC client pointing at ws://<gateway>/vnc
 */

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createConnection, type Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { GatewayRequestHandlers } from "./types.js";

const DEFAULT_VNC_HOST = "127.0.0.1";
const DEFAULT_VNC_PORT = 5900;

/**
 * Create a dedicated WebSocketServer for VNC proxying.
 * Returns an upgrade handler that can be installed on the HTTP server.
 */
export function createVncProxy(opts?: { vncHost?: string; vncPort?: number }) {
  const vncHost = opts?.vncHost ?? process.env.BOT_VNC_HOST?.trim() ?? DEFAULT_VNC_HOST;
  const vncPort = Number(process.env.BOT_VNC_PORT?.trim() ?? opts?.vncPort ?? DEFAULT_VNC_PORT);

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

  /** Handle an HTTP upgrade for the /vnc path. Returns true if handled. */
  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/vnc") {
      return false;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
    return true;
  }

  function close() {
    for (const client of wss.clients) {
      client.close(1001, "VNC proxy shutting down");
    }
    wss.close();
  }

  return { handleUpgrade, close, wss };
}

/** noVNC viewer HTML served at GET /vnc-viewer (self-contained, loads noVNC from CDN). */
export function vncViewerHtml(gatewayOrigin: string): string {
  const wsUrl = gatewayOrigin.replace(/^http/, "ws") + "/vnc";
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
      ],
    });
  },
};
