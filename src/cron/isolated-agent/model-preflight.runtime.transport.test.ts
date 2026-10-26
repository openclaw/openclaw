import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { reserveTestPortListener } from "../../test-utils/port-claims.js";
import {
  preflightCronModelProvider,
  resetCronModelProviderPreflightCacheForTest,
} from "./model-preflight.runtime.js";

const requestedPaths: string[] = [];
const sockets = new Set<Socket>();
const socketClosures: Promise<unknown>[] = [];
let accepted = Promise.withResolvers<void>();
let expectedConnections = 1;
let baseUrl: string;
let unusedPort: number;
let reservation: Awaited<ReturnType<typeof reserveTestPortListener<Server>>>;

function providerParams(api: "ollama" | "openai-completions", suffix = "") {
  const local = {
    api,
    baseUrl: `${baseUrl}${suffix}`,
    apiKey: "synthetic-configured-key",
    headers: { "x-provider-key": "synthetic-configured-header" },
    models: [],
  };
  return {
    cfg: { models: { providers: { local } } },
    provider: "local",
    model: "local-model",
  };
}

async function expectClosedConnections(count: number) {
  await accepted.promise;
  await Promise.all(socketClosures);
  expect({ paths: requestedPaths, open: sockets.size, closed: socketClosures.length }).toEqual({
    paths: [],
    open: 0,
    closed: count,
  });
}

beforeAll(async () => {
  reservation = await reserveTestPortListener<Server>({
    offsets: [0, 1],
    createListener: () =>
      createServer((request, response) => {
        requestedPaths.push(request.url ?? "");
        response.writeHead(401).end();
      }),
  });
  baseUrl = `http://127.0.0.1:${reservation.claim.port}`;
  unusedPort = reservation.claim.port + 1;
  reservation.listener.on("connection", (socket) => {
    sockets.add(socket);
    socketClosures.push(once(socket, "close"));
    socket.once("close", () => sockets.delete(socket));
    if (socketClosures.length === expectedConnections) {
      accepted.resolve();
    }
  });
});

beforeEach(() => {
  resetCronModelProviderPreflightCacheForTest();
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", undefined);
  requestedPaths.length = 0;
  socketClosures.length = 0;
  expectedConnections = 1;
  accepted = Promise.withResolvers<void>();
});

afterAll(async () => {
  vi.unstubAllEnvs();
  resetCronModelProviderPreflightCacheForTest();
  for (const socket of sockets) {
    socket.destroy();
  }
  await reservation.releaseListener();
  await reservation.claim.release();
});

it.each(["ollama", "openai-completions"] as const)(
  "does not make an HTTP request to an authenticated %s provider",
  async (api) => {
    const params = providerParams(api, api === "ollama" ? "" : "/v1");
    expect(await preflightCronModelProvider(params)).toEqual({ status: "available" });
    await expectClosedConnections(1);
    expect(await preflightCronModelProvider(params)).toEqual({ status: "available" });
    expect(socketClosures).toHaveLength(1);
  },
);

it("closes every socket during a concurrent burst without sending HTTP", async () => {
  expectedConnections = 24;
  const results = await Promise.all(
    Array.from({ length: expectedConnections }, (_, index) =>
      preflightCronModelProvider(providerParams("openai-completions", `/v1/provider-${index}`)),
    ),
  );
  await expectClosedConnections(expectedConnections);
  expect(results).toEqual(
    Array.from({ length: expectedConnections }, () => ({ status: "available" })),
  );
});

it("reports a real connection refusal without contacting the HTTP server", async () => {
  const params = providerParams("openai-completions");
  params.cfg.models.providers.local.baseUrl = `http://127.0.0.1:${unusedPort}/v1`;
  expect(await preflightCronModelProvider(params)).toMatchObject({
    status: "unavailable",
    reason: expect.stringContaining("ECONNREFUSED"),
  });
  expect(requestedPaths).toEqual([]);
});
