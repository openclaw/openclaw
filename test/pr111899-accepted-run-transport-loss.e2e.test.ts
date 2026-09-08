import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { formatCliJsonFailure } from "../src/cli/failure-output.js";
import { agentCliCommand } from "../src/commands/agent-via-gateway.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { isGatewayTransportError } from "../src/gateway/transport-error.js";
import type { RuntimeEnv } from "../src/runtime.js";
import { captureEnv, setTestEnvValue } from "../src/test-utils/env.js";

const envKeys = [
  "HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_URL",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

/**
 * Starts a loopback WebSocket proxy in front of the real Gateway.
 *
 * The proxy forwards frames in both directions until it sees the Gateway
 * accept the CLI agent run (a `type: "res"` frame whose payload has
 * `status: "accepted"`). At that moment it severs the CLI-facing socket,
 * producing a real transport-loss event after a real Gateway acceptance.
 */
async function startAcceptedThenCloseProxy(targetUrl: string): Promise<{
  url: string;
  stop: () => void;
}> {
  return await new Promise<{ url: string; stop: () => void }>((resolve, reject) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let acceptedSeen = false;

    wss.on("connection", (clientWs) => {
      const targetWs = new WebSocket(targetUrl);

      const forward = (source: WebSocket, destination: WebSocket, destinationName: string) => {
        source.on("message", (raw) => {
          if (destination.readyState !== WebSocket.OPEN) {
            return;
          }
          destination.send(raw);

          if (destinationName === "client" && !acceptedSeen) {
            try {
              const text =
                typeof raw === "string"
                  ? raw
                  : new TextDecoder().decode(Array.isArray(raw) ? Buffer.concat(raw) : raw);
              const message = JSON.parse(text) as {
                type?: unknown;
                payload?: { status?: unknown } | null;
              };
              if (message.type === "res" && message.payload?.status === "accepted") {
                acceptedSeen = true;
                // Transport loss happens right after Gateway acceptance.
                clientWs.close();
                targetWs.close();
                wss.close();
              }
            } catch {
              // ignore non-JSON frames while sniffing for acceptance
            }
          }
        });
        source.on("close", () => {
          try {
            destination.close();
          } catch {
            // ignore double-close
          }
        });
        source.on("error", () => {
          try {
            destination.close();
          } catch {
            // ignore double-close
          }
        });
      };

      targetWs.once("open", () => {
        forward(clientWs, targetWs, "target");
        forward(targetWs, clientWs, "client");
      });

      targetWs.on("error", () => {
        clientWs.close();
      });
    });

    wss.on("listening", () => {
      const address = wss.address();
      if (address && typeof address === "object") {
        resolve({ url: `ws://127.0.0.1:${address.port}`, stop: () => wss.close() });
      } else {
        reject(new Error("proxy did not bind a loopback port"));
      }
    });
    wss.on("error", reject);
  });
}

describe("accepted agent run transport loss against a real gateway", () => {
  let tempHome: string | undefined;

  afterEach(async () => {
    if (tempHome) {
      await fs.rm(tempHome, { recursive: true, force: true });
      tempHome = undefined;
    }
  });

  it(
    "keeps the accepted run id in the stderr hint and the shared JSON failure envelope after transport close",
    { timeout: 120_000 },
    async () => {
      const envSnapshot = captureEnv([...envKeys]);
      let providerServer: ReturnType<typeof createServer> | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let proxy: { url: string; stop: () => void } | undefined;

      try {
        tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pr111899-proof-"));
        const stateDir = path.join(tempHome, ".openclaw");
        const workspaceDir = path.join(tempHome, "workspace");
        const configPath = path.join(stateDir, "openclaw.json");
        const bundledPluginsDir = path.join(tempHome, "bundled-plugins");
        await Promise.all([
          fs.mkdir(workspaceDir, { recursive: true }),
          fs.mkdir(bundledPluginsDir, { recursive: true }),
          fs.mkdir(path.dirname(configPath), { recursive: true }),
        ]);

        for (const [key, value] of Object.entries({
          HOME: tempHome,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: "pr111899-proof-token",
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_GMAIL_WATCHER: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_CANVAS_HOST: "1",
          OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        })) {
          setTestEnvValue(key, value);
        }

        // Hold the provider connection open without responding so the Gateway
        // accepts the run and then waits indefinitely for a final model result.
        providerServer = createServer((_request, response) => {
          response.socket?.setNoDelay(true);
        });
        await new Promise<void>((resolve, reject) => {
          providerServer?.once("error", reject);
          providerServer?.listen(0, "127.0.0.1", resolve);
        });
        const providerAddress = providerServer.address();
        if (!providerAddress || typeof providerAddress === "string") {
          throw new Error("proof provider did not bind a loopback port");
        }
        const provider = buildMockOpenAiResponsesProvider(
          `http://127.0.0.1:${providerAddress.port}`,
        );

        const cfg = {
          agents: {
            defaults: {
              workspace: workspaceDir,
              skipBootstrap: true,
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
              },
            },
            entries: { main: { default: true } },
          },
          models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
          session: { store: path.join(stateDir, "sessions.json"), mainKey: "main" },
          gateway: { auth: { mode: "token", token: "pr111899-proof-token" } },
        };

        gateway = await startGatewayWithClient({
          cfg,
          configPath,
          token: "pr111899-proof-token",
          clientDisplayName: "pr111899-proof-gateway",
        });

        // Put the proxy between the CLI and the real Gateway so we can sever
        // the transport exactly after the Gateway acceptance frame.
        proxy = await startAcceptedThenCloseProxy(`ws://127.0.0.1:${gateway.port}`);
        setTestEnvValue("OPENCLAW_GATEWAY_URL", proxy.url);
        clearRuntimeConfigSnapshot();
        clearConfigCache();

        const errorMessages: string[] = [];
        const runtime: RuntimeEnv = {
          log: () => {},
          error: (message) => {
            if (typeof message === "string") {
              errorMessages.push(message);
            }
          },
          exit: () => {},
        };

        const processLike = {
          exitCode: undefined as NodeJS.Process["exitCode"],
          on: () => processLike,
          off: () => processLike,
        };

        // The transport error propagates through the canonical CLI failure
        // boundary instead of the command returning a bespoke result shape.
        const failure = await agentCliCommand(
          { message: "prove accepted-run transport-loss handling" },
          runtime,
          { process: processLike },
        ).then(
          () => undefined,
          (err: unknown) => err,
        );
        expect(failure).toBeDefined();
        expect(isGatewayTransportError(failure)).toBe(true);

        // The stderr hint names the accepted run so the operator can look it up.
        const hint = errorMessages.find((message) =>
          message.includes("the Gateway may still be running this turn"),
        );
        expect(hint).toBeDefined();
        const acceptedRunId = hint?.match(/accepted run ([^;)]+)/)?.[1];
        expect(acceptedRunId).toBeTruthy();

        // The shared CLI failure renderer — the same owner the CLI entrypoint
        // calls in JSON mode — keeps the documented failure envelope and adds
        // the accepted run provenance; the boundary exits nonzero.
        expect(formatCliJsonFailure(failure, { env: {} })).toEqual({
          ok: false,
          runId: acceptedRunId,
          origin: "gateway",
          error: { type: "cli_error", message: (failure as Error).message },
        });
      } finally {
        proxy?.stop();
        if (gateway) {
          await disconnectGatewayClient(gateway.client).catch(() => undefined);
          await gateway.server.close().catch(() => undefined);
        }
        if (providerServer?.listening) {
          await new Promise<void>((resolve) => {
            providerServer?.close(() => resolve());
          });
        }
        envSnapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    },
  );
});
