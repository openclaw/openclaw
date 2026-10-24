import fs from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
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
  body: Buffer;
  headers: IncomingHttpHeaders;
  method: string | undefined;
  remotePort: number | undefined;
  url: string | undefined;
};
type ProxyRequest = Pick<RequestObservation, "method" | "url">;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function withRequestBody(
  request: NodeJS.ReadableStream,
  response: ServerResponse,
  handle: (body: Buffer) => void,
): void {
  void buffer(request)
    .then(handle)
    .catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
}

async function startProviderServer(observations: RequestObservation[]) {
  return await listen(
    createServer((request, response) => {
      withRequestBody(request, response, (body) => {
        observations.push({
          body,
          headers: request.headers,
          method: request.method,
          remotePort: request.socket.remotePort,
          url: request.url,
        });
        response.writeHead(200, { "content-type": "application/json", connection: "close" });
        response.end(JSON.stringify({ text: "proxied audio transcript" }));
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

async function createAudioContext(tempRoot: string, fileName: string, size: number) {
  const filePath = path.join(tempRoot, fileName);
  await fs.writeFile(filePath, Buffer.alloc(size, 0x52));
  const ctx: MsgContext = {
    Body: "",
    media: [{ path: filePath, contentType: "audio/wav" }],
  };
  return { ctx, workspaceDir: tempRoot };
}

describe("media.audio-proxy-and-limit-handling", () => {
  it("routes provider audio through the proxy and rejects oversized audio before network IO", async () => {
    const proxyRequests: ProxyRequest[] = [];
    const providerRequests: RequestObservation[] = [];
    const proxyUpstreamPorts = new Set<number>();
    const provider = await startProviderServer(providerRequests);
    const proxy = await startForwardProxy(proxyRequests, proxyUpstreamPorts);
    const dir = await fs.realpath(tempDirs.make("openclaw-audio-qa-"));
    const transcribe = async (fileName: string, size: number) => {
      const { ctx, workspaceDir } = await createAudioContext(dir, fileName, size);
      await applyMediaUnderstanding({
        ctx,
        cfg: audioConfig(
          "openai",
          "gpt-4o-transcribe",
          {
            apiKey: "test",
            baseUrl: `${provider.url}/v1`,
            request: { allowPrivateNetwork: true },
            models: [],
          },
          { maxBytes: 4096 },
        ),
        workspaceDir,
        providers: { openai: openaiMediaUnderstandingProvider },
      });
      return ctx;
    };

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
          const accepted = await transcribe("accepted.wav", 2048);

          expect(accepted.Transcript).toBe("proxied audio transcript");
          expect(proxyRequests).toMatchObject([
            { method: "CONNECT", url: new URL(provider.url).host },
          ]);
          expect(providerRequests).toMatchObject([
            { method: "POST", url: "/v1/audio/transcriptions" },
          ]);
          expect(providerRequests[0]?.headers["content-type"]).toContain("multipart/form-data");
          expect(providerRequests[0]?.body.toString("utf8")).toContain("gpt-4o-transcribe");
          expect(proxyUpstreamPorts.has(providerRequests[0]?.remotePort ?? -1)).toBe(true);

          proxyRequests.length = 0;
          providerRequests.length = 0;
          proxyUpstreamPorts.clear();

          const oversized = await transcribe("oversized.wav", 4097);

          expect(oversized.MediaUnderstanding).toBeUndefined();
          expect(JSON.stringify(oversized.MediaUnderstandingDecisions)).toContain(
            "exceeds maxBytes 4096",
          );
          expect(proxyRequests).toHaveLength(0);
          expect(providerRequests).toHaveLength(0);
        },
      );
    } finally {
      await proxy.stop();
      await provider.stop();
    }
  });
});
