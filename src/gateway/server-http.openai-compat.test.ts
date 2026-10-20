import { once } from "node:events";
import http, { type ServerResponse } from "node:http";
import { text } from "node:stream/consumers";
import { expect, it, vi } from "vitest";
import {
  closeHttpServer as close,
  listenLoopback as listen,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { agentCommandFromGatewayIngress } from "../commands/agent.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { fetchWithRuntimeDispatcher } from "../infra/net/runtime-fetch.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  AUTH_NONE,
  AUTH_TOKEN,
  sendRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";

vi.mock("../commands/agent.js", () => ({
  agentCommandFromGatewayIngress: vi.fn(async () => ({
    payloads: [{ text: "image accepted" }],
    meta: { durationMs: 0 },
  })),
}));

const PNG_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PNG_PREFIX = "data:image/png;base64,";

const endpoints = ["chatCompletions", "responses"] as const;
const routes = { chatCompletions: "/v1/chat/completions", responses: "/v1/responses" };

type Kind = "image" | "file";
function mediaBody(path: string, urls: string[], stream?: boolean, kind: Kind = "image") {
  const content = urls.map((url) =>
    path === routes.chatCompletions
      ? { type: "image_url", image_url: { url } }
      : {
          type: kind === "image" ? "input_image" : "input_file",
          source: url.startsWith(PNG_PREFIX)
            ? { type: "base64", media_type: "image/png", data: url.slice(PNG_PREFIX.length) }
            : { type: "url", url },
        },
  );
  return {
    model: "openclaw/main",
    ...(stream === undefined ? {} : { stream }),
    ...(path === "/v1/chat/completions"
      ? { messages: [{ role: "user", content }] }
      : { input: [{ type: "message", role: "user", content }] }),
  };
}

const requestHeaders = {
  authorization: "Bearer test-token",
  "content-type": "application/json",
};

const publishConfig = (config: OpenClawConfig) => setRuntimeConfigSnapshot(config, config);

it.each(endpoints)("hot reloads %s routes on the same server", async (endpoint) => {
  const path = routes[endpoint];
  await withGatewayServer({
    prefix: "openai-compat-hot-reload",
    resolvedAuth: AUTH_NONE,
    overrides: {
      controlUiEnabled: true,
      controlUiBasePath: "",
      openAiChatCompletionsEnabled: undefined,
      openResponsesEnabled: undefined,
    },
    run: async (server) => {
      for (const enabled of [false, true, false]) {
        publishConfig({
          gateway: { http: { endpoints: { [endpoint]: { enabled } } } },
        });

        for (const requestPath of [
          "/v1/models",
          "/v1/models/openclaw",
          "/v1/embeddings",
          ...Object.values(routes),
        ]) {
          const { res, getBody } = await sendRequest(server, {
            path: requestPath,
            headers: { "x-openclaw-scopes": "operator.read" },
          });
          const isModels = requestPath.startsWith("/v1/models");
          const isEnabled =
            enabled && (isModels || requestPath === "/v1/embeddings" || requestPath === path);
          expect(res.statusCode, `${requestPath} with ${endpoint}=${enabled}`).toBe(
            isEnabled ? (isModels ? 200 : 405) : 404,
          );
          if (isEnabled && requestPath === "/v1/models") {
            expect(JSON.parse(getBody())).toMatchObject({
              object: "list",
              data: expect.arrayContaining([expect.objectContaining({ id: "openclaw/default" })]),
            });
          }
        }
      }
    },
  });
});

it.each(endpoints)("hot reloads %s image limits for real HTTP requests", async (endpoint) => {
  const path = routes[endpoint];
  vi.mocked(agentCommandFromGatewayIngress).mockClear();
  const body = JSON.stringify(mediaBody(path, [`${PNG_PREFIX}${PNG_IMAGE_BASE64}`]));
  await withGatewayServer({
    prefix: "openai-compat-image-limit-reload",
    resolvedAuth: AUTH_TOKEN,
    overrides: {
      [endpoint === "chatCompletions" ? "openAiChatCompletionsEnabled" : "openResponsesEnabled"]:
        true,
    },
    run: async (server) => {
      const origin = await listen(server);
      try {
        for (const maxBytes of [1, 1024, 1]) {
          publishConfig({
            agents: { entries: { main: {} } },
            gateway: { http: { endpoints: { [endpoint]: { images: { maxBytes } } } } },
          });
          const response = await fetch(`${origin}${path}`, {
            method: "POST",
            headers: requestHeaders,
            body,
          });
          const responseBody = await response.text();
          expect(response.status, responseBody).toBe(maxBytes === 1 ? 400 : 200);
          if (maxBytes === 1024) {
            expect(responseBody).toContain("image accepted");
          }
        }
        expect(agentCommandFromGatewayIngress).toHaveBeenCalledTimes(1);
      } finally {
        await close(server);
      }
    },
  });
});

const IMAGE_BYTES = Buffer.from(PNG_IMAGE_BASE64, "base64");
const SOURCE_ORIGIN = "https://cdn.example.com";
const SOURCE_URLS = ["first", "second"].map((name) => `${SOURCE_ORIGIN}/${name}`);
const inputCases = [
  { name: "chat image", path: "/v1/chat/completions", kind: "image" },
  { name: "response image", path: "/v1/responses", kind: "image" },
  { name: "response file", path: "/v1/responses", kind: "file" },
] as const;
const phases = [
  ["complete", false],
  ["complete", true],
  ["before headers", false],
  ["during body", false],
  ["policy changed", false],
] as const;

it.each(
  inputCases.flatMap((input) =>
    phases.map(([phase, stream]) => Object.assign({}, input, { phase, stream })),
  ),
)("$name stream=$stream: $phase", async ({ path, kind, stream, phase }) => {
  const initialRoots = getActiveGatewayRootWorkCount();
  const firstStarted = createDeferredCore();
  const firstHeaders = createDeferredCore();
  const requestClosed = createDeferredCore();
  const requestedSources: string[] = [];
  const bytes = kind === "image" ? IMAGE_BYTES : Buffer.from("fixture file text");
  const complete = phase === "complete";
  let firstResponse: ServerResponse | undefined;
  let firstCanceled = false;
  const upstream = http.createServer((req, res) => {
    requestedSources.push(req.url ?? "");
    res.setHeader("Content-Type", kind === "image" ? "image/png" : "text/plain");
    if (req.url !== "/first" || complete) {
      res.end(bytes);
      return;
    }
    firstResponse = res;
    res.once("close", () => {
      firstCanceled = !res.writableFinished;
    });
    if (phase === "during body") {
      res.write(bytes.subarray(0, 4));
    }
    firstStarted.resolve();
  });
  const upstreamOrigin = await listen(upstream);
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== SOURCE_ORIGIN) {
      throw new Error(`Unexpected fixture fetch: ${url.origin}`);
    }
    const response = await fetchWithRuntimeDispatcher(`${upstreamOrigin}${url.pathname}`, init);
    if (url.pathname === "/first") {
      firstHeaders.resolve();
    }
    return response;
  });
  vi.mocked(agentCommandFromGatewayIngress).mockClear();
  try {
    await withGatewayServer({
      prefix: "http-media-preparation",
      resolvedAuth: AUTH_TOKEN,
      overrides: { openAiChatCompletionsEnabled: true, openResponsesEnabled: true },
      run: async (server) => {
        const mediaEndpoints = {
          chatCompletions: { images: { allowUrl: true } },
          responses: { images: { allowUrl: true }, files: { allowUrl: true } },
        };
        const config: OpenClawConfig = {
          agents: { entries: { main: {} } },
          gateway: { http: { endpoints: mediaEndpoints } },
        };
        publishConfig(config);
        server.on("request", (_req, res) => res.once("close", requestClosed.resolve));
        const origin = await listen(server);
        const client = http.request(`${origin}${path}`, {
          method: "POST",
          headers: requestHeaders,
        });
        client.on("error", () => {});
        const completed =
          complete || phase === "policy changed" ? once(client, "response") : undefined;
        client.end(JSON.stringify(mediaBody(path, SOURCE_URLS, stream, kind)));
        try {
          if (phase === "policy changed") {
            await firstStarted.promise;
            publishConfig({
              ...config,
              gateway: { ...config.gateway, allowRealIpFallback: true },
            });
            firstResponse?.end(bytes);
          }
          if (completed) {
            const [response] = await completed;
            const body = await text(response);
            expect(response.statusCode).toBe(complete ? 200 : 401);
            if (complete) {
              expect(body).toContain("image accepted");
            }
          } else {
            await firstStarted.promise;
            if (phase === "during body") {
              await firstHeaders.promise;
            }
            client.destroy();
            await requestClosed.promise;
            await vi.waitFor(() => expect(firstCanceled).toBe(true), { timeout: 1_000 });
          }
          expect(requestedSources).toEqual(complete ? ["/first", "/second"] : ["/first"]);
          expect(agentCommandFromGatewayIngress).toHaveBeenCalledTimes(complete ? 1 : 0);
        } finally {
          client.destroy();
          firstResponse?.destroy();
          await close(server);
          await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(initialRoots));
        }
      },
    });
  } finally {
    fetchSpy.mockRestore();
    await close(upstream);
  }
});
