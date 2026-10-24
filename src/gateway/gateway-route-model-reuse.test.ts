import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { isGatewayProtocolResponseError } from "../../packages/gateway-client/src/protocol-request.js";
import {
  createFixtureRequest,
  verifyBuiltGatewayHead,
} from "../../test/helpers/gateway-built-fixture.js";
import { acquireGatewayTestClient } from "../../test/helpers/gateway-client.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../test/helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const PROVIDERS = ["route-proof-stable", "route-proof-dynamic"] as const;
const PLUGIN_ID = "route-model-proof";
const capacityModelId = (index: number) => `capacity-${index}`;
type Counts = Record<string, { resolve: number; prepare: number }>;
const byProvider = <T>(value: (provider: string) => T, suffix = "") =>
  Object.fromEntries(PROVIDERS.map((provider) => [`${provider}${suffix}`, value(provider)]));

// This fixture records calls through the public provider and Gateway APIs. Its
// model output remains deterministic; observation never changes routing policy.
async function writeProviderProbe(pluginDir: string, signal: AbortSignal) {
  signal.throwIfAborted();
  await fs.mkdir(pluginDir, { recursive: true });
  signal.throwIfAborted();
  const write = async (name: string, content: unknown) => {
    signal.throwIfAborted();
    await fs.writeFile(
      path.join(pluginDir, name),
      typeof content === "string" ? content : JSON.stringify(content),
    );
    signal.throwIfAborted();
  };
  await write("package.json", {
    name: PLUGIN_ID,
    type: "commonjs",
    main: "index.js",
    openclaw: { extensions: ["./index.js"] },
    peerDependencies: { openclaw: ">=2026.1.1" },
  });
  await write("openclaw.plugin.json", {
    id: PLUGIN_ID,
    providers: PROVIDERS,
    activation: { onStartup: true },
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  });
  await write(
    "index.js",
    `
const counts = globalThis[Symbol.for("openclaw.test.routeModelCounts")] ??= {};
function resolve(ctx, phase) {
  const key = ctx.provider + "/" + ctx.modelId;
  const count = counts[key] ??= { resolve: 0, prepare: 0 };
  count[phase] += 1;
  const configured = ctx.providerConfig.models.find(model => model.id === ctx.modelId);
  return { ...configured, provider: ctx.provider, baseUrl: ctx.providerConfig.baseUrl,
    headers: { "x-proof-config-max-tokens": String(configured.maxTokens) } };
}
module.exports = {
  id: "${PLUGIN_ID}",
  register(api) {
    for (const provider of ${JSON.stringify(PROVIDERS)}) {
      api.registerProvider({ id: provider, label: provider, auth: [],
        preferRuntimeResolvedModel: () => true,
        resolveDynamicModel: ctx => resolve(ctx, "resolve"),
        ...(provider.endsWith("-dynamic") ? {
          prepareDynamicModel: async ctx => resolve(ctx, "prepare"),
        } : {}),
      });
    }
    api.registerGatewayMethod("routeModelProof.stats", ({ context, respond }) => {
      respond(true, { counts, reloadSettled: context.isConfigReloadSettled() });
    }, { scope: "operator.read" });
  },
};
`,
  );
}

it(
  "bounds stable resolution reuse and refreshes generation facts without suppressing dynamic preparation",
  { timeout: 180_000 },
  async (context) => {
    const repoRoot = process.cwd();
    const requests: Array<{ model: string; maxTokens: string | undefined }> = [];
    let unexpectedCredential = false;
    const handlers = new Set<Promise<void>>();
    const handlerFailures: unknown[] = [];
    const server = createServer((request, response) => {
      const handling = (async () => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          request.resume();
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ data: [] }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string };
        unexpectedCredential ||= request.headers.authorization !== "Bearer qa-route-model-key";
        requests.push({
          model: parsed.model,
          maxTokens: request.headers["x-proof-config-max-tokens"] as string | undefined,
        });
        writeOpenAiResponsesText(response, {
          text: "ROUTE_MODEL_OK",
          messageId: `msg_${requests.length}`,
          responseId: `resp_${requests.length}`,
        });
      })().catch((error: unknown) => {
        if (!response.destroyed) {
          response.writeHead(500).end(String(error));
        }
      });
      handlers.add(handling);
      void handling.then(
        () => handlers.delete(handling),
        (error: unknown) => {
          handlers.delete(handling);
          handlerFailures.push(error);
        },
      );
    });
    let instance: OpenClawTestInstance | undefined;
    let client: Awaited<ReturnType<typeof acquireGatewayTestClient>> | undefined;
    let providerListening = false;
    const proof = await runQaGatewayTestFixture(
      context,
      async ({ signal, verifyCleanup }) => {
        const head = await verifyBuiltGatewayHead(repoRoot, signal);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            providerListening = true;
            resolve();
          });
        });
        signal.throwIfAborted();
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Synthetic provider has no port");
        }
        instance = await createOpenClawTestInstance({
          name: "route-model-reuse",
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
        const pluginDir = path.join(gateway.state.stateDir, "proof-provider");
        await writeProviderProbe(pluginDir, signal);
        signal.throwIfAborted();
        const capacityModels = Array.from({ length: 65 }, (_, index) => capacityModelId(index));
        const modelIds = ["warmup", "stable", "dynamic", ...capacityModels];
        const definitions = modelIds.map((id) => ({
          id,
          name: id,
          api: "openai-responses" as const,
          reasoning: false,
          input: ["text" as const],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 1024,
        }));
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
              model: { primary: `${PROVIDERS[0]}/stable`, fallbacks: [] },
              models: Object.fromEntries(
                PROVIDERS.flatMap((provider) =>
                  modelIds.map((id) => [
                    `${provider}/${id}`,
                    {
                      agentRuntime: { id: "openclaw" },
                      params: { transport: "sse", openaiWsWarmup: false },
                    },
                  ]),
                ),
              ),
            },
            entries: { main: {} },
          },
          auth: {
            profiles: byProvider((provider) => ({ provider, mode: "api_key" as const }), ":proof"),
          },
          models: {
            mode: "replace",
            providers: byProvider(() => ({
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              api: "openai-responses" as const,
              models: definitions,
              request: { allowPrivateNetwork: true },
            })),
          },
          plugins: {
            allow: [PLUGIN_ID],
            load: { paths: [pluginDir] },
            entries: { [PLUGIN_ID]: { enabled: true } },
            slots: { memory: "none" },
          },
          tools: { profile: "minimal" },
        } satisfies OpenClawConfig;
        await gateway.state.writeConfig(cfg);
        signal.throwIfAborted();
        await gateway.state.writeAuthProfiles(
          {
            version: 1,
            profiles: byProvider(
              (provider) => ({ type: "api_key" as const, provider, key: "qa-route-model-key" }),
              ":proof",
            ),
          },
          "main",
        );
        signal.throwIfAborted();
        expect(await gateway.entrypoint()).toEqual(["dist/index.js"]);
        signal.throwIfAborted();
        await gateway.startGateway();
        signal.throwIfAborted();
        const gatewayPid = gateway.child?.pid;
        expect(gatewayPid).toBeTypeOf("number");
        client = await acquireGatewayTestClient(
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
            timeoutMessage: "Route-model Gateway did not connect",
            closeMessage: "Route-model Gateway closed",
            signal,
            verifyCleanup,
          },
        );
        signal.throwIfAborted();
        const request = createFixtureRequest(client, signal);
        // Measure reuse after startup publication has settled its runtime facts.
        const refreshCatalog = () =>
          request("models.list", { agentId: "main", view: "all", refresh: true });
        // A startup publication can supersede this refresh; follow the documented
        // one-retry contract for retryable catalog supersession, as the Control UI does.
        await refreshCatalog().catch((error: unknown) => {
          if (
            !isGatewayProtocolResponseError(error) ||
            error.gatewayCode !== "UNAVAILABLE" ||
            !error.retryable
          ) {
            throw error;
          }
          signal.throwIfAborted();
          return refreshCatalog();
        });
        signal.throwIfAborted();
        await expect
          .poll(
            async ({ signal: pollSignal }) => {
              const catalog = await request<{
                models: Array<{ id: string; provider: string }>;
                pendingProviders?: string[];
                refreshFailed?: boolean;
              }>(
                "models.list",
                { agentId: "main", view: "all" },
                { signal: AbortSignal.any([signal, pollSignal]) },
              );
              expect(catalog.refreshFailed).not.toBe(true);
              expect(catalog.models).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ provider: PROVIDERS[0], id: "stable" }),
                  expect.objectContaining({ provider: PROVIDERS[1], id: "stable" }),
                ]),
              );
              return catalog.pendingProviders;
            },
            { timeout: 30_000 },
          )
          .toBeUndefined();
        const stats = () =>
          request<{ counts: Counts; reloadSettled: boolean }>("routeModelProof.stats");
        const turn = async (provider: string, model: string) => {
          const key = `${provider}/${model}`;
          const before = (await stats()).counts[key] ?? { resolve: 0, prepare: 0 };
          const modelRequests = () => requests.filter((record) => record.model === model);
          const beforeRequests = modelRequests().length;
          const sessionKey = `agent:main:route-model-${randomUUID()}`;
          const accepted = await request<{ runId: string; status: string }>("agent", {
            agentId: "main",
            sessionKey,
            provider,
            model,
            message: "Reply ROUTE_MODEL_OK.",
            deliver: false,
            idempotencyKey: randomUUID(),
          });
          expect(accepted.status).toBe("accepted");
          const terminal = await request<{ status: string }>(
            "agent.wait",
            { runId: accepted.runId, timeoutMs: 60_000 },
            { timeoutMs: 65_000 },
          );
          expect(terminal.status, gateway.logs()).toBe("ok");
          expect(modelRequests()).toHaveLength(beforeRequests + 1);
          expect(modelRequests().at(-1)?.model).toBe(model);
          expect(unexpectedCredential).toBe(false);
          const history = await request<{ messages: unknown[] }>("chat.history", { sessionKey });
          expect(history.messages).toContainEqual(
            expect.objectContaining({
              role: "assistant",
              content: expect.arrayContaining([
                expect.objectContaining({ type: "text", text: "ROUTE_MODEL_OK" }),
              ]),
            }),
          );
          const after = (await stats()).counts[key];
          assert(after, `Provider observations missing for ${key}`);
          return {
            resolve: after.resolve - before.resolve,
            prepare: after.prepare - before.prepare,
          };
        };
        await turn(PROVIDERS[0], "warmup");
        const stable = [
          await turn(PROVIDERS[0], "stable"),
          await turn(PROVIDERS[0], "stable"),
        ] as const;
        await turn(PROVIDERS[1], "warmup");
        const dynamic = [
          await turn(PROVIDERS[1], "dynamic"),
          await turn(PROVIDERS[1], "dynamic"),
        ] as const;
        // Keep eviction boundaries ordered; only independent middle keys share the Gateway.
        await turn(PROVIDERS[0], capacityModelId(0));
        for (let index = 1; index < 63; index += 4) {
          const batch = await Promise.allSettled(
            capacityModels
              .slice(index, Math.min(index + 4, 63))
              .map((model) => turn(PROVIDERS[0], model)),
          );
          const failures = batch.filter((result) => result.status === "rejected");
          if (failures.length > 0) {
            throw new AggregateError(
              failures.map((failure) => failure.reason),
              "Route-model capacity turns failed",
            );
          }
        }
        await turn(PROVIDERS[0], capacityModelId(63));
        await turn(PROVIDERS[0], capacityModelId(0));
        await turn(PROVIDERS[0], capacityModelId(63));
        await turn(PROVIDERS[0], capacityModelId(64));
        await turn(PROVIDERS[0], capacityModelId(0));
        await turn(PROVIDERS[0], capacityModelId(64));
        expect(requests.at(-1)?.maxTokens).toBe("1024");
        const currentConfig = await request<{ hash: string }>("config.get");
        expect(currentConfig.hash).toBeTypeOf("string");
        const updatedDefinitions = structuredClone(definitions);
        for (const model of updatedDefinitions) {
          model.maxTokens = 2048;
        }
        // config.patch acknowledges a hot write only after runtime application.
        await request(
          "config.patch",
          {
            baseHash: currentConfig.hash,
            raw: JSON.stringify({
              models: { providers: { [PROVIDERS[0]]: { models: updatedDefinitions } } },
            }),
          },
          { timeoutMs: 60_000 },
        );
        await expect
          .poll(
            async ({ signal: pollSignal }) => {
              const value = await request<{ reloadSettled: boolean }>(
                "routeModelProof.stats",
                {},
                { signal: AbortSignal.any([signal, pollSignal]) },
              );
              return value.reloadSettled;
            },
            { timeout: 30_000 },
          )
          .toBe(true);
        const afterReload = await turn(PROVIDERS[0], capacityModelId(64));
        expect(requests.at(-1)?.maxTokens).toBe("2048");
        expect(gateway.child?.pid).toBe(gatewayPid);
        expect(dynamic[0].prepare).toBeGreaterThan(0);
        expect(dynamic[1].prepare).toBe(dynamic[0].prepare);
        expect(stable[0].resolve).toBeGreaterThan(0);
        expect(stable[1].resolve).toBeLessThan(stable[0].resolve);
        expect(requests).toHaveLength(76);
        return {
          head,
          gatewayPid,
          stable,
          dynamic,
          afterReload,
          requests: requests.length,
          responseTextVerified: true,
          generationHeader: "1024→2048",
          sameGatewayProcess: true,
        };
      },
      async () => {
        await client?.stopAndWait({ timeoutMs: 1_000 });
      },
      async () => {
        await instance?.cleanup();
      },
      async () => {
        if (!providerListening) {
          return;
        }
        const closed = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        server.closeAllConnections();
        await runQaGatewayFixture(
          () => closed,
          async () => {
            while (handlers.size > 0) {
              await Promise.allSettled(handlers);
            }
            if (handlerFailures.length > 0) {
              throw new AggregateError(handlerFailures, "Route provider handler cleanup failed");
            }
          },
        );
        providerListening = false;
      },
    );
    context.signal.throwIfAborted();
    console.info("[route-model-runtime-proof]", JSON.stringify(proof));
  },
);
