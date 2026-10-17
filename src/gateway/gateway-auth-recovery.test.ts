import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { describe, expect, it, onTestFailed } from "vitest";
import type { ModelChoice } from "../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { readProcessRssMb } from "../../scripts/lib/gateway-bench-probes.ts";
import {
  BUILD_STAMP_FILE,
  resolveGitHead,
  RUNTIME_POSTBUILD_STAMP_FILE,
} from "../../scripts/lib/local-build-metadata.mts";
import { acquireGatewayTestClient } from "../../test/helpers/gateway-client.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

async function startProvider(server: ReturnType<typeof createServer>, signal: AbortSignal) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  signal.throwIfAborted();
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Mock provider did not expose its listening port");
  }
  return `http://127.0.0.1:${address.port}/v1`;
}

function connectGateway(
  gateway: OpenClawTestInstance,
  signal: AbortSignal,
  verifyCleanup: NonNullable<Parameters<typeof acquireGatewayTestClient>[1]["verifyCleanup"]>,
) {
  return acquireGatewayTestClient(
    {
      url: gateway.url,
      token: gateway.gatewayToken,
      clientName: "cli",
      mode: "cli",
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    },
    {
      timeoutMs: 30_000,
      timeoutMessage: "Gateway client did not connect",
      closeMessage: "Gateway closed",
      signal,
      verifyCleanup,
    },
  );
}

async function closeProvider(server: ReturnType<typeof createServer>) {
  if (!server.listening) {
    return;
  }
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  await closed;
}

async function verifyBuiltGatewayHead(repoRoot: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const head = resolveGitHead({ cwd: repoRoot });
  expect(head).toMatch(/^[0-9a-f]{40}$/u);
  await fs.access(path.join(repoRoot, "dist/index.js"));
  signal.throwIfAborted();
  for (const [file, field] of [
    [BUILD_STAMP_FILE, "head"],
    [RUNTIME_POSTBUILD_STAMP_FILE, "head"],
    ["build-info.json", "commit"],
  ] as const) {
    const metadata = JSON.parse(await fs.readFile(path.join(repoRoot, "dist", file), "utf8"));
    signal.throwIfAborted();
    expect(metadata[field], file).toBe(head);
  }
}

// Exercise HTTP failures, persisted credential replacement, and recovery in one built Gateway.
describe("Gateway profile failure recovery", () => {
  it(
    "records rate limits and retains authentication recovery through the built Gateway",
    {
      timeout: 180_000,
    },
    async (context) => {
      const repoRoot = process.cwd();

      const credentials = {
        rate: "qa-rate-profile-key",
        auth: "qa-auth-profile-key",
        recovered: "qa-recovered-profile-key",
      };
      // The shared auth credential must not become a fallback for the rate-limit proof.
      const rateProviderId = "mock-openai-rate";
      const profileIds = { rate: `${rateProviderId}:rate`, auth: "mock-openai:manual" };
      const requests = { rate: 0, auth: 0, recovered: 0 };
      let phase: keyof typeof requests = "rate";
      let unexpectedCredential = false;
      const providerServer = createServer((request, response) => {
        request.resume();
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: [] }));
          return;
        }
        requests[phase] += 1;
        const credentialMatches = request.headers.authorization === `Bearer ${credentials[phase]}`;
        unexpectedCredential ||= !credentialMatches;
        if (phase === "recovered" && credentialMatches) {
          writeOpenAiResponsesText(response, {
            text: "AUTH_RECOVERY_OK",
            messageId: "msg_auth_recovery",
            responseId: "resp_auth_recovery",
          });
          return;
        }
        response.writeHead(phase === "rate" ? 429 : 401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message:
                phase === "rate" ? "Synthetic rate limit" : "Synthetic authentication failure",
              type: phase === "rate" ? "rate_limit_error" : "authentication_error",
            },
          }),
        );
      });
      let instance: OpenClawTestInstance | undefined;
      let client: Awaited<ReturnType<typeof acquireGatewayTestClient>> | undefined;
      onTestFailed(() => console.error({ phase, requests }, instance?.logs()));

      await runQaGatewayTestFixture(
        context,
        async ({ signal, verifyCleanup }) => {
          await verifyBuiltGatewayHead(repoRoot, signal);
          signal.throwIfAborted();
          const provider = buildMockOpenAiResponsesProvider(
            await startProvider(providerServer, signal),
            "gpt-5.6-luna",
          );
          const rateModelRef = `${rateProviderId}/${provider.modelId}`;
          instance = await createOpenClawTestInstance({
            name: "auth-recovery",
            cwd: repoRoot,
            signal,
            verifyCleanup,
            stopTimeoutMs: 10_000,
            env: {
              VITEST: undefined,
              NODE_ENV: "production",
              OPENCLAW_TEST_CONSOLE: "1",
              OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
              OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
            },
          });
          signal.throwIfAborted();
          const gateway = instance;
          const cfg = {
            gateway: {
              port: gateway.port,
              auth: { mode: "token", token: gateway.gatewayToken },
              controlUi: { enabled: false },
            },
            hooks: { enabled: false },
            agents: {
              ownership: "explicit",
              defaults: {
                workspace: gateway.state.workspaceDir,
                skipBootstrap: true,
                heartbeat: { every: "0m" },
                model: { primary: provider.modelRef, fallbacks: [] },
                models: {
                  [rateModelRef]: {
                    agentRuntime: { id: "openclaw" },
                    params: { transport: "sse", openaiWsWarmup: false },
                  },
                  [provider.modelRef]: {
                    agentRuntime: { id: "openclaw" },
                    params: { transport: "sse", openaiWsWarmup: false },
                  },
                },
              },
              entries: {
                rate: {
                  model: { primary: `${rateModelRef}@${profileIds.rate}`, fallbacks: [] },
                },
                auth: {
                  model: { primary: `${provider.modelRef}@${profileIds.auth}`, fallbacks: [] },
                },
              },
            },
            auth: {
              profiles: {
                [profileIds.rate]: { provider: rateProviderId, mode: "api_key" },
                [profileIds.auth]: { provider: provider.providerId, mode: "api_key" },
              },
            },
            models: {
              mode: "replace",
              providers: {
                [rateProviderId]: {
                  ...provider.config,
                  apiKey: undefined,
                  request: { allowPrivateNetwork: true },
                },
                [provider.providerId]: {
                  ...provider.config,
                  apiKey: undefined,
                  request: { allowPrivateNetwork: true },
                },
              },
            },
            plugins: { slots: { memory: "none" } },
            tools: { profile: "minimal" },
          } satisfies OpenClawConfig;
          await gateway.state.writeConfig(cfg);
          signal.throwIfAborted();
          // Exercise retry exhaustion without waiting through the default recovery window.
          await gateway.state.writeJson("agents/rate/agent/settings.json", {
            retry: { provider: { maxRetries: 1 } },
          });
          signal.throwIfAborted();
          for (const agentId of ["rate", "auth"] as const) {
            await gateway.state.writeAuthProfiles(
              {
                version: 1,
                profiles: {
                  [profileIds[agentId]]: {
                    type: "api_key",
                    provider: agentId === "rate" ? rateProviderId : provider.providerId,
                    key: credentials[agentId],
                  },
                },
              },
              // Models saves connection credentials in the shared owner; rate health stays agent-local.
              agentId === "auth" ? "main" : agentId,
            );
            signal.throwIfAborted();
          }
          expect(await gateway.entrypoint()).toEqual(["dist/index.js"]);
          signal.throwIfAborted();
          await gateway.startGateway();
          signal.throwIfAborted();
          const gatewayPid = gateway.child?.pid;
          expect(gatewayPid).toBeTypeOf("number");
          client = await connectGateway(gateway, signal, verifyCleanup);
          signal.throwIfAborted();
          const activeClient = client;
          const runTurn = async (agentId: keyof typeof profileIds, message: string) => {
            signal.throwIfAborted();
            const sessionKey = `agent:${agentId}:auth-recovery-${randomUUID()}`;
            const accepted = await activeClient.request<{ runId: string; status: string }>(
              "agent",
              {
                agentId,
                sessionKey,
                message,
                deliver: false,
                idempotencyKey: randomUUID(),
              },
              { signal },
            );
            signal.throwIfAborted();
            expect(accepted.status).toBe("accepted");
            const terminal = await activeClient.request<{ status: string }>(
              "agent.wait",
              {
                runId: accepted.runId,
                timeoutMs: 60_000,
              },
              { timeoutMs: 65_000, signal },
            );
            signal.throwIfAborted();
            return { sessionKey, terminal };
          };
          const failTurn = async (agentId: keyof typeof profileIds) => {
            const { terminal } = await runTurn(agentId, `AUTH_FAILURE_${agentId.toUpperCase()}`);
            signal.throwIfAborted();
            expect(terminal.status).toBe("error");
            expect(requests[agentId]).toBeGreaterThan(0);
            expect(unexpectedCredential).toBe(false);
            return loadPersistedAuthProfileStore(
              gateway.state.agentDir(agentId === "auth" ? "main" : agentId),
            )?.usageStats?.[profileIds[agentId]];
          };
          const rateStats = await failTurn("rate");
          signal.throwIfAborted();
          expect(rateStats?.cooldownReason).toBe("rate_limit");
          expect(requests.rate).toBe(2);

          phase = "auth";
          const authStats = await failTurn("auth");
          signal.throwIfAborted();
          expect(["auth", "auth_permanent"]).toContain(
            authStats?.cooldownReason ?? authStats?.disabledReason,
          );
          const saved = await activeClient.request<{
            provider: string;
            profileId: string;
            warning?: string;
          }>(
            "models.authSetApiKey",
            { agentId: "auth", provider: provider.providerId, apiKey: credentials.recovered },
            { timeoutMs: 30_000, signal },
          );
          signal.throwIfAborted();
          expect(saved).toEqual({ provider: provider.providerId, profileId: profileIds.auth });
          const refreshed = await activeClient.request<{ refreshed: boolean }>(
            "models.authRefresh",
            { agentId: "auth", operation: "login" },
            { timeoutMs: 30_000, signal },
          );
          signal.throwIfAborted();
          expect(refreshed.refreshed).toBe(true);
          const catalog = await activeClient.request<{ models: ModelChoice[] }>(
            "models.list",
            { agentId: "auth", view: "configured" },
            { signal },
          );
          signal.throwIfAborted();
          expect(
            catalog.models.find(
              (model) => model.provider === provider.providerId && model.id === provider.modelId,
            ),
          ).toMatchObject({ available: true });

          phase = "recovered";
          const { sessionKey, terminal } = await runTurn("auth", "Reply AUTH_RECOVERY_OK.");
          signal.throwIfAborted();
          expect(terminal.status, gateway.logs()).toBe("ok");
          expect(requests.recovered).toBe(1);
          expect(unexpectedCredential).toBe(false);
          const history = await activeClient.request<{ messages: unknown[] }>(
            "chat.history",
            { sessionKey },
            { signal },
          );
          signal.throwIfAborted();
          expect(history.messages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                role: "assistant",
                content: expect.arrayContaining([
                  expect.objectContaining({ type: "text", text: "AUTH_RECOVERY_OK" }),
                ]),
              }),
            ]),
          );
          expect(gateway.child?.pid).toBe(gatewayPid);
          expect(
            loadPersistedAuthProfileStore(gateway.state.agentDir("rate"))?.usageStats?.[
              profileIds.rate
            ],
          ).toEqual(rateStats);
        },
        async () => {
          await client?.stopAndWait({ timeoutMs: 1_000 });
        },
        async () => {
          await instance?.cleanup();
        },
        () => closeProvider(providerServer),
      );
    },
  );
});

describe("Gateway configured catalog authentication", () => {
  it(
    "serves a large authenticated catalog for each agent through the built Gateway",
    { timeout: 180_000 },
    async (context) => {
      const repoRoot = process.cwd();
      const agentIds = Array.from({ length: 11 }, (_, index) =>
        index === 0 ? "main" : `catalog-${index}`,
      );
      const credential = "qa-configured-catalog-key";
      const providerServer = createServer((request, response) => {
        request.resume();
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [] }));
      });
      let instance: OpenClawTestInstance | undefined;
      let client: Awaited<ReturnType<typeof acquireGatewayTestClient>> | undefined;
      await runQaGatewayTestFixture(
        context,
        async ({ signal, verifyCleanup }) => {
          await verifyBuiltGatewayHead(repoRoot, signal);
          signal.throwIfAborted();
          const provider = buildMockOpenAiResponsesProvider(
            await startProvider(providerServer, signal),
            "synthetic-0",
          );
          const models = Array.from({ length: 400 }, (_, index) => ({
            ...provider.config.models[0],
            id: `synthetic-${index}`,
            name: `Synthetic ${index}`,
          }));
          instance = await createOpenClawTestInstance({
            name: "configured-catalog-auth",
            cwd: repoRoot,
            signal,
            verifyCleanup,
            stopTimeoutMs: 10_000,
            env: {
              VITEST: undefined,
              NODE_ENV: "production",
              OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
              OPENCLAW_TEST_CONSOLE: "1",
              OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
              OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
            },
          });
          signal.throwIfAborted();
          const gateway = instance;
          const cfg = {
            gateway: {
              port: gateway.port,
              auth: { mode: "token", token: gateway.gatewayToken },
              controlUi: { enabled: false },
            },
            hooks: { enabled: false },
            agents: {
              ownership: "explicit",
              defaults: {
                workspace: gateway.state.workspaceDir,
                skipBootstrap: true,
                heartbeat: { every: "0m" },
                model: { primary: provider.modelRef, fallbacks: [] },
                models: Object.fromEntries(
                  models.map((model) => [
                    `${provider.providerId}/${model.id}`,
                    { agentRuntime: { id: "openclaw" } },
                  ]),
                ),
              },
              entries: Object.fromEntries(agentIds.map((agentId) => [agentId, {}])),
            },
            models: {
              mode: "replace",
              providers: {
                [provider.providerId]: {
                  ...provider.config,
                  apiKey: credential,
                  models,
                  request: { allowPrivateNetwork: true },
                },
              },
            },
            plugins: { slots: { memory: "none" } },
            tools: { profile: "minimal" },
          } satisfies OpenClawConfig;
          await gateway.state.writeConfig(cfg);
          signal.throwIfAborted();
          expect(await gateway.entrypoint()).toEqual(["dist/index.js"]);
          signal.throwIfAborted();
          await gateway.startGateway();
          signal.throwIfAborted();
          client = await connectGateway(gateway, signal, verifyCleanup);
          signal.throwIfAborted();
          const expectedIds = new Set(models.map((model) => model.id));
          let returnedRows = 0;
          for (const agentId of agentIds) {
            signal.throwIfAborted();
            const result = await client.request<{ models: ModelChoice[] }>(
              "models.list",
              { agentId, view: "configured" },
              { timeoutMs: 30_000, signal },
            );
            signal.throwIfAborted();
            const configured = result.models.filter(
              (model) => model.provider === provider.providerId,
            );
            expect(configured, agentId).toHaveLength(models.length);
            expect(new Set(configured.map((model) => model.id)), agentId).toEqual(expectedIds);
            expect(
              configured.every((model) => model.available === true),
              agentId,
            ).toBe(true);
            returnedRows += configured.length;
          }
          const gatewayRssMb = readProcessRssMb(gateway.child?.pid);
          expect(gatewayRssMb).toBeGreaterThan(0);
          expect(returnedRows).toBe(4_400);
        },
        async () => {
          await client?.stopAndWait({ timeoutMs: 1_000 });
        },
        async () => {
          await instance?.cleanup();
        },
        () => closeProvider(providerServer),
      );
    },
  );
});
