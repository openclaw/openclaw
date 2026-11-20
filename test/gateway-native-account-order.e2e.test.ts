import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import { zstdDecompressSync } from "node:zlib";
import { expect, it } from "vitest";
import { disconnectGatewayClient } from "../src/gateway/test-helpers.e2e.js";
import { listKnownProviderAuthEnvVarNamesCore } from "../src/secrets/provider-env-vars.js";
import {
  closeHttpServer,
  connectProofClient,
  listenLoopback,
} from "./helpers/gateway-integration-fixtures.js";
import { createOpenAiResponsesModelConfig } from "./helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";

it(
  "routes native Codex inference by saved account priority without repinning healthy conversations",
  { timeout: 240_000 },
  async ({ onTestFinished, signal }) => {
    const attempts: string[] = [];
    const exhausted = new Set<string>();
    const provider = "openai",
      backup = "backup-proof";
    const nativeAccounts = ["A", "B", "C"];
    const backupAccount = "backup";
    const names = [...nativeAccounts, backupAccount];
    const token = (name: string) =>
      name === backupAccount
        ? "synthetic-backup"
        : [
            { alg: "none", typ: "JWT" },
            {
              "https://api.openai.com/auth": {
                chatgpt_account_id: name,
                chatgpt_plan_type: "plus",
              },
            },
          ]
            .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
            .join(".") + ".fixture";
    const http = createServer(async (req, res) => {
      if (req.url?.endsWith("/accounts/check")) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            accounts: nativeAccounts.map((id) => ({
              id,
              workspace_backend_origin: baseUrl.replace("http:", "https:"),
              account_routing_override: "NO_CONSTRAINT",
            })),
          }),
        );
        return;
      }
      if (req.method === "GET" && req.url?.endsWith("/responses")) {
        res.writeHead(426).end();
        return;
      }
      if (req.method !== "POST" || !req.url?.endsWith("/responses")) {
        res.writeHead(404).end();
        return;
      }
      const bytes = await buffer(req);
      const { model } = JSON.parse(
        (req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes).toString(),
      ) as { model: string };
      const name =
        names.find((n) => req.headers.authorization === "Bearer " + token(n)) ?? "unknown";
      attempts.push(
        model +
          ":" +
          name +
          (name !== backupAccount && req.headers["chatgpt-account-id"] !== name
            ? ":account-mismatch"
            : ""),
      );
      if (exhausted.has(name)) {
        res
          .writeHead(429, {
            "content-type": "application/json",
            "x-codex-primary-used-percent": "100",
            "x-codex-primary-window-minutes": "300",
            "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1000) + 3600),
          })
          .end(
            JSON.stringify({
              error: {
                type: "usage_limit_reached",
                resets_at: Math.floor(Date.now() / 1000) + 3600,
                message: "You exceeded your current quota.",
              },
            }),
          );
      } else {
        writeOpenAiResponsesText(res, {
          text: `ok from ${model}:${name}`,
          messageId: "msg-" + randomUUID(),
          responseId: "resp-" + randomUUID(),
        });
      }
    });
    const baseUrl = await listenLoopback(http);
    onTestFinished(() => closeHttpServer(http));
    const cfg = createOpenAiResponsesModelConfig({
      providerId: backup,
      modelId: "secondary",
      baseUrl,
      reasoning: false,
      toolProfile: "minimal",
    });
    delete cfg.models!.providers![backup]!.apiKey;
    cfg.models!.catalogRefresh = { enabled: false };
    // The host selects the official native route. Only Codex's external upstream is loopback.
    cfg.agents!.defaults!.model = {
      primary: provider + "/gpt-5.5",
      fallbacks: [backup + "/secondary"],
    };

    cfg.agents!.defaults!.models!["openai/gpt-5.5"] = { agentRuntime: { id: "codex" } };
    cfg.plugins = {
      allow: ["openai", "codex"],
      slots: { memory: "none" },
      entries: {
        openai: { enabled: true },
        codex: {
          enabled: true,
          config: {
            appServer: {
              homeScope: "agent",
              args: [
                "app-server",
                "--listen",
                "stdio://",
                "-c",
                "openai_base_url=" + JSON.stringify(baseUrl + "/v1"),
                "-c",
                "chatgpt_base_url=" + JSON.stringify(baseUrl),
              ],
            },
          },
        },
      },
    };
    const instance = await createOpenClawTestInstance({
      name: "native-account-order-proof",
      config: cfg,
      signal,
      env: {
        ...Object.fromEntries(
          listKnownProviderAuthEnvVarNamesCore().map((name) => [name, undefined]),
        ),
        CODEX_HOME: undefined,
        CODEX_SQLITE_HOME: undefined,
        OPENAI_BASE_URL: undefined,
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        ALL_PROXY: "http://127.0.0.1:1",
        NO_PROXY: "localhost,127.0.0.1,::1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_AGENT_RUNTIME: "codex",
        NODE_USE_ENV_PROXY: "1",
        OPENCLAW_ALLOW_SLOW_REPLY_TESTS: "1",
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      },
    });
    try {
      await instance.state.writeAuthProfiles({
        version: 1,
        profiles: Object.fromEntries(
          names.map((n) => {
            const p = n === backupAccount ? backup : provider;
            return [
              p + ":" + n,
              n === backupAccount
                ? { type: "api_key", provider: p, key: token(n) }
                : {
                    type: "oauth",
                    provider: p,
                    access: token(n),
                    refresh: "synthetic-refresh-" + n,
                    accountId: n,
                    expires: Date.now() + 3600_000,
                  },
            ];
          }),
        ),
      });
      await instance.startGateway();
      const client = await connectProofClient(instance, {
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      try {
        const order = async (...ns: string[]) => {
          const profileIds = ns.map((n) => provider + ":" + n);
          expect(
            await client.request("models.authOrderSet", { agentId: "main", provider, profileIds }),
          ).toMatchObject({ profileIds });
        };
        const expectTurn = async (session: string, ...expectedAttempts: string[]) => {
          const sessionKey = "agent:main:" + session;
          const offset = attempts.length;
          const { runId } = await client.request<{ runId: string }>("chat.send", {
            sessionKey,
            message: "reply ok",
            idempotencyKey: randomUUID(),
          });
          const result = await client.request(
            "agent.wait",
            { runId, timeoutMs: 60_000 },
            { timeoutMs: 65_000 },
          );

          expect(result).toMatchObject({ status: "ok" });
          expect(attempts.slice(offset)).toEqual(expectedAttempts);
          const history = await client.request<{ messages: unknown[] }>("chat.history", {
            sessionKey,
            limit: 1,
          });
          expect(history.messages.at(-1)).toMatchObject({
            role: "assistant",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "text", text: `ok from ${expectedAttempts.at(-1)}` }),
            ]),
          });
        };
        await order("A", "B", "C");
        await expectTurn("existing", "gpt-5.5:A");
        await order("B", "A", "C");
        await expectTurn("fresh", "gpt-5.5:B");
        await expectTurn("existing", "gpt-5.5:A");
        await client.request("sessions.patch", {
          key: "agent:main:fresh",
          model: provider + "/gpt-5.5@" + provider + ":A",
        });
        await expectTurn("fresh", "gpt-5.5:A");
        exhausted.add("B");
        exhausted.add("A");
        await expectTurn("quota", "gpt-5.5:B", "gpt-5.5:A", "gpt-5.5:C");
        await expectTurn("cooldown", "gpt-5.5:C");
        exhausted.add("C");
        await expectTurn("fallback", "gpt-5.5:C", "secondary:backup");
      } finally {
        await disconnectGatewayClient(client);
      }
    } finally {
      await instance.cleanup();
    }
  },
);
