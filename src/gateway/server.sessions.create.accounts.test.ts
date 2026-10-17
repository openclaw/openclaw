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
import { identifiedClient, soloClient } from "./server-methods/sessions-sharing.test-support.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  copyGitWorkspace,
  createGitWorkspace,
} from "./server.sessions.create.projects.test-support.js";
import {
  setupSessionCreateHandlerTestHarness,
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
const { createSessionStoreDir, withSessionTestState } = setupSessionCreateHandlerTestHarness(
  async (makeTempDir) => {
    gitWorkspaceTemplate = await createGitWorkspace(makeTempDir("openclaw-session-git-template-"));
  },
);

function profileIdentity(profile: ReturnType<typeof ensureProfileForEmail>) {
  return {
    profileId: profile.id,
    displayName: profile.displayName,
    hasAvatar: false,
    updatedAt: profile.updatedAt,
  };
}

function sessionRequests(
  client: GatewayClient,
  context: Record<string, unknown>,
  storePath: string,
) {
  return {
    request: <T = unknown>(
      method: Parameters<typeof directSessionReq>[0],
      params: Record<string, unknown>,
    ): ReturnType<typeof directSessionReq<T>> =>
      directSessionReq<T>(method, params, { client, context }),
    read: (sessionKey: string) => loadSessionEntry({ sessionKey, storePath }),
  };
}

function connectedClientIds(clients: Set<GatewayClient & { connId: string }>) {
  return (filter?: (client: GatewayClient) => boolean) =>
    new Set([...clients].filter((client) => !filter || filter(client)).map(({ connId }) => connId));
}

async function seedConversation(
  storePath: string,
  key: string,
  sessionId: string,
  entry: Parameters<typeof sessionStoreEntry>[1] = {},
) {
  await writeSessionStore({ entries: { [key]: sessionStoreEntry(sessionId, entry) } });
  await seedSessionTranscript({
    sessionId,
    sessionKey: key,
    storePath,
    messages: [{ role: "user", content: "Review the deployment plan" }],
  });
}

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
    ...soloClient(),
    connId: "personal-session-connection",
    authenticatedUserProfile: profileIdentity(owner),
  };
  client.connect.scopes = ["operator.write"];
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
    getClientConnIds: connectedClientIds(clients),
  };
  return {
    storePath,
    owner,
    authProfileId,
    connectAccount,
    client,
    clients,
    catalog,
    context,
    ...sessionRequests(client, context, storePath),
  };
}

test("session creation provenance cannot authorize a fresh personal account", async () => {
  await withSessionTestState({ layout: "state-only" }, async () => {
    const { read, owner, authProfileId, context } = await createPersonalAccountSessionFixture();
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
    expect(read(key)).toBeUndefined();
  });
});

test("sessions.create preserves an explicit personal account across adoption and a collaborator fork", async () => {
  await withSessionTestState({ layout: "state-only" }, async () => {
    const { read, request, authProfileId, connectAccount, client } =
      await createPersonalAccountSessionFixture();
    const key = "agent:main:dashboard:personal-owner";

    const created = await request("sessions.create", {
      key,
      model: `openai/gpt-5.6-sol@${authProfileId}`,
    });

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    const pinnedAccount = { authProfileOverride: authProfileId, authProfileOverrideSource: "user" };
    expect(read(key)).toMatchObject(pinnedAccount);

    expect(connectAccount("next-account@example.test")).not.toBe(authProfileId);
    const adopted = await request("sessions.create", { key });
    expect(adopted.ok, JSON.stringify(adopted.error)).toBe(true);
    expect(read(key)).toMatchObject(pinnedAccount);

    const collaborator = ensureProfileForEmail("session-collaborator@example.test");
    connectAccount("collaborator-account@example.test", collaborator.id);
    client.authenticatedUserProfile = profileIdentity(collaborator);
    const forkKey = "agent:main:dashboard:personal-collaborator-fork";
    const forked = await request("sessions.create", {
      key: forkKey,
      parentSessionKey: key,
      fork: true,
    });

    expect(forked.ok, JSON.stringify(forked.error)).toBe(true);
    expect(read(forkKey)).toMatchObject({
      ...pinnedAccount,
      parentSessionKey: key,
    });
  });
});

const arceeModels = [
  { id: "trinity-large-thinking", name: "Direct Arcee", baseUrl: "https://api.arcee.ai/api/v1" },
  { id: "trinity-large-preview", name: "Arcee model through OpenRouter" },
];
const arceeCatalog = arceeModels.map(({ id, name }) => ({ id, name, provider: "arcee" }));

test.each([
  ["direct model override", "trinity-large-thinking", "arcee:work", "user-link"],
  ["inherited OpenRouter endpoint", "trinity-large-preview", undefined, undefined],
] as const)(
  "sessions.create applies an admin-linked Arcee default only for the %s",
  async (_endpoint, modelId, expectedPin, expectedSource) => {
    await withSessionTestState(
      { layout: "state-only", prefix: "session-arcee-linked-default-" },
      async (state) => {
        const { ensureAuthProfileStoreWithoutExternalProfiles } =
          await import("../agents/auth-profiles/store-runtime.js");
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
                models: arceeModels.map(({ id, name, baseUrl }) => ({
                  id,
                  name,
                  baseUrl,
                  api: "openai-completions",
                  reasoning: true,
                  input: ["text"],
                  contextWindow: 32768,
                  maxTokens: 2048,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                })),
              },
            },
          },
        };
        await state.writeConfig(inputConfig);
        const credential = {
          type: "api_key",
          provider: "arcee",
          key: "synthetic-direct-arcee-key",
        } as const;
        await state.writeAuthProfiles({ version: 1, profiles: { "arcee:work": credential } });
        const gatewayConfig = await getGatewayConfigModule();
        // The Gateway fixture reads its own config root; bind this case through the real snapshot.
        gatewayConfig.setRuntimeConfigSnapshot(inputConfig);
        const cfg = gatewayConfig.getRuntimeConfig();
        const { loadPluginMetadataSnapshot } =
          await import("../plugins/plugin-metadata-snapshot.js");
        const { withPluginMetadataSnapshotScope } =
          await import("../plugins/current-plugin-metadata-snapshot.js");
        const { resolveSessionModelRef } = await import("../agents/session-model-ref.js");
        const metadata = loadPluginMetadataSnapshot({
          config: cfg,
          workspaceDir: state.workspaceDir,
          env: {
            ...process.env,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
            OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve(import.meta.dirname, "../../extensions"),
          },
          allowCurrent: false,
          preferPersisted: false,
        });
        await withPluginMetadataSnapshotScope(
          metadata,
          async () => {
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
              loadGatewayModelCatalogSnapshot: async () => ({
                entries: arceeCatalog,
                routeVariants: arceeCatalog,
              }),
              getClientConnIds: connectedClientIds(clients),
            };
            const { request } = sessionRequests(client, context, storePath);
            const key = `agent:main:dashboard:arcee-linked-${modelId}`;
            const readSelection = () => {
              const entry = loadSessionEntry({
                sessionKey: key,
                storePath,
                readConsistency: "latest",
              });
              return {
                ...resolveSessionModelRef(cfg, entry, "main"),
                profile: entry?.authProfileOverride,
                source: entry?.authProfileOverrideSource,
              };
            };
            const observedSelections: ReturnType<typeof readSelection>[] = [];
            const chatSend = vi.spyOn(chatSendOwner, "handleDirectExternalChatSend");
            try {
              const linked = await directSessionReq(
                "users.linkAuthProfile",
                { profileId: owner.id, authProfileId: "arcee:work" },
                { client: adminClient, context },
              );
              expect(linked.ok, JSON.stringify(linked.error)).toBe(true);
              const linksBefore = await request("users.listAuthLinks", { profileId: owner.id });
              expect(linksBefore.ok, JSON.stringify(linksBefore.error)).toBe(true);
              expect(linksBefore.payload).toMatchObject({
                links: [{ provider: "arcee", authProfileId: "arcee:work" }],
              });

              expect(loadSessionEntry({ sessionKey: key, storePath })).toBeUndefined();
              chatSend.mockImplementation(async ({ respond }) => {
                observedSelections.push(readSelection());
                respond(true, { runId: "arcee-linked-default-first-turn", status: "started" });
              });
              const created = await request<{ runStarted: boolean }>("sessions.create", {
                key,
                model: `arcee/${modelId}`,
                message: "Start the first turn",
              });
              expect(created).toMatchObject({ ok: true, payload: { runStarted: true } });
              const expectedSelection = {
                provider: "arcee",
                model: modelId,
                profile: expectedPin,
                source: expectedSource,
              };
              expect.soft(observedSelections).toEqual([expectedSelection]);
              expect.soft(readSelection()).toEqual(expectedSelection);
              expect(
                ensureAuthProfileStoreWithoutExternalProfiles(state.agentDir(), { readOnly: true })
                  .profiles["arcee:work"],
              ).toEqual(credential);
              const linksAfter = await request("users.listAuthLinks", { profileId: owner.id });
              expect(linksAfter.ok).toBe(true);
              expect(linksAfter.payload).toEqual(linksBefore.payload);
              expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(inputConfig);
            } finally {
              chatSend.mockRestore();
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
    const { storePath, read, request } = await createPersonalAccountSessionFixture();
    const key = "agent:main:dashboard:unpinned-existing";
    const sessionId = "unpinned-existing-session";
    const model = { providerOverride: "openai", modelOverride: "gpt-5.6-sol" };
    await seedConversation(storePath, key, sessionId, model);
    for (const fork of [false, true]) {
      const target = fork ? `${key}-fork` : key;
      const result = await request("sessions.create", {
        key: target,
        ...(fork ? { parentSessionKey: key, fork: true } : {}),
      });
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
      expect(read(target)).toMatchObject(model);
      expect(read(target)?.authProfileOverride).toBeUndefined();
    }
  });
});

test.each(["foreign admin", "unidentified admin", "synthetic owner"] as const)(
  "sessions.create rejects a fresh personal account from a %s before worktree naming",
  async (kind) => {
    await withSessionTestState({ layout: "state-only" }, async (state) => {
      const workspace = await copyGitWorkspace(gitWorkspaceTemplate, state.root);
      testState.agentConfig = { workspace };
      const { storePath, read, request, authProfileId, client, context } =
        await createPersonalAccountSessionFixture();
      client.connect.scopes = ["operator.admin"];
      const key = "agent:main:dashboard:personal-denied-worktree";
      await seedConversation(storePath, key, "personal-denied-worktree");
      await expect(request("sessions.describe", { key })).resolves.toMatchObject({ ok: true });
      context.loadGatewayModelCatalogSnapshot.mockClear();
      const before = read(key);
      if (kind === "foreign admin") {
        const other = ensureProfileForEmail("session-other-person@example.test");
        client.authenticatedUserProfile = profileIdentity(other);
      } else if (kind === "unidentified admin") {
        delete client.authenticatedUserProfile;
      } else {
        client.internal = {
          syntheticClient: true,
          agentToolCaller: { agentId: "main", sessionKey: key },
        };
      }
      try {
        const created = await request("sessions.create", {
          key,
          model: `openai/gpt-5.6-sol@${authProfileId}`,
          worktree: true,
        });

        expect(created).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
        expect(context.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
        expect(dashboardTitleGenerationMocks.generate).not.toHaveBeenCalled();
        expect(read(key)).toEqual(before);
        expect(await managedWorktrees.findLiveByOwner("session", key)).toBeUndefined();
      } finally {
        await removeSessionWorktree(key);
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
      read,
      request,
      authProfileId: previousAuthProfileId,
      connectAccount,
      client,
    } = await createPersonalAccountSessionFixture();
    const selectedAuthProfileId = connectAccount("next-account@example.test");
    client.connect.scopes = ["operator.admin"];
    const key = "agent:main:dashboard:personal-worktree-transition";
    const sessionId = "personal-worktree-transition";
    await seedConversation(storePath, key, sessionId, {
      providerOverride: "openai",
      modelOverride: "gpt-5.6-luna",
      modelOverrideSource: "user",
      authProfileOverride: previousAuthProfileId,
      authProfileOverrideSource: "user",
    });
    let profileAtNaming: string | undefined;
    dashboardTitleGenerationMocks.generate.mockImplementationOnce(async () => {
      profileAtNaming = read(key)?.authProfileOverride;
      return "Account Transition";
    });
    try {
      const created = await request("sessions.create", {
        key,
        model: `openai/gpt-5.6-sol@${selectedAuthProfileId}`,
        worktree: true,
      });

      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      expect(profileAtNaming).toBe(previousAuthProfileId);
      expect(dashboardTitleGenerationMocks.generate).toHaveBeenCalledOnce();
      expect(dashboardTitleGenerationMocks.generate).toHaveBeenCalledWith(
        expect.objectContaining({
          regularModelRef: `openai/gpt-5.6-luna@${previousAuthProfileId}`,
          preferredProfile: previousAuthProfileId,
        }),
      );
      expect(read(key)).toMatchObject({
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
