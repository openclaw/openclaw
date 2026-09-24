import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.ts";
import {
  PROXY_FIXTURE_CERTIFICATE,
  PROXY_FIXTURE_KEY,
} from "../../../src/test-helpers/proxy-tls-fixture.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";

export const loginProvider = "browser-login-fixture";
const loginCredential = "synthetic-browser-login-key";
export const loginOrigin = "https://files.proxy.test";

export const loginSessionKey = "agent:main:browser-login";
export const loginHistoryMarker = "Existing fixture history.";

type ProviderBrowserLoginBootstrap = (context: {
  instance: OpenClawTestInstance;
  startCandidate: () => Promise<void>;
  seedConversation: () => Promise<void>;
}) => Promise<void>;

export type ProviderBrowserLoginOptions = {
  cwd?: string;
  entrypoint?: string[];
  bootstrap?: ProviderBrowserLoginBootstrap;
};

const bootstrapSource: ProviderBrowserLoginBootstrap = async ({
  startCandidate,
  seedConversation,
}) => {
  await startCandidate();
  await seedConversation();
};

export async function startProviderBrowserLoginFixture(options: ProviderBrowserLoginOptions = {}) {
  const instance = await createOpenClawTestInstance({
    name: "provider-browser-login",
    cwd: options.cwd,
    entrypoint: options.entrypoint,
    env: {
      VITEST: "1",
      OPENCLAW_DISABLE_BONJOUR: "1",
      OPENCLAW_TAILNET_DNS: "files.proxy.test",
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
    },
  });
  const root = instance.state.path("browser-login-fixture");
  const certPath = path.join(root, "certificate.pem");
  const keyPath = path.join(root, "key.pem");
  const edgeConfig = path.join(root, "edge.json");
  const edgeReceipt = path.join(root, "edge-receipt.json");
  const authorizations: Array<{ state: string; redirect: string }> = [];
  const codes = new Map<string, string>();
  const requests: string[] = [];
  const provider = createServer(
    { key: PROXY_FIXTURE_KEY, cert: PROXY_FIXTURE_CERTIFICATE },
    (request, response) => {
      void (async () => {
        const url = new URL(request.url ?? "/", "https://provider.fixture");
        requests.push(url.pathname);
        if (url.pathname === "/authorize") {
          const state = url.searchParams.get("state");
          const redirect = url.searchParams.get("redirect_uri");
          if (!state || !redirect || new URL(redirect).origin !== loginOrigin) {
            response.writeHead(400).end("Unexpected callback origin");
            return;
          }
          authorizations.push({ state, redirect });
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(
            `<!doctype html><title>Fixture provider</title><h1>Authorize fixture account</h1><form action="/complete"><input type="hidden" name="state" value="${state}"><button>Approve sign-in</button></form>`,
          );
          return;
        }
        if (url.pathname === "/complete") {
          const state = url.searchParams.get("state");
          const authorization = authorizations.find((entry) => entry.state === state);
          if (!authorization) {
            response.writeHead(400).end();
            return;
          }
          const code = `fixture-code-${authorizations.length}`;
          codes.set(code, authorization.state);
          const callback = new URL(authorization.redirect);
          callback.searchParams.set("state", authorization.state);
          callback.searchParams.set("code", code);
          response.writeHead(302, { Location: callback.href }).end();
          return;
        }
        if (url.pathname === "/token") {
          let body = "";
          for await (const chunk of request) {
            body += chunk.toString();
          }
          const { code, state } = JSON.parse(body);
          if (typeof code !== "string" || typeof state !== "string" || codes.get(code) !== state) {
            response.writeHead(401).end();
            return;
          }
          codes.delete(code);
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ key: loginCredential }));
          return;
        }
        if (request.headers.authorization !== `Bearer ${loginCredential}`) {
          response.writeHead(401).end();
          return;
        }
        response.setHeader("Content-Type", "application/json");
        if (url.pathname === "/models") {
          response.end(
            JSON.stringify([
              {
                id: "ready",
                name: "Signed-in fixture model",
                reasoning: false,
                input: ["text"],
                contextWindow: 32768,
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ]),
          );
        } else if (url.pathname === "/chat/completions") {
          response.setHeader("Content-Type", "text/event-stream");
          response.end(
            [
              {
                id: "fixture-reply",
                object: "chat.completion.chunk",
                created: 1,
                model: "ready",
                choices: [
                  {
                    index: 0,
                    delta: { role: "assistant", content: "Signed-in fixture reply" },
                    finish_reason: null,
                  },
                ],
              },
              {
                id: "fixture-reply",
                object: "chat.completion.chunk",
                created: 1,
                model: "ready",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              },
            ]
              .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
              .join("") + "data: [DONE]\n\n",
          );
        } else {
          response.writeHead(404).end();
        }
      })().catch((error: unknown) => {
        console.error("Provider browser login fixture failed", error);
        if (!response.headersSent) {
          response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        }
        response.end("Provider browser login fixture failed");
      });
    },
  );
  const close = async () => {
    await runQaGatewayFixture(
      () => instance.stopGateway(),
      async () => {
        provider.closeAllConnections();
        if (provider.listening) {
          await new Promise<void>((resolve, reject) => {
            provider.close((error) => (error ? reject(error) : resolve()));
          });
        }
      },
      () => instance.cleanup(),
    );
  };
  try {
    await fs.mkdir(root);
    const edgePort = await getFreePort();
    await fs.writeFile(certPath, PROXY_FIXTURE_CERTIFICATE);
    await fs.writeFile(keyPath, PROXY_FIXTURE_KEY, { mode: 0o600 });
    const shim = fileURLToPath(
      new URL("../../../test/fixtures/tailscale-browser-login-fixture.mjs", import.meta.url),
    );
    await fs.access(shim, fs.constants.X_OK);
    await fs.writeFile(
      edgeConfig,
      JSON.stringify({
        hostname: "files.proxy.test",
        port: edgePort,
        certPath,
        keyPath,
        receiptPath: edgeReceipt,
      }),
    );
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    const address = provider.address();
    if (!address || typeof address === "string") {
      throw new Error("Provider fixture did not bind TCP");
    }
    const providerOrigin = `https://127.0.0.1:${address.port}`;
    const pluginDir = path.join(root, "plugin");
    await fs.cp(
      fileURLToPath(new URL("../../../test/fixtures/provider-browser-login", import.meta.url)),
      pluginDir,
      { recursive: true },
    );
    const startCandidate = async () => {
      Object.assign(instance.env, {
        OPENCLAW_TEST_TAILSCALE_BINARY: shim,
        OPENCLAW_TEST_TAILSCALE_FIXTURE_MARKER: edgeConfig,
        NODE_EXTRA_CA_CERTS: certPath,
      });
      const config: OpenClawConfig = JSON.parse(await fs.readFile(instance.configPath, "utf8"));
      await instance.state.writeConfig({
        ...config,
        gateway: {
          ...config.gateway,
          tailscale: { mode: "serve" },
          auth: { ...config.gateway?.auth, allowTailscale: false },
          controlUi: { enabled: true, allowedOrigins: [loginOrigin] },
        },
        agents: {
          ownership: "explicit",
          entries: { main: {} },
          defaults: {
            model: `${loginProvider}/ready`,
            modelPolicy: { allow: [`${loginProvider}/*`] },
          },
        },
        models: { catalogRefresh: { enabled: false } },
        cron: { enabled: false },
        logging: { file: path.join(root, "gateway-file.log") },
        plugins: {
          allow: [loginProvider],
          load: { paths: [pluginDir] },
          entries: { [loginProvider]: { enabled: true, config: { origin: providerOrigin } } },
          slots: { memory: "none" },
        },
      });
      await instance.startGateway();
      await fs.access(edgeReceipt);
    };
    await (options.bootstrap ?? bootstrapSource)({
      instance,
      startCandidate,
      seedConversation: async () => {
        for (const [method, params] of [
          [
            "sessions.create",
            { key: loginSessionKey, agentId: "main", label: "Existing fixture conversation" },
          ],
          ["chat.inject", { sessionKey: loginSessionKey, message: loginHistoryMarker }],
        ] as const) {
          const result = await instance.cli([
            "gateway",
            "call",
            method,
            "--json",
            "--params",
            JSON.stringify(params),
          ]);
          if (result.code !== 0) {
            throw new Error(`${method} failed: ${result.stderr}`);
          }
        }
      },
    });
    return {
      instance,
      baseUrl: `${loginOrigin}/`,
      edgePort,
      authorizations,
      requests,
      edgeReceipt,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
