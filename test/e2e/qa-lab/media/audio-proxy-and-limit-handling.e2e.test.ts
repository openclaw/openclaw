import fs from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiMediaUnderstandingProvider } from "../../../../extensions/openai/api.js";
import type { MsgContext } from "../../../../src/auto-reply/templating.js";
import { applyMediaUnderstanding } from "../../../../src/media-understanding/apply.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { listen } from "./media-http.test-support.js";
import { audioConfig } from "./media-understanding.test-support.js";

vi.mock("../../../../src/plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: () => [],
}));

type RequestObservation = {
  method: string | undefined;
  remotePort: number | undefined;
  url: string | undefined;
};
type ProxyRequest = Pick<RequestObservation, "method" | "url">;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function startProviderServer(observations: RequestObservation[]) {
  return await listen(
    createServer((request, response) => {
      void buffer(request)
        .then(() => {
          observations.push({
            method: request.method,
            remotePort: request.socket.remotePort,
            url: request.url,
          });
          response.writeHead(200, { "content-type": "application/json", connection: "close" });
          response.end(JSON.stringify({ text: "proxied audio transcript" }));
        })
        .catch((error: unknown) => {
          response.destroy(error instanceof Error ? error : new Error(String(error)));
        });
    }),
  );
}

async function startForwardProxy(observations: ProxyRequest[], upstreamLocalPorts: Set<number>) {
  // This proof requires CONNECT tunneling; reject accidental direct HTTP forwarding.
  const server = createServer((_request, response) => {
    response.writeHead(400, { connection: "close" });
    response.end("CONNECT required");
  });
  server.on("connect", (request, clientSocket, head) => {
    observations.push({
      method: request.method,
      url: request.url,
    });
    let target: URL;
    try {
      target = new URL(`http://${request.url ?? ""}`);
    } catch {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = net.connect(Number(target.port), target.hostname, () => {
      if (upstream.localPort) {
        upstreamLocalPorts.add(upstream.localPort);
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        upstream.write(head);
      }
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => {
      clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
  });
  return await listen(server);
}

describe("media.audio-proxy-and-limit-handling", () => {
  it("routes provider audio through the CONNECT proxy", async () => {
    const proxyRequests: ProxyRequest[] = [];
    const providerRequests: RequestObservation[] = [];
    const proxyUpstreamPorts = new Set<number>();
    const provider = await startProviderServer(providerRequests);
    const proxy = await startForwardProxy(proxyRequests, proxyUpstreamPorts);
    const dir = await fs.realpath(tempDirs.make("openclaw-audio-qa-"));
    const filePath = path.join(dir, "accepted.wav");
    await fs.writeFile(filePath, Buffer.alloc(2048, 0x52));
    const ctx: MsgContext = { Body: "", media: [{ path: filePath, contentType: "audio/wav" }] };
    const cfg = audioConfig(
      "openai",
      "gpt-4o-transcribe",
      {
        apiKey: "test",
        baseUrl: `${provider.url}/v1`,
        request: { allowPrivateNetwork: true },
        models: [],
      },
      {},
    );

    try {
      await withEnvAsync(
        {
          HTTPS_PROXY: proxy.url,
          HTTP_PROXY: proxy.url,
          ALL_PROXY: "",
          https_proxy: proxy.url,
          http_proxy: proxy.url,
          all_proxy: "",
          NO_PROXY: "",
          no_proxy: "",
        },
        async () => {
          await applyMediaUnderstanding({
            ctx,
            cfg,
            workspaceDir: dir,
            providers: { openai: openaiMediaUnderstandingProvider },
          });

          expect(ctx.Transcript).toBe("proxied audio transcript");
          expect(proxyRequests).toMatchObject([
            { method: "CONNECT", url: new URL(provider.url).host },
          ]);
          expect(providerRequests).toMatchObject([
            { method: "POST", url: "/v1/audio/transcriptions" },
          ]);
          expect(proxyUpstreamPorts.has(providerRequests[0]?.remotePort ?? -1)).toBe(true);
        },
      );
    } finally {
      await proxy.stop();
      await provider.stop();
    }
  });
});
