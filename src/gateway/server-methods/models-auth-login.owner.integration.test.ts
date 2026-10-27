import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import type { WizardNextResult } from "../../../packages/gateway-protocol/src/schema/wizard.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { loadPersistedAuthProfileStore } from "../../agents/auth-profiles/persisted.js";
import { readGatewayLoginParams } from "../../commands/models/auth-login-gateway.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { captureGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import * as providerPersistence from "../../plugins/provider-auth-persistence.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { disconnectGatewayClient } from "../test-helpers.e2e.js";
import type { GatewayClient as ServerGatewayClient } from "./client-types.js";
import { modelsAuthLoginHandlers } from "./models-auth-login.js";
import { writeCatalogPlugin } from "./models-catalog-fixture.test-support.js";
import {
  connectModelsReader,
  createModelsTestState,
  modelsTestConfig,
  serveModelsEndpoint,
  settleModelsWork,
  startModelsGateway,
} from "./models-integration.test-support.js";

const provider = "owner-login-fixture";
const profileId = `${provider}:owner`;
const token = "owner-login-synthetic-gateway-token";

async function withGatewayOwner<T>(state: OpenClawTestState, operation: () => Promise<T>) {
  const lock = await acquireGatewayLock({ env: state.env, allowInTests: true, role: "gateway" });
  if (!lock) {
    throw new Error("Could not acquire real Gateway ownership");
  }
  try {
    return await lock.run(operation);
  } finally {
    await lock.release();
  }
}

const createState = () =>
  createModelsTestState("owner-bound-login", {
    layout: "state-only",
    env: { OPENCLAW_TEST_MINIMAL_GATEWAY: "0" },
  });

async function finishLogin(client: Awaited<ReturnType<typeof startModelsGateway>>["client"]) {
  let result: WizardNextResult = { done: false };
  while (!result.done) {
    const step = result.step;
    result = await client.request<WizardNextResult>("wizard.next", {
      sessionId: "owner-login",
      ...(step && step.executor !== "gateway" && step.type !== "progress"
        ? { answer: { stepId: step.id, value: step.type === "confirm" ? true : null } }
        : {}),
    });
  }
  return result;
}

async function writePlugin(state: OpenClawTestState, baseUrl: string) {
  const pluginPath = await writeCatalogPlugin(
    state,
    provider,
    `module.exports = {
    id: ${JSON.stringify(provider)},
    register(api) { api.registerProvider({
      id: ${JSON.stringify(provider)}, label: "Owner login fixture",
      auth: [{ id: "api-key", label: "Fixture key", kind: "api_key", async run(ctx) {
        if (ctx.credentialOnly !== true) throw new Error("Expected credential-only login");
        const response = await fetch(${JSON.stringify(`${baseUrl}/credential`)});
        const credential = await response.json();
        await fetch(${JSON.stringify(`${baseUrl}/prepared`)});
        return {
          profiles: [{ profileId: ${JSON.stringify(profileId)}, credential: {
            type: "api_key", provider: ${JSON.stringify(provider)}, key: credential.key,
          } }],
          configPatch: { models: { providers: { [${JSON.stringify(provider)}]: {
            baseUrl: ${JSON.stringify(`${baseUrl}/v1`)}, api: "openai-completions",
            models: [{ id: "fixture-model", name: "Fixture model", reasoning: false,
              input: ["text"], contextWindow: 32768, maxTokens: 1024,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
          } } } },
        };
      } }],
    }); },
  };`,
    {
      providerAuthChoices: [
        {
          provider,
          method: "api-key",
          choiceId: "fixture-key",
          choiceLabel: "Fixture API key",
          appGuidedSecret: true,
          credentialOnly: true,
        },
      ],
    },
  );
  return modelsTestConfig(state, token, {
    agents: {
      defaults: { modelPolicy: { allow: [`${provider}/*`] } },
    },
    plugins: { allow: [provider], load: { paths: [pluginPath] }, slots: { memory: "none" } },
    models: { catalogRefresh: { enabled: false } },
  });
}

it("discovers plugins.load.paths using the selected read-only config and honors plugin policy", async () => {
  await using state = await createState();
  const cfg = await writePlugin(state, "http://127.0.0.1:1");
  await state.writeConfig(cfg);
  await expect(
    readGatewayLoginParams({ provider, method: "api-key" }, "login", new AbortController().signal),
  ).resolves.toEqual({
    sessionId: "login",
    authChoice: `${provider}/fixture-key`,
    agentId: undefined,
  });
  expect(existsSync(resolveOpenClawStateSqlitePath(state.env))).toBe(false);

  for (const policy of [
    { entries: { [provider]: { enabled: false } } },
    { allow: ["another-plugin"] },
  ]) {
    await state.writeConfig({ ...cfg, plugins: { ...cfg.plugins, ...policy } });
    await expect(
      readGatewayLoginParams({ provider }, "login", new AbortController().signal),
    ).rejects.toThrow("No Gateway-compatible login");
  }
  expect(existsSync(resolveOpenClawStateSqlitePath(state.env))).toBe(false);
});

it.for(["allowed", "non-admin", "revoked"] as const)(
  "owner-bound login uses real credential/config writers: %s",
  async (mode, { signal }) => {
    await using state = await createState();
    const atCredentialWrite = createDeferred();
    const prepared = createDeferred();
    const release = createDeferred();
    let requests = 0;
    const endpoint = createServer((request, response) => {
      requests += 1;
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/credential") {
        response.end(JSON.stringify({ key: "synthetic-owner-key" }));
      } else if (request.url === "/prepared") {
        prepared.resolve();
        void release.promise.then(() => response.end("{}"));
      } else {
        response.writeHead(404).end("{}");
      }
    });
    await using listening = await serveModelsEndpoint(endpoint, true);
    let requester: ServerGatewayClient | null | undefined;
    const login = modelsAuthLoginHandlers["models.authLogin"];
    if (!login) {
      throw new Error("Missing registered login handler");
    }
    const captureRequester = vi
      .spyOn(modelsAuthLoginHandlers, "models.authLogin")
      .mockImplementation((options) => {
        requester = options.client;
        return login(options);
      });
    const persist = providerPersistence.persistProviderAuthProfilesAfterLogin;
    // Keep real writers; revoke at the prepared-lock boundary before their authority check.
    const revoke = vi
      .spyOn(providerPersistence, "persistProviderAuthProfilesAfterLogin")
      .mockImplementation((input) =>
        persist({
          ...input,
          beforeWrite: () => {
            if (mode === "revoked") {
              if (!requester) {
                throw new Error("The real login requester was not captured");
              }
              requester.invalidated = true;
            }
            try {
              input.beforeWrite?.();
            } finally {
              atCredentialWrite.resolve();
            }
          },
        }),
      );
    try {
      const cfg = await writePlugin(state, listening.baseUrl);
      await state.writeConfig(cfg);
      await withGatewayOwner(state, async () => {
        await using gateway = await startModelsGateway(state, cfg, token);
        const { client, port } = gateway;
        try {
          await gateway.server.startupSettled;
          const owner = captureGatewayStateOwner(resolveOpenClawStateSqlitePath(state.env));
          expect(owner?.role).toBe("gateway");
          if (!owner?.ownerId) {
            throw new Error("The real Gateway did not acquire state ownership");
          }
          const beforeConfig = await fs.readFile(state.configPath, "utf8");
          const params = {
            sessionId: "owner-login",
            agentId: "main",
            authChoice: `${provider}/fixture-key`,
            expectedOwnerId: owner.ownerId,
          };
          if (mode === "non-admin") {
            await using reader = await connectModelsReader(port, token);
            await expect(reader.request("models.authLogin", params)).rejects.toThrow(
              /operator.admin|administrator/,
            );
            expect(requests).toBe(0);
          } else {
            await client.request("models.authLogin", params);
            const completion = settleModelsWork(finishLogin(client));
            await withinTest(prepared.promise, signal);
            release.resolve();
            await withinTest(atCredentialWrite.promise, signal);
            if (mode === "revoked") {
              await disconnectGatewayClient(client);
            }
            const outcome = await withinTest(completion, signal);
            if (mode === "allowed") {
              expect(outcome).toMatchObject({ result: { status: "done" } });
            } else {
              expect(outcome.error).toBeDefined();
            }
          }
          await gateway.close();
          const profiles = loadPersistedAuthProfileStore()?.profiles;
          const afterConfig = await fs.readFile(state.configPath, "utf8");
          if (mode === "allowed") {
            expect(profiles?.[profileId]).toMatchObject({
              type: "api_key",
              key: "synthetic-owner-key",
            });
            expect(JSON.parse(afterConfig).models.providers[provider].models[0].id).toBe(
              "fixture-model",
            );
            expect(JSON.parse(afterConfig).agents.defaults.model).toBeUndefined();
          } else {
            expect(profiles?.[profileId]).toBeUndefined();
            expect(afterConfig).toBe(beforeConfig);
          }
        } finally {
          release.resolve();
        }
      });
    } finally {
      release.resolve();
      captureRequester.mockRestore();
      revoke.mockRestore();
    }
  },
);
