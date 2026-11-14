import { createServer, type Server } from "node:http";
import { buffer } from "node:stream/consumers";
import { expect } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

export function createModelChatUpstream(modelId: string, requests: { hasAuth: boolean }[]) {
  return createServer((request, response) => {
    void buffer(request).then((raw) => {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: modelId }] }));
        return;
      }
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end();
        return;
      }
      requests.push({ hasAuth: Boolean(request.headers.authorization) });
      const model = JSON.parse(raw.toString() || "{}").model;
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [
          chunk({ role: "assistant", content: "" }),
          chunk({ content: "pong" }),
          chunk({}, "stop"),
          "data: [DONE]\n\n",
        ].join(""),
      );
    });
  });
}

export function createModelGatewayFixture(options: {
  name: string;
  instanceName: string;
  createUpstream: () => Server;
  config: (baseUrl: string) => Record<string, unknown>;
}) {
  let instance: OpenClawTestInstance;
  const suite = createControlUiE2eSuite({
    name: options.name,
    startServerBeforeBrowser: true,
    async startServer() {
      const upstream = await reserveTestPortListener({
        offsets: [0],
        createListener: options.createUpstream,
      });
      instance = await createOpenClawTestInstance({
        name: options.instanceName,
        reserveIdlePort: false,
        env: {
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          VITEST: undefined,
          NODE_ENV: undefined,
          // Host keys would bypass first-run checks or keep a removed provider signed in.
          ...Object.fromEntries(
            Object.keys(process.env)
              .filter((key) => key.endsWith("_API_KEY"))
              .map((key) => [key, undefined]),
          ),
        },
        config: options.config(`http://127.0.0.1:${upstream.claim.port}`),
      });
      const close = async () => {
        try {
          await instance.cleanup();
        } finally {
          upstream.listener.closeAllConnections();
          await upstream.releaseListener();
          await upstream.claim.release();
        }
      };
      await instance.startGateway().catch(async (error: unknown) => {
        await close();
        throw error;
      });
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close };
    },
  });
  return {
    suite,
    get instance() {
      return instance;
    },
    async open(route: string) {
      // Pairing links are single-use, so each page load needs a fresh handoff.
      const handoff = await instance.cli(["dashboard", "--json"]);
      expect(handoff.code, handoff.stderr).toBe(0);
      const { browserUrl }: { browserUrl: string } = JSON.parse(handoff.stdout);
      const url = new URL(route, browserUrl);
      url.hash = new URL(browserUrl).hash;
      return url.href;
    },
  };
}
