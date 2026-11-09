import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import type { WizardNextResult } from "../../../packages/gateway-protocol/src/schema/wizard.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import {
  createFailedOAuthRefreshFence,
  createOAuthRefreshFence,
} from "../../agents/auth-profiles/oauth-refresh-marker.js";
import { resolveSharedAuthStorePath } from "../../agents/auth-profiles/path-resolve.js";
import {
  loadPersistedSharedAuthProfileStore,
  loadPersistedAuthProfileStore,
} from "../../agents/auth-profiles/persisted.js";
import { getPreparedRuntimeAuthProfileStoreSnapshotCore } from "../../agents/auth-profiles/runtime-snapshots.js";
import { updateAuthProfileStoreWithLock } from "../../agents/auth-profiles/store-runtime.js";
import { readGatewayLoginParams } from "../../commands/models/auth-login-gateway.js";
import { runModelsAuthLoginFlowCore } from "../../commands/models/auth.js";
import { setAppliedRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { acquireGatewayLock } from "../../infra/gateway-lock.js";
import { captureGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import * as providerPersistence from "../../plugins/provider-auth-persistence.js";
import { createNonExitingRuntime } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { refreshModelAuthStateAfterMutation } from "../model-auth-refresh.js";
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

async function finishLogin(
  client: Awaited<ReturnType<typeof startModelsGateway>>["client"],
  notes?: string[],
) {
  let result: WizardNextResult = { done: false };
  while (!result.done) {
    const step = result.step;
    if (step?.message) {
      notes?.push(step.message);
    }
    result = await client.request<WizardNextResult>("wizard.next", {
      sessionId: "owner-login",
      ...(step && step.executor !== "gateway" && step.type !== "progress"
        ? { answer: { stepId: step.id, value: step.type === "confirm" ? true : null } }
        : {}),
    });
  }
  return result;
}

async function writePlugin(state: OpenClawTestState, baseUrl: string, oauth = false) {
  const pluginPath = await writeCatalogPlugin(
    state,
    provider,
    `module.exports = {
    id: ${JSON.stringify(provider)},
    register(api) { api.registerProvider({
      id: ${JSON.stringify(provider)}, label: "Owner login fixture",
      auth: [{ id: "api-key", label: "Fixture key", kind: ${JSON.stringify(oauth ? "oauth" : "api_key")}, async run(ctx) {
        if (ctx.credentialOnly !== true) throw new Error("Expected credential-only login");
        const response = await fetch(${JSON.stringify(`${baseUrl}/credential`)});
        const credential = await response.json();
        await fetch(${JSON.stringify(`${baseUrl}/prepared`)});
        return {
          profiles: [{ profileId: ${JSON.stringify(profileId)}, credential: {
            ...credential, provider: ${JSON.stringify(provider)},
          } }],
          defaultModel: "other/provider-default",
          configPatch: { agents: { defaults: { model: "other/provider-default", modelPolicy: { allow: ["*"] } } }, models: { providers: { [${JSON.stringify(provider)}]: {
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

it.for([
  "allowed",
  "non-admin",
  "revoked",
  "shared",
  "shared-non-admin",
  "shared-revoked",
  "shared-owner-changed",
  "unknown-agent",
  "mismatched-owner",
] as const)(
  "owner-bound login uses real credential/config writers: %s",
  async (mode, { signal }) => {
    await using state = await createState();
    const oauth = mode.startsWith("shared");
    const shared = oauth || ["unknown-agent", "mismatched-owner"].includes(mode);
    const atCredentialWrite = createDeferred();
    const prepared = createDeferred();
    const release = createDeferred();
    let requests = 0;
    const endpoint = createServer((request, response) => {
      requests += 1;
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/credential") {
        response.end(
          JSON.stringify(
            oauth
              ? {
                  type: "oauth",
                  access: "synthetic-owner-access",
                  refresh: "synthetic-owner-refresh",
                  expires: 4_000_000_000_000,
                  accountId: "shared-account",
                }
              : { type: "api_key", key: "synthetic-owner-key" },
          ),
        );
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
            if (mode === "revoked" || mode === "shared-revoked") {
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
      const cfg = await writePlugin(state, listening.baseUrl, oauth);
      if (shared) {
        cfg.agents = {
          ownership: "explicit",
          defaults: {
            authInheritance: { agentId: mode === "mismatched-owner" ? "k" : "main" },
            systemAgent: { agentId: "k" },
            modelPolicy: { allow: ["other/default"] },
          },
          entries: Object.fromEntries(
            ["k", "aegis", "scout"].map((id) => [
              id,
              {
                workspace: state.path("workspace", id),
                model: `other/${id}`,
                modelPolicy: { allow: [`other/${id}`] },
              },
            ]),
          ),
        };
        cfg.auth = { order: { [provider]: [`${provider}:previous`, profileId] } };
        await state.writeAuthProfiles(
          {
            version: 1,
            profiles: {
              [profileId]: {
                type: "oauth",
                provider,
                access: "private-k-override",
                refresh: "private-k-refresh",
                expires: 4_000_000_000_001,
                accountId: "private-k-account",
              },
            },
          },
          "k",
        );
      }
      await state.writeConfig(cfg);
      await withGatewayOwner(state, async () => {
        if (shared) {
          await updateAuthProfileStoreWithLock({
            updater: (store) => {
              store.profiles[profileId] = oauth
                ? createFailedOAuthRefreshFence(
                    createOAuthRefreshFence({
                      profileId,
                      credential: {
                        type: "oauth",
                        provider,
                        access: "expired-shared-access",
                        refresh: "expired-shared-refresh",
                        expires: 1_000,
                        accountId: "shared-account",
                      },
                    }),
                  )
                : { type: "api_key", provider, key: "shared-before-login" };
              store.profiles[`${provider}:previous`] = {
                type: "api_key",
                provider,
                key: "shared-previous",
              };
              store.order = { [provider]: [`${provider}:previous`, profileId] };
              return true;
            },
          });
        }
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
          const beforeSharedStore = structuredClone(loadPersistedAuthProfileStore());
          if (mode === "shared") {
            await expect(
              runModelsAuthLoginFlowCore({
                agent: "main",
                provider,
                method: "api-key",
                setDefault: true,
                config: cfg,
                runtime: createNonExitingRuntime(),
                prompter: createWizardPrompter(),
              }),
            ).rejects.toThrow("Shared credential sign-in cannot set a default model");
            expect(requests).toBe(0);
          }
          const params = {
            sessionId: "owner-login",
            agentId: mode === "unknown-agent" ? "missing" : "main",
            authChoice: `${provider}/fixture-key`,
            expectedOwnerId: owner.ownerId,
          };
          if (mode === "non-admin" || mode === "shared-non-admin") {
            await using reader = await connectModelsReader(port, token);
            await expect(reader.request("models.authLogin", params)).rejects.toThrow(
              /operator.admin|administrator/,
            );
            expect(requests).toBe(0);
          } else if (mode === "shared-owner-changed") {
            await client.request("models.authLogin", params);
            const completion = finishLogin(client);
            await withinTest(prepared.promise, signal);
            const changed = structuredClone(cfg);
            changed.agents = {
              ...changed.agents,
              defaults: { ...changed.agents?.defaults, authInheritance: { agentId: "k" } },
            };
            await setAppliedRuntimeConfigSnapshot(changed, changed);
            release.resolve();
            const outcome = await withinTest(completion, signal);
            expect(outcome).toMatchObject({ status: "error" });
            expect(outcome.error).toContain("Shared credential ownership changed during sign-in");
          } else if (shared && mode !== "shared-revoked") {
            release.resolve();
            await client.request("models.authLogin", params);
            const notes: string[] = [];
            const outcome = await withinTest(finishLogin(client, notes), signal);
            if (mode === "shared") {
              expect(outcome.error).toBeUndefined();
              expect(outcome).toMatchObject({ status: "done" });
              expect(notes.join("\n")).toContain("Scope: Shared / all inheriting agents");
              await expect(
                client.request("models.authRefresh", { agentId: "main", operation: "login" }),
              ).resolves.toEqual({ refreshed: true });
              for (const id of ["k", "aegis", "scout"]) {
                expect(
                  getPreparedRuntimeAuthProfileStoreSnapshotCore(resolveAgentDir(cfg, id))
                    ?.profiles[profileId],
                ).toMatchObject({
                  access: id === "k" ? "private-k-override" : "synthetic-owner-access",
                });
              }
            } else {
              expect(outcome).toMatchObject({ status: "error" });
              expect(outcome.error).toMatch(/unknown agent id/i);
              expect(requests).toBe(0);
            }
          } else {
            await client.request("models.authLogin", params);
            const completion = settleModelsWork(finishLogin(client));
            await withinTest(prepared.promise, signal);
            release.resolve();
            await withinTest(atCredentialWrite.promise, signal);
            if (mode === "revoked" || mode === "shared-revoked") {
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
          if (mode === "allowed" || mode === "shared") {
            expect(profiles?.[profileId]).toMatchObject({
              type: mode === "shared" ? "oauth" : "api_key",
              ...(mode === "shared"
                ? { access: "synthetic-owner-access", refresh: "synthetic-owner-refresh" }
                : { key: "synthetic-owner-key" }),
            });
            expect(JSON.parse(afterConfig).models.providers[provider].models[0].id).toBe(
              "fixture-model",
            );
            expect(JSON.parse(afterConfig).agents.defaults.model).toBeUndefined();
            if (mode === "shared") {
              expect(JSON.parse(afterConfig).agents).toEqual(JSON.parse(beforeConfig).agents);
              expect(resolveSharedAuthStorePath(state.env)).toBe(
                resolveOpenClawStateSqlitePath(state.env),
              );
              expect(
                loadPersistedAuthProfileStore(state.agentDir("main"))?.profiles[profileId],
              ).toBeUndefined();
              expect(loadPersistedAuthProfileStore()?.order?.[provider]).toEqual([
                profileId,
                `${provider}:previous`,
              ]);
              expect(
                loadPersistedAuthProfileStore(state.agentDir("k"))?.profiles[profileId],
              ).toMatchObject({ access: "private-k-override", accountId: "private-k-account" });
              for (const id of ["aegis", "scout"]) {
                expect(
                  loadPersistedAuthProfileStore(state.agentDir(id))?.profiles[profileId],
                ).toBeUndefined();
              }
            }
          } else {
            if (shared) {
              expect(loadPersistedAuthProfileStore()).toEqual(beforeSharedStore);
            } else {
              expect(profiles?.[profileId]).toBeUndefined();
            }
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

it("rejects shared login into another state owner before provider effects", async () => {
  await using state = await createState();
  await using other = await createModelsTestState("other-login-owner", {
    layout: "state-only",
    applyEnv: false,
  });
  let requests = 0;
  const endpoint = createServer((request, response) => {
    requests += 1;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify(
        request.url === "/credential"
          ? {
              type: "oauth",
              access: "synthetic-other-access",
              refresh: "synthetic-other-refresh",
              expires: 4_000_000_000_000,
              accountId: "shared-account",
            }
          : {},
      ),
    );
  });
  await using listening = await serveModelsEndpoint(endpoint, true);
  const cfg = await writePlugin(state, listening.baseUrl, true);
  cfg.agents = {
    entries: { k: { workspace: state.workspaceDir } },
    defaults: { authInheritance: { agentId: "main" }, systemAgent: { agentId: "k" } },
  };
  await state.writeConfig(cfg);
  await other.writeConfig(cfg);
  for (const [target, key] of [
    [state, "owner-a-key"],
    [other, "owner-b-key"],
  ] as const) {
    await withGatewayOwner(target, async () => {
      await updateAuthProfileStoreWithLock({
        stateDir: target.stateDir,
        updater: (store) => {
          store.profiles[profileId] = { type: "api_key", provider, key };
          store.profiles[`${provider}:previous`] = {
            type: "api_key",
            provider,
            key: `${key}-previous`,
          };
          store.order = { [provider]: [`${provider}:previous`, profileId] };
          return true;
        },
      });
    });
  }
  const beforeA = structuredClone(loadPersistedSharedAuthProfileStore(state.env));
  const beforeB = structuredClone(loadPersistedSharedAuthProfileStore(other.env));
  const configA = await fs.readFile(state.configPath, "utf8");
  const configB = await fs.readFile(other.configPath, "utf8");
  await withGatewayOwner(other, async () => {
    await expect(
      runModelsAuthLoginFlowCore({
        agent: "main",
        provider,
        method: "api-key",
        config: cfg,
        env: other.env,
        runtime: createNonExitingRuntime(),
        prompter: createWizardPrompter(),
        refreshAfterLogin: (agentId) => refreshModelAuthStateAfterMutation(() => cfg, agentId),
      }),
    ).rejects.toThrow("Shared credential sign-in must run on the intended Gateway or state owner");
  });
  expect(requests).toBe(0);
  expect(loadPersistedSharedAuthProfileStore(state.env)).toEqual(beforeA);
  expect(loadPersistedSharedAuthProfileStore(other.env)).toEqual(beforeB);
  expect(await fs.readFile(state.configPath, "utf8")).toBe(configA);
  expect(await fs.readFile(other.configPath, "utf8")).toBe(configB);
});
