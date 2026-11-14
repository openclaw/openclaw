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
let reservation: Awaited<ReturnType<typeof reserveTestPortListener<Server>>>;

function providerParams(api: "ollama" | "openai-completions", suffix = "") {
  const local = {
    api,
    baseUrl: `${baseUrl}${suffix}`,
    apiKey: "synthetic-configured-key",
    headers: { "x-provider-key": "synthetic-configured-header" },
    models: [],
  };
  const cfg = { models: { providers: { local } } };
  return { cfg, provider: "local", model: "local-model" };
}

async function expectClosedConnections(count: number) {
  await accepted.promise;
  await Promise.all(socketClosures);
  expect(requestedPaths).toEqual([]);
  expect(sockets.size).toBe(0);
  expect(socketClosures).toHaveLength(count);
}

beforeAll(async () => {
  reservation = await reserveTestPortListener<Server>({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        requestedPaths.push(request.url ?? "");
        response.writeHead(401).end();
      }),
  });
  baseUrl = `http://127.0.0.1:${reservation.claim.port}`;
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

it.each([
  ["ollama", 1],
  ["openai-completions", 24],
] as const)(
  "closes and caches %s probes without sending authenticated HTTP",
  async (api, count) => {
    expectedConnections = count;
    const params = Array.from({ length: count }, (_, index) => providerParams(api, `/v1/${index}`));
    const available = Array.from({ length: count }, () => ({ status: "available" }));
    expect(await Promise.all(params.map(preflightCronModelProvider))).toEqual(available);
    await expectClosedConnections(count);
    expect(await Promise.all(params.map(preflightCronModelProvider))).toEqual(available);
    expect(socketClosures).toHaveLength(count);
  },
);
