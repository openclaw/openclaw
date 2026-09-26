import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import { createDeferredCore } from "../shared/deferred.js";
import { connectUserModelAccount } from "../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  copyGitWorkspace,
  createGitWorkspace,
} from "./server.sessions.create.projects.test-support.js";
import {
  setupSessionCreateTestHarness,
  dashboardTitleGenerationMocks,
  chatSendOwner,
  removeSessionWorktree,
} from "./server.sessions.create.test-support.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  getGatewayConfigModule,
  sessionStoreEntry,
  directSessionReq,
  seedSessionTranscript,
} from "./test/server-sessions.test-helpers.js";

let gitWorkspaceTemplate: string;
const { createSessionStoreDir, withSessionTestState } = setupSessionCreateTestHarness(
  async (makeTempDir) => {
    gitWorkspaceTemplate = await createGitWorkspace(makeTempDir("openclaw-session-git-template-"));
  },
);

async function createPersonalAccountSessionFixture() {
  const { storePath } = await createSessionStoreDir();
  const owner = ensureProfileForEmail("session-account-owner@example.test");
  const connectAccount = (email: string, profileId = owner.id) =>
    connectUserModelAccount({
      ownerProfileId: profileId,
      credential: {
        type: "oauth",
        provider: "openai",
        access: "synthetic-session-access",
        refresh: "synthetic-session-refresh",
        expires: Date.now() + 60_000,
        email,
      },
      assertCurrent() {},
    }).authProfileId;
  const authProfileId = connectAccount("first-account@example.test");
  const client: GatewayClient & { connId: string } = {
    connId: "personal-session-connection",
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: { id: "openclaw-control-ui", version: "test", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.write"],
    },
    authenticatedUserProfile: {
      profileId: owner.id,
      displayName: owner.displayName,
      hasAvatar: false,
      updatedAt: owner.updatedAt,
    },
  };
  const clients = new Set([client]);
  const catalog = [
    { id: "gpt-5.6-sol", name: "GPT 5.6 Sol", provider: "openai" },
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", provider: "openai" },
  ];
  const gatewayConfig = await getGatewayConfigModule();
  // Real account setup can warm config IO before the Gateway fixture applies its workspace.
  gatewayConfig.clearRuntimeConfigSnapshot();
  const cfg = gatewayConfig.getRuntimeConfig();
  const context = {
    getRuntimeConfig: () => cfg,
    loadGatewayModelCatalogSnapshot: vi.fn(async () => ({
      entries: catalog,
      routeVariants: catalog,
    })),
    getClientConnIds: (filter?: (current: GatewayClient) => boolean) =>
      new Set(
        [...clients].filter((current) => !filter || filter(current)).map(({ connId }) => connId),
      ),
  };
  return { storePath, owner, authProfileId, connectAccount, client, clients, catalog, context };
}

test("session creation provenance cannot authorize a fresh personal account", async () => {
  await withSessionTestState({ layout: "state-only" }, async () => {
    const { storePath, owner, authProfileId, context } =
      await createPersonalAccountSessionFixture();
    const { createGatewaySession } = await import("./session-create-service.js");
    const key = "agent:main:dashboard:personal-provenance-only";
    const prepareLifecycle = vi.fn(async () => ({ ok: true, value: {} }) as const);

    const created = await createGatewaySession({
      cfg: getRuntimeConfig(),
      agentId: "main",
      key,
      model: `openai/gpt-5.6-sol@${authProfileId}`,
      requestingOperatorProfileId: owner.id,
      requestingOperatorScopes: ["operator.admin"],
      creation: { via: "operator", actor: { type: "human", source: "profile", id: owner.id } },
      commandSource: "webchat",
      prepareLifecycle,
      loadGatewayModelCatalogSnapshot: context.loadGatewayModelCatalogSnapshot,
    });

    expect(created).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(prepareLifecycle).not.toHaveBeenCalled();
    expect(context.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey: key, storePath })).toBeUndefined();
  });
});

test.each([
  { selection: "explicit", source: "user" },
  { selection: "default", source: "user-link" },
] as const)(
  "sessions.create preserves a personal $selection across adoption and a collaborator fork",
  async ({ selection, source }) => {
    await withSessionTestState({ layout: "state-only" }, async () => {
      const { storePath, authProfileId, connectAccount, client, context } =
        await createPersonalAccountSessionFixture();
      const key = "agent:main:dashboard:personal-owner";

      const created = await directSessionReq(
        "sessions.create",
        {
          key,
          model: `openai/gpt-5.6-sol${selection === "explicit" ? `@${authProfileId}` : ""}`,
        },
        { client, context },
      );

      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
        authProfileOverride: authProfileId,
        authProfileOverrideSource: source,
      });

      expect(connectAccount("next-account@example.test")).not.toBe(authProfileId);
      const adopted = await directSessionReq("sessions.create", { key }, { client, context });
      expect(adopted.ok, JSON.stringify(adopted.error)).toBe(true);
      expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
        authProfileOverride: authProfileId,
        authProfileOverrideSource: source,
      });

      const collaborator = ensureProfileForEmail("session-collaborator@example.test");
      connectAccount("collaborator-account@example.test", collaborator.id);
      client.authenticatedUserProfile = {
        profileId: collaborator.id,
        displayName: collaborator.displayName,
        hasAvatar: false,
        updatedAt: collaborator.updatedAt,
      };
      const forkKey = "agent:main:dashboard:personal-collaborator-fork";
      const forked = await directSessionReq(
        "sessions.create",
        { key: forkKey, parentSessionKey: key, fork: true },
        { client, context },
      );

      expect(forked.ok, JSON.stringify(forked.error)).toBe(true);
      expect(loadSessionEntry({ sessionKey: forkKey, storePath })).toMatchObject({
        authProfileOverride: authProfileId,
        authProfileOverrideSource: source,
        parentSessionKey: key,
      });
    });
  },
);

test("sessions.create commits the personal default before dispatching its initial turn", async () => {
  await withSessionTestState({ layout: "state-only" }, async () => {
    const { storePath, authProfileId, client, context } =
      await createPersonalAccountSessionFixture();
    const key = "agent:main:dashboard:personal-default-initial-turn";
    const observedProfiles: Array<string | undefined> = [];
    const chatSend = vi.spyOn(chatSendOwner, "handleDirectExternalChatSend");
    chatSend.mockImplementation(async ({ respond }) => {
      observedProfiles.push(loadSessionEntry({ sessionKey: key, storePath })?.authProfileOverride);
      respond(true, { runId: "personal-default-first-turn", status: "started" });
    });
    try {
      const created = await directSessionReq<{ runStarted: boolean }>(
        "sessions.create",
        { key, model: "openai/gpt-5.6-sol", message: "Start the first turn" },
        { client, context },
      );

      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      expect(created.payload?.runStarted).toBe(true);
      expect(observedProfiles).toEqual([authProfileId]);
      expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
        authProfileOverride: authProfileId,
        authProfileOverrideSource: "user-link",
      });
    } finally {
      chatSend.mockRestore();
    }
  });
});

test.each([
  {
    endpoint: "direct model override",
    modelId: "trinity-large-thinking",
    baseUrl: "https://api.arcee.ai/api/v1",
    expectedPin: "arcee:work",
    expectedSource: "user-link",
  },
  {
    endpoint: "inherited OpenRouter endpoint",
    modelId: "trinity-large-preview",
    baseUrl: "https://openrouter.ai/api/v1",
    expectedPin: undefined,
    expectedSource: undefined,
  },
] as const)(
  "sessions.create applies an admin-linked Arcee default only for the $endpoint",
  async ({ modelId, baseUrl, expectedPin, expectedSource }) => {
    await withSessionTestState(
      { layout: "state-only", prefix: "session-arcee-linked-default-" },
      async (state) => {
        const { OpenClawSchema } = await import("../config/zod-schema.js");
        const { ensureAuthProfileStoreWithoutExternalProfiles } =
          await import("../agents/auth-profiles/store-runtime.js");
        const { resolveModelWithRegistry } =
          await import("../agents/embedded-agent-runner/model.registry-resolution.js");
        const { AuthStorage } = await import("../agents/sessions/auth-storage.js");
        const { ModelRegistry } = await import("../agents/sessions/model-registry.js");
        const { createModelAccountConnectService } = await import("./model-account-connect.js");
        const { storePath } = await createSessionStoreDir();
        const inputConfig: import("../config/types.openclaw.js").OpenClawConfig = {
          plugins: { allow: ["arcee"] },
          agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
          session: { store: storePath },
          auth: { profiles: { "arcee:work": { provider: "arcee", mode: "api_key" } } },
          models: {
            providers: {
              arcee: {
                baseUrl: "https://openrouter.ai/api/v1",
                api: "openai-completions",
                models: [
                  {
                    id: "trinity-large-thinking",
                    name: "Direct Arcee model",
                    api: "openai-completions",
                    baseUrl: "https://api.arcee.ai/api/v1",
                    reasoning: true,
                    input: ["text"],
                    contextWindow: 32768,
                    maxTokens: 2048,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                  {
                    id: "trinity-large-preview",
                    name: "Arcee model through OpenRouter",
                    api: "openai-completions",
                    reasoning: true,
                    input: ["text"],
                    contextWindow: 32768,
                    maxTokens: 2048,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
        };
        const parsedConfig = OpenClawSchema.safeParse(inputConfig);
        expect(parsedConfig.success, JSON.stringify(parsedConfig.error?.issues)).toBe(true);
        await state.writeConfig(inputConfig);
        const credential = {
          type: "api_key",
          provider: "arcee",
          key: "synthetic-direct-arcee-key",
        } as const;
        await state.writeAuthProfiles({
          version: 1,
          profiles: { "arcee:work": credential },
        });
        const gatewayConfig = await getGatewayConfigModule();
        // The Gateway fixture reads its own config root; bind this case through the real snapshot.
        gatewayConfig.setRuntimeConfigSnapshot(inputConfig);
        const cfg = gatewayConfig.getRuntimeConfig();
        const { loadPluginMetadataSnapshot } =
          await import("../plugins/plugin-metadata-snapshot.js");
        const { getCurrentPluginMetadataSnapshot, withPluginMetadataSnapshotScope } =
          await import("../plugins/current-plugin-metadata-snapshot.js");
        const { resolveProviderIdForAuth } = await import("../agents/provider-auth-aliases.js");
        const { resolveSessionModelRef } = await import("../agents/session-model-ref.js");
        const bundledRoot = path.resolve(import.meta.dirname, "../../extensions");
        const metadata = loadPluginMetadataSnapshot({
          config: cfg,
          workspaceDir: state.workspaceDir,
          env: {
            ...process.env,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
            OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
          },
          allowCurrent: false,
          preferPersisted: false,
        });
        await withPluginMetadataSnapshotScope(
          metadata,
          async () => {
            const manifest = metadata.byPluginId.get("arcee");
            const manifestPath = path.join(bundledRoot, "arcee", "openclaw.plugin.json");
            const declaredManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
            expect(manifest?.manifestPath).toBe(manifestPath);
            expect(manifest?.origin).toBe("bundled");
            expect(manifest?.providerAuthAliases).toEqual(declaredManifest.providerAuthAliases);
            expect(
              getCurrentPluginMetadataSnapshot({
                config: cfg,
                allowWorkspaceScopedSnapshot: true,
              }) === metadata,
            ).toBe(true);
            const providerDefaultAuth = resolveProviderIdForAuth("arcee", { config: cfg });
            expect(providerDefaultAuth).toBe("openrouter");
            expect(resolveProviderIdForAuth("arcee", { config: cfg, storedCredential: true })).toBe(
              "arcee",
            );
            const model = await resolveModelWithRegistry({
              cfg,
              provider: "arcee",
              modelId,
              agentDir: state.agentDir(),
              modelRegistry: ModelRegistry.inMemory(AuthStorage.inMemory()),
            });
            expect(model?.baseUrl).toBe(baseUrl);

            const owner = ensureProfileForEmail("arcee-session-owner@example.test");
            const administrator = ensureProfileForEmail("arcee-link-admin@example.test");
            const client = {
              ...identifiedClient(owner.id, owner.displayName),
              connId: "arcee-session-owner-connection",
            };
            const adminClient = {
              ...identifiedClient(administrator.id, administrator.displayName),
              connId: "arcee-link-admin-connection",
            };
            adminClient.connect.scopes = ["operator.admin"];
            const clients = new Set([client, adminClient]);
            const service = createModelAccountConnectService({ getConfig: () => cfg });
            const context = {
              getRuntimeConfig: () => cfg,
              modelAccountConnectService: service,
              loadGatewayModelCatalogSnapshot: async () => {
                const entries = [
                  { id: "trinity-large-thinking", name: "Direct Arcee model", provider: "arcee" },
                  {
                    id: "trinity-large-preview",
                    name: "Arcee model through OpenRouter",
                    provider: "arcee",
                  },
                ];
                return { entries, routeVariants: entries };
              },
              getClientConnIds: (filter?: (current: GatewayClient) => boolean) =>
                new Set(
                  [...clients]
                    .filter((current) => !filter || filter(current))
                    .map(({ connId }) => connId),
                ),
            };
            try {
              const linked = await directSessionReq(
                "users.linkAuthProfile",
                { profileId: owner.id, authProfileId: "arcee:work" },
                { client: adminClient, context },
              );
              expect(linked.ok, JSON.stringify(linked.error)).toBe(true);
              const linksBefore = await directSessionReq(
                "users.listAuthLinks",
                { profileId: owner.id },
                { client, context },
              );
              expect(linksBefore.ok, JSON.stringify(linksBefore.error)).toBe(true);
              expect(linksBefore.payload).toMatchObject({
                links: [{ provider: "arcee", authProfileId: "arcee:work" }],
              });

              const key = `agent:main:dashboard:arcee-linked-${modelId}`;
              expect(loadSessionEntry({ sessionKey: key, storePath })).toBeUndefined();
              const observedSelections: Array<{
                provider: string | undefined;
                model: string | undefined;
                profile: string | undefined;
                source: string | undefined;
              }> = [];
              const chatSend = vi.spyOn(chatSendOwner, "handleDirectExternalChatSend");
              chatSend.mockImplementation(async ({ respond }) => {
                const entry = loadSessionEntry({
                  sessionKey: key,
                  storePath,
                  readConsistency: "latest",
                });
                observedSelections.push({
                  ...resolveSessionModelRef(cfg, entry, "main"),
                  profile: entry?.authProfileOverride,
                  source: entry?.authProfileOverrideSource,
                });
                respond(true, { runId: "arcee-linked-default-first-turn", status: "started" });
              });
              try {
                const created = await directSessionReq<{ runStarted: boolean }>(
                  "sessions.create",
                  { key, model: `arcee/${modelId}`, message: "Start the first turn" },
                  { client, context },
                );

                expect(created.ok, JSON.stringify(created.error)).toBe(true);
                expect(created.payload?.runStarted).toBe(true);
                expect.soft(observedSelections).toEqual([
                  {
                    provider: "arcee",
                    model: modelId,
                    profile: expectedPin,
                    source: expectedSource,
                  },
                ]);
                const saved = loadSessionEntry({
                  sessionKey: key,
                  storePath,
                  readConsistency: "latest",
                });
                expect
                  .soft(resolveSessionModelRef(cfg, saved, "main"))
                  .toEqual({ provider: "arcee", model: modelId });
                expect.soft(saved?.authProfileOverride).toBe(expectedPin);
                expect.soft(saved?.authProfileOverrideSource).toBe(expectedSource);
                expect(
                  ensureAuthProfileStoreWithoutExternalProfiles(state.agentDir(), {
                    readOnly: true,
                  }).profiles["arcee:work"],
                ).toEqual(credential);
                const linksAfter = await directSessionReq(
                  "users.listAuthLinks",
                  { profileId: owner.id },
                  { client, context },
                );
                expect(linksAfter.ok, JSON.stringify(linksAfter.error)).toBe(true);
                expect(linksAfter.payload).toEqual(linksBefore.payload);
                expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(
                  inputConfig,
                );
              } finally {
                chatSend.mockRestore();
              }
            } finally {
              clients.clear();
              await service.stop();
              gatewayConfig.clearRuntimeConfigSnapshot();
            }
          },
          { config: cfg, env: process.env, workspaceDir: state.workspaceDir },
        );
      },
    );
  },
);

test("sessions.create does not donate a personal default to an unpinned adoption or fork", async () => {
  await withSessionTestState({ layout: "state-only" }, async () => {
    const { storePath, client, context } = await createPersonalAccountSessionFixture();
    const key = "agent:main:dashboard:unpinned-existing";
    const sessionId = "unpinned-existing-session";
    await writeSessionStore({
      entries: {
        [key]: sessionStoreEntry(sessionId, {
          providerOverride: "openai",
          modelOverride: "gpt-5.6-sol",
        }),
      },
    });
    await seedSessionTranscript({
      sessionId,
      sessionKey: key,
      storePath,
      messages: [{ role: "user", content: "An existing shared-auth conversation" }],
    });
    for (const fork of [false, true]) {
      const target = fork ? `${key}-fork` : key;
      const result = await directSessionReq(
        "sessions.create",
        { key: target, ...(fork ? { parentSessionKey: key, fork: true } : {}) },
        { client, context },
      );
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
      expect(loadSessionEntry({ sessionKey: target, storePath })).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
      });
      expect(
        loadSessionEntry({ sessionKey: target, storePath })?.authProfileOverride,
      ).toBeUndefined();
    }
  });
});

test.each(["foreign admin", "unidentified admin", "synthetic owner"] as const)(
  "sessions.create rejects a fresh personal account from a %s before worktree naming",
  async (kind) => {
    await withSessionTestState({ layout: "state-only" }, async (state) => {
      const workspace = await copyGitWorkspace(gitWorkspaceTemplate, state.root);
      testState.agentConfig = { workspace };
      const { storePath, authProfileId, client, context } =
        await createPersonalAccountSessionFixture();
      client.connect.scopes = ["operator.admin"];
      const key = "agent:main:dashboard:personal-denied-worktree";
      await writeSessionStore({
        entries: { [key]: sessionStoreEntry("personal-denied-worktree") },
      });
      await seedSessionTranscript({
        sessionId: "personal-denied-worktree",
        sessionKey: key,
        storePath,
        messages: [{ role: "user", content: "Review the deployment plan" }],
      });
      await expect(
        directSessionReq("sessions.describe", { key }, { client, context }),
      ).resolves.toMatchObject({ ok: true });
      context.loadGatewayModelCatalogSnapshot.mockClear();
      const before = loadSessionEntry({ sessionKey: key, storePath });
      if (kind === "foreign admin") {
        const other = ensureProfileForEmail("session-other-person@example.test");
        client.authenticatedUserProfile = {
          profileId: other.id,
          displayName: other.displayName,
          hasAvatar: false,
          updatedAt: other.updatedAt,
        };
      } else if (kind === "unidentified admin") {
        delete client.authenticatedUserProfile;
      } else {
        client.internal = {
          syntheticClient: true,
          agentToolCaller: { agentId: "main", sessionKey: key },
        };
      }
      try {
        const created = await directSessionReq(
          "sessions.create",
          { key, model: `openai/gpt-5.6-sol@${authProfileId}`, worktree: true },
          { client, context },
        );

        expect(created).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
        expect(context.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
        expect(dashboardTitleGenerationMocks.generate).not.toHaveBeenCalled();
        expect(loadSessionEntry({ sessionKey: key, storePath })).toEqual(before);
        expect(managedWorktrees.findLiveByOwner("session", key)).toBeUndefined();
      } finally {
        const worktree = managedWorktrees.findLiveByOwner("session", key);
        if (worktree) {
          await managedWorktrees.remove({
            id: worktree.id,
            reason: "test-cleanup",
            allowSnapshotLoss: true,
          });
        }
        testState.agentConfig = undefined;
      }
    });
  },
);

test.each([
  { loss: "disconnected", selection: "explicit" },
  { loss: "role revoked", selection: "default" },
] as const)(
  "sessions.create rejects a personal $selection when $loss while the model catalog is loading",
  async ({ loss, selection }) => {
    await withSessionTestState({ layout: "state-only" }, async () => {
      const { storePath, authProfileId, client, clients, catalog, context } =
        await createPersonalAccountSessionFixture();
      const writer: GatewayOperatorRoleDefinition = {
        agents: "*",
        scopes: ["operator.write"],
        sessions: { others: "none" },
      };
      const cfg = {
        ...getRuntimeConfig(),
        gateway: { roles: { default: "writer", definitions: { writer } } },
      };
      const catalogStarted = createDeferredCore();
      const catalogGate = createDeferredCore();
      context.loadGatewayModelCatalogSnapshot.mockImplementationOnce(async () => {
        catalogStarted.resolve();
        await catalogGate.promise;
        return { entries: catalog, routeVariants: catalog };
      });
      const key = "agent:main:dashboard:personal-revoked";
      const creating = directSessionReq(
        "sessions.create",
        {
          key,
          model: `openai/gpt-5.6-sol${selection === "explicit" ? `@${authProfileId}` : ""}`,
        },
        { client, context: { ...context, getRuntimeConfig: () => cfg } },
      );
      try {
        await Promise.race([
          catalogStarted.promise,
          creating.then(() => {
            throw new Error("Session creation returned before loading the model catalog");
          }),
        ]);
        expect(context.loadGatewayModelCatalogSnapshot).toHaveBeenCalledOnce();
        if (loss === "disconnected") {
          clients.delete(client);
        } else {
          writer.scopes = ["operator.read"];
        }
      } finally {
        catalogGate.resolve();
      }
      const created = await creating;

      expect(created).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect(loadSessionEntry({ sessionKey: key, storePath })).toBeUndefined();
    });
  },
);

test("sessions.create names an adopted worktree with its committed account before selecting a new personal account", async () => {
  await withSessionTestState({ layout: "state-only" }, async (state) => {
    const workspace = await copyGitWorkspace(gitWorkspaceTemplate, state.root);
    testState.agentConfig = { workspace, model: { primary: "openai/gpt-5.6-sol" } };
    const {
      storePath,
      authProfileId: previousAuthProfileId,
      connectAccount,
      client,
      context,
    } = await createPersonalAccountSessionFixture();
    const selectedAuthProfileId = connectAccount("next-account@example.test");
    client.connect.scopes = ["operator.admin"];
    const key = "agent:main:dashboard:personal-worktree-transition";
    const sessionId = "personal-worktree-transition";
    await writeSessionStore({
      entries: {
        [key]: sessionStoreEntry(sessionId, {
          providerOverride: "openai",
          modelOverride: "gpt-5.6-luna",
          modelOverrideSource: "user",
          authProfileOverride: previousAuthProfileId,
          authProfileOverrideSource: "user",
        }),
      },
    });
    await seedSessionTranscript({
      sessionId,
      sessionKey: key,
      storePath,
      messages: [{ role: "user", content: "Review the deployment plan" }],
    });
    let profileAtNaming: string | undefined;
    dashboardTitleGenerationMocks.generate.mockImplementationOnce(async () => {
      profileAtNaming = loadSessionEntry({ sessionKey: key, storePath })?.authProfileOverride;
      return "Account Transition";
    });
    try {
      const created = await directSessionReq(
        "sessions.create",
        { key, model: `openai/gpt-5.6-sol@${selectedAuthProfileId}`, worktree: true },
        { client, context },
      );

      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      expect(profileAtNaming).toBe(previousAuthProfileId);
      expect(
        dashboardTitleGenerationMocks.generate.mock.calls.map(([request]) => ({
          regularModelRef: request.regularModelRef,
          preferredProfile: request.preferredProfile,
        })),
      ).toEqual([
        {
          regularModelRef: `openai/gpt-5.6-luna@${previousAuthProfileId}`,
          preferredProfile: previousAuthProfileId,
        },
      ]);
      expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject({
        authProfileOverride: selectedAuthProfileId,
        authProfileOverrideSource: "user",
        displayName: "Account Transition",
        worktree: { branch: "openclaw/account-transition" },
      });
    } finally {
      await removeSessionWorktree(key);
      testState.agentConfig = undefined;
    }
  });
});
