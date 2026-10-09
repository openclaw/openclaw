import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  createPreparedRuntimeAuthProfileUsageReader,
  getRuntimeAuthProfileStoreMetadataRevision,
  setRuntimeAuthProfileStoreSnapshot,
} from "../../agents/auth-profiles/runtime-snapshots.js";
import { setPreparedModelFullCatalogAuth } from "../../agents/prepared-model-runtime-auth.js";
import { materializePreparedModelCatalog } from "../../agents/prepared-model-runtime.full-catalog.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { holdForeignWriter } from "../../infra/sqlite-worker-shared-state-admission.test-support.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import * as accountOperations from "../../state/user-model-account-operations.js";
import {
  clearUserProfileAuthLink,
  listUserProfileAuthLinks,
} from "../../state/user-model-accounts.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  connectChatMetadataAccount,
  createChatMetadataHarness,
  createChatMetadataOwner,
  createDraftChatMetadataScope,
  createPersonalChatMetadataFixture,
} from "./chat-metadata-runtime.test-support.js";
import { WITHOUT_OPENAI_ENV_AUTH } from "./models-list-result.openai-routes.test-support.js";

describe("gateway chat metadata personal accounts", () => {
  test("reads a startup account label while unrelated work occupies the state writer", async ({
    signal,
  }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const harness = createChatMetadataHarness();
      const owner = ensureProfileForEmail("startup-label@example.test");
      const authProfileId = connectChatMetadataAccount(owner.id);
      const request = {
        agentId: "main",
        sessionEntry: {
          authProfileOverride: authProfileId,
          authProfileOverrideSource: "user" as const,
        },
        readRequesterProfileId: () => owner.id,
      };
      const captured = captureOpenClawStateWorkerContext();
      const command = {
        type: "nativeHookRelay.write" as const,
        input: {
          record: {
            relayId: "startup-label-writer",
            pid: 1,
            hostname: "127.0.0.1" as const,
            port: 18789,
            token: "synthetic-startup-label-token",
            expiresAtMs: 20_000,
          },
          updatedAtMs: 1,
        },
      };
      const options = {
        createAdmission: () => ({
          nativeLocations: [captured.admission.databasePath],
          admission: createSqliteWorkerOperationAdmission((_request, grant) => {
            captured.admission.assertCurrent();
            grant();
          }),
        }),
      };
      await harness.runtime.refresh();
      await harness.runtime.readStartup(request);
      await runOpenClawStateWorkerOperation(captured, (scope) => scope.execute(command), options);
      const foreign = holdForeignWriter(captured);
      const queued = createDeferredCore();
      const write = runOpenClawStateWorkerOperation(
        captured,
        (scope) => {
          const pending = scope.execute(command);
          queued.resolve();
          return pending;
        },
        options,
      );
      const settlement = Promise.allSettled([write]);
      try {
        await withinTest(queued.promise, signal);
        expect(await withinTest(harness.runtime.readStartup(request), signal)).toMatchObject({
          metadata: {
            accountSelection: {
              kind: "personal",
              authProfileId,
              label: "Private provider account",
              source: "user",
            },
          },
        });
      } finally {
        foreign.release();
        await settlement;
        await harness.runtime.stop();
      }
      await expect(write).resolves.toBeUndefined();
    });
  });

  test("refuses a private account summary when its startup requester changes during the read", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const harness = createChatMetadataHarness();
      const owner = ensureProfileForEmail("owner@example.test");
      const viewer = ensureProfileForEmail("viewer@example.test");
      const authProfileId = connectChatMetadataAccount(owner.id);
      let requesterProfileId = owner.id;
      const readSummary = accountOperations.readUserModelAccountSummaryAsync;
      const summaryRead = vi
        .spyOn(accountOperations, "readUserModelAccountSummaryAsync")
        .mockImplementationOnce(async (...args) => {
          const summary = await readSummary(...args);
          requesterProfileId = viewer.id;
          return summary;
        });
      try {
        await harness.runtime.refresh();
        await expect(
          harness.runtime.readStartup({
            agentId: "main",
            sessionEntry: { authProfileOverride: authProfileId, authProfileOverrideSource: "user" },
            readRequesterProfileId: () => requesterProfileId,
          }),
        ).rejects.toThrow("Personal account changed while preparing its metadata");
      } finally {
        summaryRead.mockRestore();
        await harness.runtime.stop();
      }
    });
  });

  test("reads the startup requester after personal metadata preparation", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async () => {
      const harness = createChatMetadataHarness();
      const owner = ensureProfileForEmail("owner@example.test");
      const viewer = ensureProfileForEmail("viewer@example.test");
      const authProfileId = connectChatMetadataAccount(owner.id);
      let requesterProfileId = viewer.id;
      try {
        await harness.runtime.refresh();
        await harness.runtime.read({ agentId: "main" });
        harness.buildProjection.mockImplementationOnce(async ({ facts }) => {
          requesterProfileId = owner.id;
          return { modelCatalog: facts.modelCatalog.entries, models: facts.modelCatalog.entries };
        });
        await expect(
          harness.runtime.readStartup({
            agentId: "main",
            sessionEntry: { authProfileOverride: authProfileId, authProfileOverrideSource: "user" },
            readRequesterProfileId: () => requesterProfileId,
          }),
        ).resolves.toMatchObject({
          metadata: {
            accountSelection: {
              kind: "personal",
              authProfileId,
              label: "Private provider account",
              source: "user",
            },
          },
        });
      } finally {
        await harness.runtime.stop();
      }
    });
  });

  test("keeps persisted-session startup separate from personal defaults and draft previews", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "personal-chat-metadata-", env: WITHOUT_OPENAI_ENV_AUTH },
      async () => {
        const { harness, owner, alice, bob, aliceScope, bobScope } =
          await createPersonalChatMetadataFixture();
        const shared = await harness.runtime.read({ agentId: "main" });
        expect(await harness.runtime.read(aliceScope)).toEqual(shared);
        const aliceAuthId = connectChatMetadataAccount(alice.id);
        const available = {
          models: expect.arrayContaining([
            expect.objectContaining({ id: "gpt-5.6-luna", available: true }),
          ]),
        };
        await expect(harness.runtime.read(aliceScope)).resolves.toMatchObject(available);
        for (const selector of [
          { sessionKey: "agent:main:existing", sessionEntry: { sessionId: randomUUID() } },
          { sessionKey: "agent:main:missing" },
          { sessionEntry: { sessionId: randomUUID() } },
        ]) {
          const request = { ...aliceScope, ...selector };
          const metadata = (
            await harness.runtime.readStartup({
              ...request,
              readRequesterProfileId: () => request.requesterProfileId,
            })
          )?.metadata;
          expect(metadata).toEqual({
            ...shared,
            ...("sessionKey" in selector ? { runtimeSelectionLocked: false } : {}),
          });
        }
        expect(await harness.runtime.read(bobScope)).toEqual(shared);
        expect(await harness.runtime.read({ agentId: "main" })).toEqual(shared);

        const pinned = {
          ...bobScope,
          sessionEntry: {
            authProfileOverride: aliceAuthId,
            authProfileOverrideSource: "user-link" as const,
          },
        };
        await expect(
          harness.runtime.readStartup({ ...pinned, readRequesterProfileId: () => bob.id }),
        ).resolves.toMatchObject({
          metadata: available,
        });
        expect((await harness.runtime.read(pinned)).accountSelection).toEqual({
          kind: "personal",
          label: "Alice's account",
          source: "user-link",
        });
        const ownerView = await harness.runtime.readStartup({
          ...pinned,
          readRequesterProfileId: () => alice.id,
        });
        expect(ownerView?.metadata?.accountSelection).toEqual({
          kind: "personal",
          label: "Private provider account",
          authProfileId: aliceAuthId,
          source: "user-link",
        });
        clearUserProfileAuthLink({ profileId: alice.id, provider: "openai" });
        expect(await harness.runtime.read(aliceScope)).toEqual(shared);
        await expect(
          harness.runtime.read(createDraftChatMetadataScope(alice.id, aliceAuthId).params),
        ).resolves.toMatchObject({
          ...available,
          accountSelection: { kind: "personal", authProfileId: aliceAuthId, source: "user" },
        });
        expect(listUserProfileAuthLinks(alice.id)).toEqual([]);
        await expect(
          harness.runtime.readStartup({ ...pinned, readRequesterProfileId: () => bob.id }),
        ).resolves.toMatchObject({
          metadata: available,
        });

        connectChatMetadataAccount(bob.id);
        await expect(
          harness.runtime.read({
            ...pinned,
            sessionEntry: {
              ...pinned.sessionEntry,
              authProfileOverride: `personal:${alice.id}:${randomUUID()}`,
            },
          }),
        ).resolves.toMatchObject({
          models: [expect.objectContaining({ available: false })],
        });
        expect(harness.getPreparedAuthStore()?.profiles).toEqual({});
        expect(owner.authModes).toEqual({});
      },
    );
  });

  test.each(["user", "user-link"] as const)(
    "keeps a %s personal session pin available outside shared auth order",
    async (source) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "personal-pinned-metadata-", env: WITHOUT_OPENAI_ENV_AUTH },
        async () => {
          const { harness, owner, alice, bobScope } = await createPersonalChatMetadataFixture();
          const authProfileId = connectChatMetadataAccount(alice.id);
          const config = { ...owner.config, auth: { order: { openai: ["openai:shared"] } } };
          harness.setConfig(config);
          harness.setOwner({ ...owner, config });
          await harness.runtime.refresh();
          const request = {
            ...bobScope,
            sessionEntry: {
              authProfileOverride: authProfileId,
              authProfileOverrideSource: source,
            },
          };
          const available = {
            models: expect.arrayContaining([
              expect.objectContaining({ id: "gpt-5.6-luna", available: true }),
            ]),
          };
          await expect(harness.runtime.read(request)).resolves.toMatchObject(available);
          await expect(
            harness.runtime.readStartup({
              ...request,
              readRequesterProfileId: () => request.requesterProfileId,
            }),
          ).resolves.toMatchObject({
            metadata: available,
          });
          expect(harness.getPreparedAuthStore()?.profiles).toEqual({});
        },
      );
    },
  );
});

function createAuthHarnesses(authStore: AuthProfileStore, key: string) {
  const config: OpenClawConfig = {
    auth: { order: { acme: ["acme:primary"] } },
    agents: {
      defaults: { model: { primary: "acme/model" }, models: { "acme/model": {} } },
      entries: { main: {} },
    },
  };
  const owner = createChatMetadataOwner(
    config,
    "model",
    { acme: { type: "api_key", key } },
    "acme",
  );
  const cached = createChatMetadataHarness(config, { useDefaultProjection: true });
  const fresh = createChatMetadataHarness(config, { useDefaultProjection: true });
  for (const harness of [cached, fresh]) {
    harness.setOwner(owner);
    harness.setAuthStore(authStore);
  }
  return { cached, fresh };
}

describe("gateway chat metadata auth deadlines", () => {
  test("retains metadata on bookkeeping and reads cleared and renewed cooldowns from a full catalog", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const config: OpenClawConfig = {
      auth: { order: { acme: ["acme:primary"] } },
      agents: {
        defaults: { model: { primary: "acme/model" }, models: { "acme/model": {} } },
        entries: { main: {} },
      },
    };
    const prepared = createChatMetadataOwner(
      config,
      "model",
      { acme: { type: "api_key", key: "synthetic-key" } },
      "acme",
    );
    const original: AuthProfileStore = {
      version: 1,
      profiles: { "acme:primary": { type: "api_key", provider: "acme", key: "synthetic-key" } },
      usageStats: { "acme:primary": { cooldownUntil: 20_000 } },
    };
    setRuntimeAuthProfileStoreSnapshot(original, prepared.agentDir);
    setPreparedModelFullCatalogAuth(
      prepared.modelCatalog,
      {
        authStore: original,
        authModes: prepared.authModes,
        providerAuthLabels: new Map(),
      },
      createPreparedRuntimeAuthProfileUsageReader(prepared.agentDir, prepared.agentDir),
    );
    const fullCatalog = materializePreparedModelCatalog(prepared.modelCatalog, []);
    const owner = { ...prepared, readFullModelCatalog: () => fullCatalog };
    const onChanged = vi.fn();
    const harness = createChatMetadataHarness(config, {
      useDefaultProjection: true,
      onChanged,
    });
    harness.setOwner(owner);
    harness.getAuthStoreRevision.mockImplementation(getRuntimeAuthProfileStoreMetadataRevision);
    try {
      await harness.runtime.refresh();
      await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
        models: [{ id: "model", provider: "acme", available: false }],
      });
      setRuntimeAuthProfileStoreSnapshot(
        {
          ...original,
          usageStats: {
            "acme:primary": { cooldownUntil: 20_000, lastUsed: 10_000, errorCount: 2 },
          },
        },
        prepared.agentDir,
      );
      await harness.runtime.read({ agentId: "main" });
      expect(onChanged).toHaveBeenCalledOnce();
      for (const cooldownUntil of [undefined, 30_000]) {
        setRuntimeAuthProfileStoreSnapshot(
          {
            ...original,
            usageStats: cooldownUntil === undefined ? {} : { "acme:primary": { cooldownUntil } },
          },
          prepared.agentDir,
        );
        expect(
          await harness.runtime.readStartup({ agentId: "main", readPolicy: "ready" }),
        ).toBeUndefined();
        await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
          models: [{ id: "model", provider: "acme", available: cooldownUntil === undefined }],
        });
      }
      expect(onChanged).toHaveBeenCalledTimes(3);
      expect(harness.getPreparedAuthStore).not.toHaveBeenCalled();
      expect(original.usageStats).toEqual({ "acme:primary": { cooldownUntil: 20_000 } });
    } finally {
      await harness.runtime.stop();
      clearRuntimeAuthProfileStoreSnapshots();
      clock.mockRestore();
    }
  });

  test.each([{ at: 20_000, available: false }])(
    "reads a cached static token at $at without publication",
    async ({ at, available }) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
      const authStore: AuthProfileStore = {
        version: 1,
        profiles: {
          "acme:primary": {
            type: "token",
            provider: "acme",
            token: "synthetic-token",
            expires: 20_000,
          },
        },
      };
      const { cached, fresh } = createAuthHarnesses(authStore, "synthetic-token");
      try {
        await cached.runtime.refresh();
        await expect(cached.runtime.read({ agentId: "main" })).resolves.toMatchObject({
          models: [{ id: "model", provider: "acme", available: true }],
        });
        clock.mockReturnValue(at);
        await fresh.runtime.refresh();
        const expected = await fresh.runtime.read({ agentId: "main" });
        expect(expected).toMatchObject({
          models: [{ id: "model", provider: "acme", available }],
        });
        expect(await cached.runtime.read({ agentId: "main" })).toEqual(expected);
      } finally {
        await Promise.all([cached.runtime.stop(), fresh.runtime.stop()]);
        clock.mockRestore();
      }
    },
  );

  test.each([
    { name: "cooldown end", cooldownUntil: 20_000, at: 20_000, before: false, after: true },
  ])(
    "keeps cached metadata current at $name without publication",
    async ({ cooldownUntil, at, before, after }) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
      const authStore: AuthProfileStore = {
        version: 1,
        profiles: { "acme:primary": { type: "api_key", provider: "acme", key: "synthetic-key" } },
        usageStats: { "acme:primary": { cooldownUntil } },
      };
      const { cached, fresh } = createAuthHarnesses(authStore, "synthetic-key");
      try {
        await cached.runtime.refresh();
        await expect(cached.runtime.read({ agentId: "main" })).resolves.toMatchObject({
          models: [{ id: "model", provider: "acme", available: before }],
        });
        cached.getPreparedAuthStore.mockClear();
        clock.mockReturnValue(at);
        await fresh.runtime.refresh();
        const expected = await fresh.runtime.read({ agentId: "main" });
        expect(expected).toMatchObject({
          models: [{ id: "model", provider: "acme", available: after }],
        });
        expect(await cached.runtime.read({ agentId: "main" })).toEqual(expected);
        expect(cached.getPreparedAuthStore).not.toHaveBeenCalled();
        expect(cached.buildCommands).toHaveBeenCalledOnce();
      } finally {
        await Promise.all([cached.runtime.stop(), fresh.runtime.stop()]);
        clock.mockRestore();
      }
    },
  );
});
