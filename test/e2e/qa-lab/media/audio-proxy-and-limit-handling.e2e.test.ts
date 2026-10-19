// Product proof for audio media-understanding proxy routing and size preflight.
import fs from "node:fs/promises";
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openaiMediaUnderstandingProvider } from "../../../../extensions/openai/api.js";
import type { MsgContext } from "../../../../src/auto-reply/templating.js";
import type { OpenClawConfig } from "../../../../src/config/types.js";
import { applyMediaUnderstanding } from "../../../../src/media-understanding/apply.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";

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

type LoopbackServer = {
  server: Server;
  sockets: Set<Socket>;
  url: string;
};

let tempRoot: string | undefined;

afterEach(async () => {
  if (!tempRoot) {
    return;
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
  tempRoot = undefined;
});

async function listen(server: Server): Promise<LoopbackServer> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return { server, sockets, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(handle: LoopbackServer): Promise<void> {
  for (const socket of handle.sockets) {
    socket.destroy();
  }
  handle.server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    handle.server.close((error) => (error ? reject(error) : resolve()));
  });
}

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

async function startProviderServer(observations: RequestObservation[]): Promise<LoopbackServer> {
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

async function startForwardProxy(
  observations: ProxyRequest[],
  upstreamLocalPorts: Set<number>,
): Promise<LoopbackServer> {
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

function createConfig(providerBaseUrl: string, maxBytes: number): OpenClawConfig {
  return {
    models: {
      providers: {
        openai: {
          apiKey: "test",
          baseUrl: providerBaseUrl,
          request: { allowPrivateNetwork: true },
          models: [],
        },
      },
    },
    tools: {
      media: {
        models: [{ provider: "openai", model: "gpt-4o-transcribe", capabilities: ["audio"] }],
        audio: {
          enabled: true,
          maxBytes,
        },
      },
    },
  };
}

async function createAudioContext(
  fileName: string,
  size: number,
): Promise<{
  ctx: MsgContext;
  filePath: string;
  workspaceDir: string;
}> {
  tempRoot ??= await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audio-qa-")));
  const filePath = path.join(tempRoot, fileName);
  await fs.writeFile(filePath, Buffer.alloc(size, 0x52));
  return {
    ctx: {
      Body: "",
      media: [{ path: filePath, contentType: "audio/wav" }],
    },
    filePath,
    workspaceDir: tempRoot,
  };
}

describe("media.audio-proxy-and-limit-handling", () => {
  it("routes provider audio through the proxy and rejects oversized audio before network IO", async () => {
    const proxyRequests: ProxyRequest[] = [];
    const providerRequests: RequestObservation[] = [];
    const proxyUpstreamPorts = new Set<number>();
    const provider = await startProviderServer(providerRequests);
    const proxy = await startForwardProxy(proxyRequests, proxyUpstreamPorts);

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
          const accepted = await createAudioContext("accepted.wav", 2048);
          await applyMediaUnderstanding({
            ctx: accepted.ctx,
            cfg: createConfig(`${provider.url}/v1`, 4096),
            workspaceDir: accepted.workspaceDir,
            providers: { openai: openaiMediaUnderstandingProvider },
          });

          expect(accepted.ctx.Transcript).toBe("proxied audio transcript");
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

          const oversized = await createAudioContext("oversized.wav", 4097);
          await applyMediaUnderstanding({
            ctx: oversized.ctx,
            cfg: createConfig(`${provider.url}/v1`, 4096),
            workspaceDir: oversized.workspaceDir,
            providers: { openai: openaiMediaUnderstandingProvider },
          });

          expect(oversized.ctx.MediaUnderstanding).toBeUndefined();
          expect(JSON.stringify(oversized.ctx.MediaUnderstandingDecisions)).toContain(
            "exceeds maxBytes 4096",
          );
          expect(proxyRequests).toHaveLength(0);
          expect(providerRequests).toHaveLength(0);
        },
      );
    } finally {
      await closeServer(proxy);
      await closeServer(provider);
    }
  });
});
