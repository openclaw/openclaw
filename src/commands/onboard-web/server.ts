/**
 * HTTP/WebSocket server for web-based onboarding.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { readFile, stat } from "node:fs/promises";
import type { RuntimeEnv } from "../../runtime.js";
import type { OnboardOptions } from "../onboard-types.js";
import { WebPrompter } from "./web-prompter.js";
import { runOnboardingWizard } from "./wizard-runner.js";
import { WizardCancelledError } from "../../wizard/prompts.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to built frontend assets
const STATIC_DIR = join(__dirname, "../../../dist/onboard-ui");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

interface ServerOptions {
  port: number;
  open: boolean;
  runtime: RuntimeEnv;
  opts: OnboardOptions;
}

export async function startOnboardWebServer(options: ServerOptions): Promise<void> {
  const { port, open, runtime, opts } = options;

  const server = createServer((req, res) => handleHttpRequest(req, res, runtime));
  const wss = new WebSocketServer({ server });

  // Track active connections
  const connections = new Set<WebSocket>();

  // Shutdown function to close the server
  let shutdownRequested = false;
  const requestShutdown = () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    runtime.log("\n[onboard-web] Shutdown requested, closing server...");
    for (const ws of connections) {
      ws.close();
    }
    server.close(() => {
      runtime.log("[onboard-web] Server stopped");
      process.exit(0);
    });
  };

  wss.on("connection", (ws) => {
    connections.add(ws);
    runtime.log("[onboard-web] WebSocket client connected");

    const prompter = new WebPrompter(ws);

    // Handle incoming messages (responses and shutdown requests)
    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());
        // Check for shutdown request
        if (message.type === "shutdown") {
          runtime.log("[onboard-web] Received shutdown request from client");
          ws.send(JSON.stringify({ type: "shutdown_ack" }));
          // Give a moment for the ack to be sent before shutting down
          setTimeout(() => {
            requestShutdown();
          }, 100);
          return;
        }
        // Other messages are handled by the prompter
        prompter.handleMessage(message);
      } catch (error) {
        runtime.error(`[onboard-web] Failed to parse message: ${error}`);
      }
    });

    // Start the onboarding wizard
    runOnboardingWizard(prompter, opts, runtime)
      .then(() => {
        runtime.log("[onboard-web] Onboarding completed");
        ws.send(JSON.stringify({ type: "complete", message: "Onboarding completed successfully" }));
      })
      .catch((error) => {
        // Check if it's a WizardCancelledError (user cancelled the wizard)
        if (error instanceof WizardCancelledError || 
            (error instanceof Error && error.name === "WizardCancelledError")) {
          const reason = error instanceof Error ? error.message : "cancelled";
          runtime.log(`[onboard-web] Onboarding cancelled: ${reason}`);
          ws.send(JSON.stringify({ type: "cancelled", reason }));
        } else {
          const message = error instanceof Error ? error.message : String(error);
          runtime.error(`[onboard-web] Onboarding error: ${message}`);
          ws.send(JSON.stringify({ type: "error", message }));
        }
      })
      .finally(() => {
        connections.delete(ws);
      });

    ws.on("close", () => {
      connections.delete(ws);
      runtime.log("[onboard-web] WebSocket client disconnected");
    });

    ws.on("error", (error) => {
      runtime.error(`[onboard-web] WebSocket error: ${error.message}`);
      connections.delete(ws);
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", (error) => {
      runtime.error(`[onboard-web] Server error: ${error.message}`);
      reject(error);
    });

    server.listen(port, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${port}`;
      runtime.log(`\n[onboard-web] Web onboarding UI available at: ${url}\n`);

      if (open) {
        openBrowser(url, runtime);
      }

      // Keep the server running
      runtime.log("[onboard-web] Press Ctrl+C to stop the server");
    });

    // Handle graceful shutdown
    const shutdown = () => {
      runtime.log("\n[onboard-web] Shutting down...");
      for (const ws of connections) {
        ws.close();
      }
      server.close(() => {
        runtime.log("[onboard-web] Server stopped");
        resolve();
      });
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: RuntimeEnv,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  let pathname = url.pathname;

  // Default to index.html
  if (pathname === "/" || pathname === "") {
    pathname = "/index.html";
  }

  // Security: prevent directory traversal
  if (pathname.includes("..")) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("Forbidden");
    return;
  }

  const filePath = join(STATIC_DIR, pathname);

  try {
    const fileStat = await stat(filePath);

    if (fileStat.isDirectory()) {
      // Try index.html in directory
      const indexPath = join(filePath, "index.html");
      await serveFile(indexPath, res);
    } else {
      await serveFile(filePath, res);
    }
  } catch {
    // File not found - serve index.html for SPA routing
    try {
      await serveFile(join(STATIC_DIR, "index.html"), res);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  }
}

async function serveFile(filePath: string, res: ServerResponse): Promise<void> {
  const content = await readFile(filePath);
  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";

  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
}

function openBrowser(url: string, runtime: RuntimeEnv): void {
  const { platform } = process;

  // Use dynamic import to avoid bundling issues
  void (async () => {
    try {
      const { exec } = await import("node:child_process");
      
      let command: string;
      if (platform === "win32") {
        // On Windows, use rundll32 which is the most reliable way to open URLs
        command = `rundll32 url.dll,FileProtocolHandler ${url}`;
      } else if (platform === "darwin") {
        command = `open "${url}"`;
      } else {
        command = `xdg-open "${url}"`;
      }

      exec(command, (error) => {
        if (error) {
          runtime.log(`[onboard-web] Could not open browser automatically. Please visit: ${url}`);
        }
      });
    } catch {
      runtime.log(`[onboard-web] Could not open browser automatically. Please visit: ${url}`);
    }
  })();
}
