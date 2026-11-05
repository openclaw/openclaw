import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import https from "node:https";
import { createRequire } from "node:module";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  PROXY_FIXTURE_CERTIFICATE,
  PROXY_FIXTURE_KEY,
} from "../../../../src/test-helpers/proxy-tls-fixture.js";
import { loadBundledPluginFacade } from "../../../../src/test-utils/bundled-plugin-public-surface.js";
import { reserveTestPortListener } from "../../../../src/test-utils/port-claims.js";
import { connectGatewayStatusClient } from "../../../helpers/gateway-e2e-harness.js";
import { withNativeSecretService } from "../../../helpers/native-secret-service.js";
import { writeOpenAiResponsesText } from "../../../helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "../../../helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

// Public test-only leaf signed by PROXY_FIXTURE_CERTIFICATE.
const SERVER_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBhTCCASugAwIBAgIBAjAKBggqhkjOPQQDAjAbMRkwFwYDVQQDDBBmaWxlcy5w
cm94eS50ZXN0MCAXDTI2MTAyODA1MzQ0N1oYDzIxMjYxMDA0MDUzNDQ3WjAUMRIw
EAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAS2agSj
NN3IROHs3GAdJdxO0snmqgW2RetuJKeRbn/e082TR8Sx5/yPcAcyAp6hEH19g3tF
/CT7/QGiGm96BZheo2UwYzAMBgNVHRMBAf8EAjAAMA4GA1UdDwEB/wQEAwIHgDAT
BgNVHSUEDDAKBggrBgEFBQcDATAPBgNVHREECDAGhwR/AAABMB0GA1UdDgQWBBRQ
mY8ZLuaAJjUU4JiehaVg+f+KoDAKBggqhkjOPQQDAgNIADBFAiEAv6I7QWvupklp
hanSnrw4JsVCI2kI/YCizAz6F1Lcr6kCIFCwSRa2gtugKpCQ9YeTPCVylRLd/K+p
IVAnJ8E0VJ6i
-----END CERTIFICATE-----`;
const PROVIDER = "command-fixture";
const COMBINED_PROVIDER = "combined-fixture";
const MODEL = "gpt-5.6-luna";
const TOKEN = "synthetic-command-only-token";
const ANSWER = "P5_NATIVE_COMMAND_GATEWAY_OK";

for (const combined of [false, true]) {
  // Secret Service is a Linux backend; primary-only coverage stays portable.
  it(
    `keeps ${combined ? "combined" : "command-only"} native auth owned by Codex without host credentials`,
    { timeout: 240_000, skip: combined && process.platform !== "linux" },
    async ({ signal }) => {
      const run = async (secretEnv: Record<string, string>) => {
        const provider = combined ? COMBINED_PROVIDER : PROVIDER;
        const require = createRequire(path.join(process.cwd(), "extensions/codex/package.json"));
        const launcher = path.join(
          path.dirname(require.resolve("@openai/codex/package.json")),
          "bin/codex.js",
        );
        const requests: Array<{
          model: unknown;
          commandBearer: boolean;
          secondaryBearer: boolean;
          nativeHeader: boolean;
        }> = [];
        const grants: string[] = [];
        const catalogCredentials: Array<{ primary: boolean; secondary: boolean }> = [];
        const failures: string[] = [];
        const reserved = await reserveTestPortListener({
          offsets: [0],
          signal,
          createListener: () =>
            https.createServer(
              { key: PROXY_FIXTURE_KEY, cert: SERVER_CERTIFICATE },
              (request, response) => {
                void (async () => {
                  const endpoint = new URL(request.url ?? "/", "https://127.0.0.1").pathname;
                  if (endpoint === "/token") {
                    const chunks: Buffer[] = [];
                    for await (const chunk of request) {
                      chunks.push(Buffer.from(chunk));
                    }
                    const grant =
                      new URLSearchParams(Buffer.concat(chunks).toString("utf8")).get(
                        "grant_type",
                      ) ?? "missing";
                    grants.push(grant);
                    response.writeHead(200, { "Content-Type": "application/json" }).end(
                      JSON.stringify({
                        access_token: "synthetic-secondary-token",
                        refresh_token: "synthetic-refresh-token",
                        token_type: "Bearer",
                        expires_in: grant === "authorization_code" ? 1 : 3600,
                      }),
                    );
                    return;
                  }
                  if (endpoint === "/v1/models") {
                    catalogCredentials.push({
                      primary: request.headers.authorization === "Bearer " + TOKEN,
                      secondary:
                        request.headers["x-gateway-authorization"] ===
                        "Bearer synthetic-secondary-token",
                    });
                  }
                  if (request.method !== "POST" || endpoint !== "/v1/responses") {
                    request.resume();
                    response.writeHead(404).end();
                    return;
                  }
                  const chunks: Buffer[] = [];
                  for await (const chunk of request) {
                    chunks.push(Buffer.from(chunk));
                  }
                  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                  if (!isRecord(parsed)) {
                    throw new Error("Invalid Responses request");
                  }
                  requests.push({
                    model: parsed.model,
                    commandBearer: request.headers.authorization === "Bearer " + TOKEN,
                    secondaryBearer:
                      request.headers["x-gateway-authorization"] ===
                      "Bearer synthetic-secondary-token",
                    nativeHeader: request.headers["x-native-proof"] === "synthetic-native-header",
                  });
                  writeOpenAiResponsesText(response, {
                    text: ANSWER,
                    messageId: "message-" + requests.length,
                    responseId: "response-" + requests.length,
                  });
                })().catch((error: unknown) => {
                  failures.push(String(error));
                  response.writeHead(500).end();
                });
              },
            ),
        });
        const baseUrl = "https://127.0.0.1:" + reserved.claim.port + "/v1";
        const profile = "p5-native-command-proof";
        const instance = await createOpenClawTestInstance({
          name: profile,
          signal,
          entrypoint: ["dist/index.js", "--profile", profile],
          env: {
            ...secretEnv,
            OPENCLAW_PROFILE: profile,
            OPENCLAW_SKIP_PROVIDERS: undefined,
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            OPENAI_API_KEY: undefined,
            CODEX_API_KEY: undefined,
            CODEX_ACCESS_TOKEN: undefined,
          },
          config: {
            models: {
              mode: "replace",
              catalogRefresh: { enabled: false },
              providers: {
                [provider]: {
                  auth: "native-command",
                  api: "openai-responses",
                  baseUrl,
                  agentRuntime: { id: "codex" },
                  models: [
                    {
                      id: MODEL,
                      name: "Synthetic command model",
                      reasoning: true,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 100000,
                      maxTokens: 1000,
                    },
                  ],
                },
              },
            },
            plugins: {
              enabled: true,
              allow: ["codex"],
              entries: {
                codex: {
                  enabled: true,
                  config: {
                    appServer: {
                      command: launcher,
                      args: ["app-server"],
                      mode: "yolo",
                      sandbox: "read-only",
                      requestTimeoutMs: 60000,
                    },
                  },
                },
              },
            },
            agents: {
              defaults: {
                model: { primary: provider + "/" + MODEL, fallbacks: [] },
                workspace: "~/workspace",
                skipBootstrap: true,
                skills: [],
                timeoutSeconds: 60,
                sandbox: { mode: "off" },
              },
            },
          },
        });
        await runQaGatewayFixture(
          async () => {
            instance.env.OPENCLAW_GATEWAY_PORT = String(instance.port);
            const ca = instance.state.path("fixture-ca.pem");
            await fs.writeFile(ca, PROXY_FIXTURE_CERTIFICATE);
            instance.env.SSL_CERT_FILE = ca;
            const codexHome = path.join(instance.state.agentDir(), "codex-home");
            await fs.mkdir(codexHome, { recursive: true });
            const command = instance.state.path("token-command.mjs");
            await fs.writeFile(
              command,
              [
                "if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.CODEX_ACCESS_TOKEN) process.exit(21);",
                "process.stdout.write(" + JSON.stringify(TOKEN) + ");",
              ].join("\n"),
            );
            await fs.writeFile(
              path.join(codexHome, "config.toml"),
              [
                "model=" + JSON.stringify(MODEL),
                "model_provider=" + JSON.stringify(provider),
                'cli_auth_credentials_store="ephemeral"',
                'web_search="disabled"',
                'approval_policy="never"',
                'sandbox_mode="read-only"',
                "allow_login_shell=false",
                "[features]",
                "shell_snapshot=false",
                "secret_auth_storage=true",
                "[analytics]",
                "enabled=false",
                "[feedback]",
                "enabled=false",

                "[model_providers." + provider + "]",
                'name="Synthetic command provider"',
                "base_url=" + JSON.stringify(baseUrl),
                'wire_api="responses"',
                "requires_openai_auth=false",
                "supports_websockets=false",
                "request_max_retries=0",
                "stream_max_retries=0",
                'http_headers={"x-native-proof"="synthetic-native-header"}',
                "[model_providers." + provider + ".auth]",
                "command=" + JSON.stringify(process.execPath),
                "args=[" + JSON.stringify(command) + "]",
                ...(combined
                  ? [
                      "[model_providers." + provider + ".gateway_oauth]",
                      "authorization_url=" + JSON.stringify(baseUrl.replace("/v1", "/authorize")),
                      "token_url=" + JSON.stringify(baseUrl.replace("/v1", "/token")),
                      'client_id="synthetic-native-client"',
                      'delivery={kind="header",name="X-Gateway-Authorization"}',
                    ]
                  : []),
              ].join("\n"),
            );
            await instance.state.writeAuthProfiles({
              version: 1,
              profiles: {
                "openai:decoy": {
                  type: "api_key",
                  provider: "openai",
                  key: "synthetic-stored-decoy",
                },
              },
            });
            instance.env.OPENAI_API_KEY = "synthetic-env-decoy";
            instance.env.CODEX_API_KEY = "synthetic-codex-decoy";
            instance.env.CODEX_ACCESS_TOKEN = "synthetic-token-decoy";
            if (combined) {
              const api = await loadBundledPluginFacade<
                typeof import("../../../../extensions/codex/test-api.js")
              >({ pluginId: "codex", artifactBasename: "test-api.js" });
              const { loginNativeCommandGatewayForTest } =
                await api.loadNativeCommandGatewayTestFixture();
              await loginNativeCommandGatewayForTest({
                launcher,
                codexHome,
                cwd: instance.state.workspaceDir,
                env: { ...secretEnv, SSL_CERT_FILE: ca },
                signal,
              });
              expect(grants).toEqual(["authorization_code"]);
              console.info(
                "[native-command-proof] secondary account persisted; native setup process closed",
              );
            }
            await instance.startGateway();
            const client = await connectGatewayStatusClient(instance);
            await runQaGatewayFixture(
              async () => {
                const before = requests.length;
                const sessionKey = "agent:main:p5-native-command-" + randomUUID();
                await client.request("sessions.create", {
                  key: sessionKey,
                  agentId: "main",
                  model: provider + "/" + MODEL,
                });
                const result = await client.request<{
                  status: string;
                  runId: string;
                }>(
                  "agent",
                  {
                    sessionKey,
                    message: "Reply with the harmless fixture response.",
                    deliver: false,
                    idempotencyKey: randomUUID(),
                  },
                  { expectFinal: true, timeoutMs: 90000 },
                );
                expect(result, instance.logs()).toMatchObject({
                  status: "ok",
                  result: {
                    meta: {
                      agentMeta: {
                        provider,
                        model: MODEL,
                        agentHarnessId: "codex",
                        credentialSource: { kind: "none" },
                      },
                    },
                  },
                });
                await expect(
                  client.request(
                    "agent.wait",
                    { runId: result.runId, timeoutMs: 60000 },
                    { timeoutMs: 65000 },
                  ),
                ).resolves.toMatchObject({
                  status: "ok",
                  terminalReply: { disposition: "visible", text: ANSWER },
                });
                expect(requests.slice(before)).toEqual([
                  {
                    model: MODEL,
                    commandBearer: true,
                    secondaryBearer: combined,
                    nativeHeader: true,
                  },
                ]);
                expect(failures).toEqual([]);
                await expect(fs.stat(path.join(codexHome, "auth.json"))).rejects.toMatchObject({
                  code: "ENOENT",
                });
                console.info(
                  "[native-command-proof] visible terminal and exact native credentials",
                  { combined },
                );
                expect(grants).toEqual(combined ? ["authorization_code", "refresh_token"] : []);
                if (combined) {
                  expect(catalogCredentials).toContainEqual({ primary: true, secondary: true });
                }
              },
              () => client.stopAndWait(),
              () => instance.stopGateway(),
            );
            console.info("[native-command-proof] Gateway client and process cleanup complete");
          },
          () => instance.cleanup(),
          async () => {
            reserved.listener.closeAllConnections();
            await reserved.releaseListener();
            await reserved.claim.release();
          },
        );
      };
      if (combined) {
        await withNativeSecretService(signal, run);
      } else {
        await run({});
      }
    },
  );
}
