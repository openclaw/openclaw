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

const endpoints = ["chatCompletions", "responses"] as const;
const routes = { chatCompletions: "/v1/chat/completions", responses: "/v1/responses" };

function mediaBody(path: string, content: unknown[], stream?: boolean) {
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

function publishConfig(config: OpenClawConfig) {
  setRuntimeConfigSnapshot(config, config);
}

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
            method: "GET",
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
  const image =
    endpoint === "chatCompletions"
      ? { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_IMAGE_BASE64}` } }
      : {
          type: "input_image",
          source: { type: "base64", media_type: "image/png", data: PNG_IMAGE_BASE64 },
        };
  const body = JSON.stringify(mediaBody(path, [image]));
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
const inputCases = [
  { name: "chat image", path: "/v1/chat/completions", kind: "image" },
  { name: "response image", path: "/v1/responses", kind: "image" },
  { name: "response file", path: "/v1/responses", kind: "file" },
] as const;

function requestBody(input: { path: string; kind: "image" | "file" }, stream: boolean) {
  const urls = ["first", "second"].map((name) => `${SOURCE_ORIGIN}/${name}`);
  return mediaBody(
    input.path,
    urls.map((url) =>
      input.path === "/v1/chat/completions"
        ? { type: "image_url", image_url: { url } }
        : {
            type: input.kind === "image" ? "input_image" : "input_file",
            source: { type: "url", url },
          },
    ),
    stream,
  );
}

it.each(
  inputCases.flatMap(({ name, path, kind }) =>
    (["complete", "before headers", "during body", "policy changed"] as const).flatMap((phase) =>
      (phase === "complete" ? [false, true] : [false]).map((stream) => ({
        name,
        path,
        kind,
        stream,
        phase,
      })),
    ),
  ),
)("$name stream=$stream: $phase", async (testCase) => {
  const initialRoots = getActiveGatewayRootWorkCount();
  const firstStarted = createDeferredCore();
  const firstHeaders = createDeferredCore();
  const requestClosed = createDeferredCore();
  const requestedSources: string[] = [];
  const bytes = testCase.kind === "image" ? IMAGE_BYTES : Buffer.from("fixture file text");
  let firstResponse: ServerResponse | undefined;
  let firstCanceled = false;
  const upstream = http.createServer((req, res) => {
    requestedSources.push(req.url ?? "");
    res.setHeader("Content-Type", testCase.kind === "image" ? "image/png" : "text/plain");
    if (req.url !== "/first" || testCase.phase === "complete") {
      res.end(bytes);
      return;
    }
    firstResponse = res;
    res.once("close", () => {
      firstCanceled = !res.writableFinished;
    });
    if (testCase.phase === "during body") {
      res.write(bytes.subarray(0, 4));
    }
    firstStarted.resolve();
  });
  const upstreamOrigin = await listen(upstream);
  // Remap only the fixture origin; actual Undici owns request/body cancellation.
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
        const config: OpenClawConfig = {
          agents: { entries: { main: {} } },
          gateway: {
            http: {
              endpoints: {
                chatCompletions: { images: { allowUrl: true } },
                responses: { images: { allowUrl: true }, files: { allowUrl: true } },
              },
            },
          },
        };
        publishConfig(config);
        server.on("request", (_req, res) => res.once("close", requestClosed.resolve));
        const origin = await listen(server);
        const client = http.request(`${origin}${testCase.path}`, {
          method: "POST",
          headers: requestHeaders,
        });
        client.on("error", () => {});
        const completed =
          testCase.phase === "complete" || testCase.phase === "policy changed"
            ? once(client, "response")
            : undefined;
        client.end(JSON.stringify(requestBody(testCase, testCase.stream)));
        try {
          if (testCase.phase === "policy changed") {
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
            const success = testCase.phase === "complete";
            expect(response.statusCode).toBe(success ? 200 : 401);
            if (success) {
              expect(body).toContain("image accepted");
            }
          } else {
            await firstStarted.promise;
            if (testCase.phase === "during body") {
              await firstHeaders.promise;
            }
            client.destroy();
            await requestClosed.promise;
            await vi.waitFor(() => expect(firstCanceled).toBe(true), { timeout: 1_000 });
          }
          expect(requestedSources).toEqual(
            testCase.phase === "complete" ? ["/first", "/second"] : ["/first"],
          );
          expect(agentCommandFromGatewayIngress).toHaveBeenCalledTimes(
            testCase.phase === "complete" ? 1 : 0,
          );
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
