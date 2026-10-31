import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { modelDefinition } from "../agents/model-auth.fixtures.test-support.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import {
  connectUserModelAccount,
  listUserProfileAuthLinks,
  setUserProfileAuthLink,
} from "../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
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
import { gatewayConnect, gatewayProfile } from "./server/client-fixtures.test-support.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  getGatewayConfigModule,
  sessionStoreEntry,
  directSessionReq,
  seedSessionTranscript,
} from "./test/server-sessions.test-helpers.js";

let gitWorkspaceTemplate: string;
const openaiSelection = { providerOverride: "openai", modelOverride: "gpt-5.6-sol" };
const pinnedAccount = (authProfileOverride: string) => ({
  authProfileOverride,
  authProfileOverrideSource: "user" as const,
});
const readSession = (storePath: string, sessionKey: string) =>
  loadSessionEntry({ storePath, sessionKey });
function modelContext(
  cfg: ReturnType<typeof getRuntimeConfig>,
  entries: Array<{ id: string; name: string; provider: string }>,
  clients: ReadonlySet<GatewayClient & { connId: string }>,
) {
  return {
    getRuntimeConfig: () => cfg,
    loadGatewayModelCatalogSnapshot: vi.fn(async () => ({ entries, routeVariants: entries })),
    getClientConnIds: (filter?: (client: GatewayClient) => boolean) =>
      new Set(
        [...clients].filter((client) => !filter || filter(client)).map(({ connId }) => connId),
      ),
  };
}
async function seedAccountSession(
  storePath: string,
  key: string,
  entry: Parameters<typeof sessionStoreEntry>[1] = {},
  content = "Review the deployment plan",
  sessionId = key.split(":").at(-1) ?? key,
) {
  await writeSessionStore({ entries: { [key]: sessionStoreEntry(sessionId, entry) } });
  await seedSessionTranscript({
    sessionId,
    sessionKey: key,
    storePath,
    messages: [{ role: "user", content }],
  });
}
const { createSessionStoreDir, withSessionTestState } = setupSessionCreateHandlerTestHarness(
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
    connect: gatewayConnect(["operator.write"]),
    authenticatedUserProfile: gatewayProfile(owner.id, owner.displayName, owner.updatedAt),
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
  const context = modelContext(cfg, catalog, clients);
  const create = (params: Record<string, unknown>) =>
    directSessionReq("sessions.create", params, { client, context });
  return { storePath, owner, authProfileId, connectAccount, client, context, create };
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

test("sessions.create preserves an explicit personal account across adoption and a collaborator fork", async () => {
  await withSessionTestState({ layout: "state-only" }, async () => {
    const { storePath, authProfileId, connectAccount, client, create } =
      await createPersonalAccountSessionFixture();
    const key = "agent:main:dashboard:personal-owner";

    const created = await create({ key, model: `openai/gpt-5.6-sol@${authProfileId}` });

    expect(created.ok, JSON.stringify(created.error)).toBe(true);
    expect(readSession(storePath, key)).toMatchObject(pinnedAccount(authProfileId));

    expect(connectAccount("next-account@example.test")).not.toBe(authProfileId);
    const adopted = await create({ key });
    expect(adopted.ok, JSON.stringify(adopted.error)).toBe(true);
    expect(readSession(storePath, key)).toMatchObject(pinnedAccount(authProfileId));

    const collaborator = ensureProfileForEmail("session-collaborator@example.test");
    connectAccount("collaborator-account@example.test", collaborator.id);
    client.authenticatedUserProfile = gatewayProfile(
      collaborator.id,
      collaborator.displayName,
      collaborator.updatedAt,
    );
    const forkKey = "agent:main:dashboard:personal-collaborator-fork";
    const forked = await create({ key: forkKey, parentSessionKey: key, fork: true });

    expect(forked.ok, JSON.stringify(forked.error)).toBe(true);
    expect(readSession(storePath, forkKey)).toMatchObject({
      ...pinnedAccount(authProfileId),
      parentSessionKey: key,
    });
  });
});

test.each([
  ["trinity-large-thinking", "arcee:work", "user-link"],
  ["trinity-large-preview", undefined, undefined],
] as const)(
  "sessions.create applies an admin-linked Arcee default only to its direct endpoint: %s",
  async (modelId, expectedPin, expectedSource) => {
    await withSessionTestState(
      { layout: "state-only", prefix: "session-arcee-linked-default-" },
      async (state) => {
        const { ensureAuthProfileStoreWithoutExternalProfiles } =
          await import("../agents/auth-profiles/store-runtime.js");
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
                  modelDefinition(
                    modelId,
                    modelId.endsWith("thinking") ? { baseUrl: "https://api.arcee.ai/api/v1" } : {},
                  ),
                ],
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
        const { withPluginMetadataSnapshotScope } =
          await import("../plugins/current-plugin-metadata-snapshot.js");
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
            const owner = ensureProfileForEmail("arcee-session-owner@example.test");
            const client = {
              ...identifiedClient(owner.id, owner.displayName),
              connId: "arcee-session-owner-connection",
            };
            const clients = new Set([client]);
            const context = modelContext(
              cfg,
              [{ id: modelId, name: modelId, provider: "arcee" }],
              clients,
            );
            try {
              const links = setUserProfileAuthLink({
                profileId: owner.id,
                provider: "arcee",
                authProfileId: "arcee:work",
              });

              const key = `agent:main:dashboard:arcee-linked-${modelId}`;
              expect(loadSessionEntry({ sessionKey: key, storePath })).toBeUndefined();
              const selection = () => {
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
              const observedSelections: ReturnType<typeof selection>[] = [];
              const chatSend = vi.spyOn(chatSendOwner, "handleDirectExternalChatSend");
              chatSend.mockImplementation(async ({ respond }) => {
                observedSelections.push(selection());
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
                const expected = {
                  provider: "arcee",
                  model: modelId,
                  profile: expectedPin,
                  source: expectedSource,
                };
                expect.soft(observedSelections).toEqual([expected]);
                expect.soft(selection()).toEqual(expected);
                expect(
                  ensureAuthProfileStoreWithoutExternalProfiles(state.agentDir(), {
                    readOnly: true,
                  }).profiles["arcee:work"],
                ).toEqual(credential);
                expect(listUserProfileAuthLinks(owner.id)).toEqual(links);
                expect(JSON.parse(await fs.readFile(state.configPath, "utf8"))).toEqual(
                  inputConfig,
                );
              } finally {
                chatSend.mockRestore();
              }
            } finally {
              clients.clear();
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
    const { storePath, create } = await createPersonalAccountSessionFixture();
    const key = "agent:main:dashboard:unpinned-existing";
    await seedAccountSession(
      storePath,
      key,
      openaiSelection,
      "An existing shared-auth conversation",
      "unpinned-existing-session",
    );
    for (const fork of [false, true]) {
      const target = fork ? `${key}-fork` : key;
      const result = await create({
        key: target,
        ...(fork ? { parentSessionKey: key, fork: true } : {}),
      });
      expect(result.ok, JSON.stringify(result.error)).toBe(true);
      const entry = readSession(storePath, target);
      expect(entry).toMatchObject(openaiSelection);
      expect(entry?.authProfileOverride).toBeUndefined();
    }
  });
});

test.each(["foreign admin", "unidentified admin", "synthetic owner"] as const)(
  "sessions.create rejects a fresh personal account from a %s before worktree naming",
  async (kind) => {
    await withSessionTestState({ layout: "state-only" }, async (state) => {
      const workspace = await copyGitWorkspace(gitWorkspaceTemplate, state.root);
      testState.agentConfig = { workspace };
      const { storePath, authProfileId, client, context, create } =
        await createPersonalAccountSessionFixture();
      client.connect.scopes = ["operator.admin"];
      const key = "agent:main:dashboard:personal-denied-worktree";
      await seedAccountSession(storePath, key);
      await expect(
        directSessionReq("sessions.describe", { key }, { client, context }),
      ).resolves.toMatchObject({ ok: true });
      context.loadGatewayModelCatalogSnapshot.mockClear();
      const before = loadSessionEntry({ sessionKey: key, storePath });
      if (kind === "foreign admin") {
        const other = ensureProfileForEmail("session-other-person@example.test");
        client.authenticatedUserProfile = gatewayProfile(
          other.id,
          other.displayName,
          other.updatedAt,
        );
      } else if (kind === "unidentified admin") {
        delete client.authenticatedUserProfile;
      } else {
        client.internal = {
          syntheticClient: true,
          agentToolCaller: { agentId: "main", sessionKey: key },
        };
      }
      try {
        const created = await create({
          key,
          model: `openai/gpt-5.6-sol@${authProfileId}`,
          worktree: true,
        });

        expect(created).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
        expect(dashboardTitleGenerationMocks.generate).not.toHaveBeenCalled();
        expect(loadSessionEntry({ sessionKey: key, storePath })).toEqual(before);
        expect(await managedWorktrees.findLiveByOwner("session", key)).toBeUndefined();
      } finally {
        await removeSessionWorktree(key);
        testState.agentConfig = undefined;
      }
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
      create,
    } = await createPersonalAccountSessionFixture();
    const selectedAuthProfileId = connectAccount("next-account@example.test");
    client.connect.scopes = ["operator.admin"];
    const key = "agent:main:dashboard:personal-worktree-transition";
    await seedAccountSession(storePath, key, {
      ...openaiSelection,
      modelOverride: "gpt-5.6-luna",
      modelOverrideSource: "user",
      ...pinnedAccount(previousAuthProfileId),
    });
    let profileAtNaming: string | undefined;
    dashboardTitleGenerationMocks.generate.mockImplementationOnce(async () => {
      profileAtNaming = loadSessionEntry({ sessionKey: key, storePath })?.authProfileOverride;
      return "Account Transition";
    });
    try {
      const created = await create({
        key,
        model: `openai/gpt-5.6-sol@${selectedAuthProfileId}`,
        worktree: true,
      });

      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      expect(profileAtNaming).toBe(previousAuthProfileId);
      expect(dashboardTitleGenerationMocks.generate).toHaveBeenCalledWith(
        expect.objectContaining({
          regularModelRef: `openai/gpt-5.6-luna@${previousAuthProfileId}`,
          preferredProfile: previousAuthProfileId,
        }),
      );
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
