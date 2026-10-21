import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, onTestFailed, type TestContext } from "vitest";
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
import { createTrackedProvider } from "./test-helpers.tracked-provider.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

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

function gatewayConfig(gateway: OpenClawTestInstance, modelRef: string) {
  return {
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
        model: { primary: modelRef, fallbacks: [] },
      },
    },
    plugins: { slots: { memory: "none" } },
    tools: { profile: "minimal" },
  } satisfies OpenClawConfig;
}

async function withBuiltGateway(
  context: TestContext,
  name: string,
  providerServer: ReturnType<typeof createTrackedProvider>,
  body: (
    gateway: OpenClawTestInstance,
    signal: AbortSignal,
    connect: () => ReturnType<typeof acquireGatewayTestClient>,
  ) => Promise<void>,
) {
  let gateway: OpenClawTestInstance | undefined;
  let client: Awaited<ReturnType<typeof acquireGatewayTestClient>> | undefined;
  await runQaGatewayTestFixture(
    context,
    async ({ signal, verifyCleanup }) => {
      await verifyBuiltGatewayHead(process.cwd(), signal);
      signal.throwIfAborted();
      gateway = await createOpenClawTestInstance({
        name,
        cwd: process.cwd(),
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
          ...(name === "configured-catalog-auth" ? { OPENCLAW_GATEWAY_STARTUP_TRACE: "1" } : {}),
        },
      });
      signal.throwIfAborted();
      const instance = gateway;
      await body(instance, signal, async () => {
        expect(await instance.entrypoint()).toEqual(["dist/index.js"]);
        signal.throwIfAborted();
        await instance.startGateway();
        signal.throwIfAborted();
        client = await acquireGatewayTestClient(
          {
            url: instance.url,
            token: instance.gatewayToken,
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
        signal.throwIfAborted();
        return client;
      });
    },
    async () => {
      await client?.stopAndWait({ timeoutMs: 1_000 });
    },
    async () => {
      await gateway?.cleanup();
    },
    () => providerServer.close(),
  );
}

it(
  "records rate limits and retains authentication recovery through the built Gateway",
  {
    timeout: 180_000,
  },
  async (context) => {
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
    const providerServer = createTrackedProvider((_raw, response, request) => {
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
            message: phase === "rate" ? "Synthetic rate limit" : "Synthetic authentication failure",
            type: phase === "rate" ? "rate_limit_error" : "authentication_error",
          },
        }),
      );
    });
    await withBuiltGateway(
      context,
      "auth-recovery",
      providerServer,
      async (gateway, signal, connect) => {
        onTestFailed(() => console.error({ phase, requests }, gateway.logs()));
        const provider = buildMockOpenAiResponsesProvider(
          await providerServer.listen(),
          "gpt-5.6-luna",
        );
        signal.throwIfAborted();
        const rateModelRef = `${rateProviderId}/${provider.modelId}`;
        const base = gatewayConfig(gateway, provider.modelRef);
        const configuredModel = {
          agentRuntime: { id: "openclaw" },
          params: { transport: "sse", openaiWsWarmup: false },
        } as const;
        const providerConfig = {
          ...provider.config,
          apiKey: undefined,
          request: { allowPrivateNetwork: true },
        };
        const cfg = {
          ...base,
          agents: {
            ...base.agents,
            defaults: {
              ...base.agents.defaults,
              models: { [rateModelRef]: configuredModel, [provider.modelRef]: configuredModel },
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
              [rateProviderId]: providerConfig,
              [provider.providerId]: providerConfig,
            },
          },
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
        const activeClient = await connect();
        const gatewayPid = gateway.child?.pid;
        expect(gatewayPid).toBeTypeOf("number");
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
    );
  },
);

it(
  "serves a large authenticated catalog for each agent through the built Gateway",
  { timeout: 180_000 },
  async (context) => {
    const agentIds = Array.from({ length: 11 }, (_, index) =>
      index === 0 ? "main" : `catalog-${index}`,
    );
    const credential = "qa-configured-catalog-key";
    const providerServer = createTrackedProvider((_raw, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [] }));
    });
    await withBuiltGateway(
      context,
      "configured-catalog-auth",
      providerServer,
      async (gateway, signal, connect) => {
        const provider = buildMockOpenAiResponsesProvider(
          await providerServer.listen(),
          "synthetic-0",
        );
        signal.throwIfAborted();
        const models = Array.from({ length: 400 }, (_, index) => ({
          ...provider.config.models[0],
          id: `synthetic-${index}`,
          name: `Synthetic ${index}`,
        }));
        const base = gatewayConfig(gateway, provider.modelRef);
        const cfg = {
          ...base,
          agents: {
            ...base.agents,
            defaults: {
              ...base.agents.defaults,
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
        } satisfies OpenClawConfig;
        await gateway.state.writeConfig(cfg);
        signal.throwIfAborted();
        const client = await connect();
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
    );
  },
);
