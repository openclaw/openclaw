import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { formatCliJsonFailure } from "../src/cli/failure-output.js";
import { agentCliCommand } from "../src/commands/agent-via-gateway.js";
import { startGatewayWithClient } from "../src/gateway/test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { isGatewayTransportError } from "../src/gateway/transport-error.js";
import { rawDataToString } from "../src/infra/ws.js";
import type { RuntimeEnv } from "../src/runtime.js";
import { setTestEnvValue } from "../src/test-utils/env.js";
import { listenProofProvider, useRuntimeProofFixture } from "./runtime-proof.test-support.js";

const createFixture = useRuntimeProofFixture(afterEach);

// Sever the real transport only after the Gateway has accepted the CLI run.
function startAcceptedThenCloseProxy(targetUrl: string) {
  return new Promise<{ url: string; stop: () => void }>((resolve, reject) => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let acceptedSeen = false;

    wss.on("connection", (clientWs) => {
      const targetWs = new WebSocket(targetUrl);

      const forward = (source: WebSocket, destination: WebSocket) => {
        source.on("message", (raw) => {
          if (destination.readyState !== WebSocket.OPEN) {
            return;
          }
          destination.send(raw);

          if (destination === clientWs && !acceptedSeen) {
            try {
              const message = JSON.parse(rawDataToString(raw)) as {
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
        for (const event of ["close", "error"] as const) {
          source.on(event, () => {
            try {
              destination.close();
            } catch {
              // ignore double-close
            }
          });
        }
      };

      targetWs.once("open", () => {
        forward(clientWs, targetWs);
        forward(targetWs, clientWs);
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

it(
  "keeps the accepted run id in the stderr hint and the shared JSON failure envelope after transport close",
  { timeout: 120_000 },
  async () => {
    const fixture = await createFixture("openclaw-pr111899-proof-", "pr111899-proof-token");
    const { stateDir, configPath } = fixture;
    let providerServer: ReturnType<typeof createServer> | undefined;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let proxy: { url: string; stop: () => void } | undefined;
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;

    try {
      // Hold the model response so transport loss follows acceptance, not completion.
      providerServer = createServer((_request, response) => {
        response.socket?.setNoDelay(true);
      });
      const providerUrl = await listenProofProvider(providerServer);
      const provider = buildMockOpenAiResponsesProvider(providerUrl);

      const cfg = fixture.config(
        provider,
        {
          models: { [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } } },
        },
        { session: { store: path.join(stateDir, "sessions.json"), mainKey: "main" } },
      );

      gateway = await startGatewayWithClient({
        cfg,
        configPath,
        token: "pr111899-proof-token",
        clientDisplayName: "pr111899-proof-gateway",
      });

      proxy = await startAcceptedThenCloseProxy(`ws://127.0.0.1:${gateway.port}`);
      setTestEnvValue("OPENCLAW_GATEWAY_URL", proxy.url);

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

      const failure = await agentCliCommand(
        { message: "prove accepted-run transport-loss handling" },
        runtime,
      ).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(failure).toBeDefined();
      expect(isGatewayTransportError(failure)).toBe(true);

      const hint = errorMessages.find((message) =>
        message.includes("the Gateway may still be running this turn"),
      );
      expect(hint).toBeDefined();
      const acceptedRunId = hint?.match(/accepted run ([^;)]+)/)?.[1];
      expect(acceptedRunId).toBeTruthy();

      expect(formatCliJsonFailure(failure, { env: {} })).toEqual({
        ok: false,
        runId: acceptedRunId,
        origin: "gateway",
        error: { type: "cli_error", message: (failure as Error).message },
      });
    } finally {
      try {
        proxy?.stop();
        await fixture.close(gateway, providerServer);
      } finally {
        process.exitCode = originalExitCode;
      }
    }
  },
);
