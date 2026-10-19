import { describe, expect, onTestFinished, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentCredentialMap } from "../../agents/agent-auth-credentials.js";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { setPreparedModelFullCatalogAuth } from "../../agents/prepared-model-runtime-auth.js";
import { markPreparedModelCatalogFull } from "../../agents/prepared-model-runtime.full-catalog.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createChatMetadataHarness as createHarness,
  createChatMetadataOwner,
  createDraftChatMetadataScope,
  createOpenAIChatMetadataConfig,
} from "./chat-metadata-runtime.test-support.js";

const savedSelection = () => ({
  authProfileOverride: "test:session",
  authProfileOverrideSource: "user" as const,
});
const credentials = (): AgentCredentialMap => ({
  openai: {
    type: "oauth",
    access: "prepared-access",
    refresh: "prepared-refresh",
    expires: Date.now() + 30 * 60_000,
  },
});
type Harness = ReturnType<typeof createChatMetadataHarness>;
function createChatMetadataHarness(...args: Parameters<typeof createHarness>) {
  const harness = createHarness(...args);
  onTestFinished(harness.runtime.stop);
  return harness;
}
const createProjection = (models: ModelCatalogSnapshot["entries"]) => ({
  modelCatalog: models,
  models,
});
async function preparedHarness() {
  const harness = createChatMetadataHarness();
  await harness.refresh();
  return harness;
}
function pauseProjection(harness: Harness, models?: ModelCatalogSnapshot["entries"]) {
  const entered = createDeferred();
  const release = createDeferred();
  harness.buildProjection.mockImplementationOnce(async ({ facts }) => {
    entered.resolve();
    await release.promise;
    return createProjection(models ?? facts.modelCatalog.entries);
  });
  return { entered, release };
}
function openaiFixture(config?: OpenClawConfig, id = "gpt-5.6-luna") {
  const harness = createChatMetadataHarness(config, { useDefaultProjection: true });
  const auth = credentials();
  const owner = createChatMetadataOwner(
    config ?? harness.getPreparedOwner()!.config,
    id,
    auth,
    "openai",
    "openai-chatgpt-responses",
  );
  return { harness, owner, auth };
}
async function expectModel(harness: Harness, model: Record<string, unknown>) {
  await expect(harness.read()).resolves.toMatchObject({ models: [model] });
}

describe("gateway chat metadata runtime", () => {
  test("retains an unsuperseded preparation failure without silently retrying", async () => {
    const failure = new Error("metadata preparation failed");
    const harness = createChatMetadataHarness();
    harness.getPreparedOwner.mockImplementation(() => {
      throw failure;
    });
    await expect(harness.refresh()).rejects.toBe(failure);
    await expect(harness.read()).rejects.toBe(failure);
    expect(harness.getPreparedOwner).toHaveBeenCalledOnce();
  });

  test("notifies once per publication, including owner recovery, without an unavailable-read loop", async () => {
    const onChanged = vi.fn();
    const harness = createChatMetadataHarness(undefined, { onChanged });
    await harness.refresh();
    expect(onChanged).toHaveBeenCalledOnce();
    onChanged.mockClear();
    harness.getPreparedOwner.mockReturnValue(undefined);
    await harness.refresh();
    for (let read = 0; read < 3; read += 1) {
      await expect(harness.read()).rejects.toThrow(
        'prepared chat metadata is unavailable for agent "main"',
      );
    }
    expect(onChanged).toHaveBeenCalledTimes(1);
    const recovered = createChatMetadataOwner({ agents: { entries: { main: {} } } }, "recovered");
    harness.setOwner(recovered);
    harness.getPreparedOwner.mockReturnValue(recovered);
    await harness.refresh();
    await expectModel(harness, { id: "recovered" });
    await harness.refresh();
    expect(onChanged).toHaveBeenCalledTimes(2);
    harness.runtime.invalidate();
    harness.runtime.fail(new Error("replacement failed"));
    await expect(harness.read()).rejects.toThrow("replacement failed");
    expect(onChanged.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [{ modelCatalogChanged: true, authChanged: true }]),
    );
  });

  test("invalidates models after same-snapshot owner replacement", async () => {
    const onChanged = vi.fn();
    const harness = createChatMetadataHarness(undefined, { onChanged });
    try {
      await harness.refresh();
      onChanged.mockClear();
      // Materialization publications can retain both the runtime and catalog objects.
      harness.runtime.invalidate();
      await harness.refresh();
      expect(onChanged).toHaveBeenCalledExactlyOnceWith({
        modelCatalogChanged: true,
        authChanged: true,
      });
    } finally {
      await harness.runtime.stop();
    }
  });

  test("prepares a projection lazily after its owner publishes", async () => {
    const harness = createChatMetadataHarness();

    await expect(harness.runtime.read({ agentId: "main" })).rejects.toThrow(
      "prepared chat metadata snapshot is unavailable",
    );
    await harness.runtime.refresh();
    expect(harness.buildProjection).not.toHaveBeenCalled();
    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "first" })],
    });

    expect(harness.buildProjection).toHaveBeenCalledOnce();
  });

  test("single-flights equivalent refresh bursts and reads", async () => {
    const harness = createChatMetadataHarness();
    const { release } = pauseProjection(harness);

    const refreshes = Array.from({ length: 128 }, () => harness.refresh());
    await Promise.all(refreshes);
    expect(harness.getPreparedOwner).toHaveBeenCalledTimes(1);
    expect(harness.buildProjection).not.toHaveBeenCalled();
    const firstRead = harness.read();
    const secondRead = harness.read();
    await vi.waitFor(() => expect(harness.buildProjection).toHaveBeenCalledTimes(1));
    expect(harness.buildCommands).toHaveBeenCalledTimes(1);

    release.resolve();
    const [first, second] = await Promise.all([firstRead, secondRead]);
    expect(first).toEqual(second);
    expect(harness.buildCommands).toHaveBeenCalledTimes(1);
    expect(harness.buildProjection).toHaveBeenCalledTimes(1);
  });

  test.each(["metadata", "startup"] as const)(
    "serves published %s with only auth revision reads",
    async (surface) => {
      const harness = await preparedHarness();
      await harness.read();
      const compact = await harness.read({ includeModels: false });
      const coldReads = [
        harness.getPreparedOwner,
        harness.getPreparedAuthStore,
        harness.getSkillsVersion,
        harness.getPluginRegistryVersion,
      ];
      coldReads.forEach((mock) => mock.mockClear());
      harness.getAuthStoreRevision.mockClear();

      if (surface === "metadata") {
        const first = await harness.read();
        expect(await harness.read()).toEqual(first);
      } else {
        const first = await harness.startup();
        expect(await harness.startup()).toEqual(first);
        expect(first?.sessionModelCatalog).toEqual([
          expect.objectContaining({ id: "first", provider: "test" }),
        ]);
        expect(first?.defaultModelCatalog).toBe(first?.sessionModelCatalog);
        expect(first?.metadata).toEqual({
          commands: [{ name: "command-1-1" }],
          swarmEnabled: true,
        });
        expect(first?.commandsRevision).toBe(compact.revision);
      }
      expect(harness.buildProjection).toHaveBeenCalledTimes(1);
      expect(coldReads.map((mock) => mock.mock.calls)).toEqual([[], [], [], []]);
      expect(harness.getAuthStoreRevision).toHaveBeenCalledWith("/tmp/first/agent");
      expect(harness.getAuthStoreRevision).toHaveBeenCalledWith(undefined);
    },
  );

  test("reads settled history and startup catalogs without serializing the model picker", async () => {
    const harness = createChatMetadataHarness();
    await harness.runtime.refresh();
    await harness.runtime.read({ agentId: "main" });
    harness.readProjection.mockClear();

    for (let read = 0; read < 3; read += 1) {
      const projection = await harness.runtime.readStartup({
        agentId: "main",
        readPolicy: "ready",
      });
      expect(projection?.sessionModelCatalog).toEqual([
        expect.objectContaining({ id: "first", provider: "test" }),
      ]);
      expect(projection?.defaultModelCatalog).toBe(projection?.sessionModelCatalog);
      expect(projection).not.toHaveProperty("metadata");
    }

    expect(harness.readProjection).not.toHaveBeenCalled();
    const startup = await harness.runtime.readStartup({ agentId: "main" });
    expect(startup?.metadata).toMatchObject({ commands: [{ name: "command-1-1" }] });
    expect(startup?.metadata).not.toHaveProperty("models");
    expect(harness.readProjection).not.toHaveBeenCalled();
  });

  test("ready reads never prepare or await a cold or pending exact profile", async () => {
    const harness = createChatMetadataHarness();
    const sessionEntry = savedSelection();
    const params = { agentId: "MAIN", sessionEntry, readPolicy: "ready" as const };
    await expect(harness.startup(params)).resolves.toBeUndefined();
    expect(harness.buildProjection).not.toHaveBeenCalled();
    await harness.refresh();
    await expect(harness.startup(params)).resolves.toBeUndefined();
    expect(harness.buildProjection).not.toHaveBeenCalled();
    await harness.read();

    const profileCatalog = [{ id: "profile-model", name: "Profile model", provider: "test" }];
    const { release } = pauseProjection(harness, profileCatalog);
    const canonical = harness.startup({ sessionEntry });
    await vi.waitFor(() => expect(harness.buildProjection).toHaveBeenCalledTimes(2));
    let settled = false;
    const optional = harness.startup(params).then((value) => {
      expect(value).toBeUndefined();
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(harness.buildProjection).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await Promise.all([canonical, optional]);
    }
    const ready = await harness.startup(params);
    const startup = await canonical;
    expect(ready).toEqual({
      sessionModelCatalog: startup?.sessionModelCatalog,
      defaultModelCatalog: startup?.defaultModelCatalog,
    });
    expect(ready?.sessionModelCatalog).toBe(profileCatalog);
    expect(ready?.defaultModelCatalog).toEqual([expect.objectContaining({ id: "first" })]);
    for (const other of [
      { ...params, agentId: "other" },
      { ...params, sessionEntry: { ...sessionEntry, authProfileOverride: "test:other" } },
      { ...params, sessionEntry: { ...sessionEntry, authProfileOverrideSource: "auto" as const } },
    ]) {
      await expect(harness.startup(other)).resolves.toBeUndefined();
    }
    expect(harness.buildProjection).toHaveBeenCalledTimes(2);
  });

  test.each(["neutral", "profile"] as const)(
    "ready reads omit an invalid %s wrapper until a canonical read refreshes it",
    async (invalid) => {
      const harness = createChatMetadataHarness();
      const sessionEntry = savedSelection();
      const params = { agentId: "main", sessionEntry };
      await harness.refresh();
      const initial = await harness.startup(params);
      const stale =
        await harness.buildProjection.mock.results[invalid === "neutral" ? 0 : 1]!.value;
      harness.invalidProjections.add(stale);

      await expect(harness.startup({ ...params, readPolicy: "ready" })).resolves.toBeUndefined();
      expect(harness.buildProjection).toHaveBeenCalledTimes(2);

      const replacement = [{ id: "replacement", name: "Replacement", provider: "test" }];
      harness.buildProjection.mockResolvedValueOnce(createProjection(replacement));
      const canonical = await harness.startup(params);
      expect(canonical).toMatchObject(
        invalid === "neutral"
          ? { defaultModelCatalog: replacement, sessionModelCatalog: initial?.sessionModelCatalog }
          : { defaultModelCatalog: initial?.defaultModelCatalog, sessionModelCatalog: replacement },
      );
      for (let read = 0; read < 2; read++) {
        await expect(harness.startup({ ...params, readPolicy: "ready" })).resolves.toEqual({
          sessionModelCatalog: canonical?.sessionModelCatalog,
          defaultModelCatalog: canonical?.defaultModelCatalog,
        });
      }
      expect(harness.buildProjection).toHaveBeenCalledTimes(3);
    },
  );

  test.each(["invalidate", "pending projection", "failed", "stale auth"] as const)(
    "ready reads omit projections after %s without starting replacement work",
    async (state) => {
      const harness = createChatMetadataHarness();
      const sessionEntry = { authProfileOverride: "test:session" };
      await harness.refresh();
      await harness.startup({ sessionEntry });
      const release = createDeferred();
      let reading: Promise<unknown> | undefined;
      if (state === "invalidate") {
        harness.runtime.invalidate();
      } else if (state === "failed") {
        harness.runtime.fail(new Error("owner unavailable"));
      } else if (state === "stale auth") {
        harness.setAuthStoreRevision(2);
      } else {
        const entered = createDeferred();
        harness.buildCommands.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return { commands: [] };
        });
        harness.runtime.invalidate();
        await harness.refresh();
        reading = harness.read();
        await entered.promise;
      }
      try {
        for (const entry of [undefined, sessionEntry]) {
          await expect(
            harness.startup({ agentId: "main", sessionEntry: entry, readPolicy: "ready" }),
          ).resolves.toBeUndefined();
        }
        expect(harness.buildProjection).toHaveBeenCalledTimes(2);
      } finally {
        release.resolve();
        await reading;
      }
    },
  );

  test("reuses the prepared generation for an equivalent config replacement", async () => {
    const harness = await preparedHarness();
    const first = await harness.read();

    harness.setConfig({ agents: { entries: { main: {} } } });
    await harness.refresh();
    const second = await harness.read();

    expect(second).toEqual(first);
    expect(harness.buildCommands).toHaveBeenCalledTimes(1);
    expect(harness.buildProjection).toHaveBeenCalledTimes(1);
  });

  test("rebuilds after an auth store publishes a newer revision", async () => {
    const harness = createChatMetadataHarness();
    harness.setAuthStore(undefined);
    harness.buildProjection.mockImplementation(async ({ facts }) => ({
      modelCatalog: facts.owner.modelCatalog.entries,
      models: facts.owner.modelCatalog.entries.map((model) => ({
        ...model,
        available: Object.keys(facts.authStore.profiles).length > 0,
      })),
    }));

    await harness.refresh();
    await expectModel(harness, { available: false });

    harness.setAuthStore({
      version: 1,
      profiles: { "test:default": { type: "api_key", provider: "test" } },
    });
    harness.setAuthStoreRevision(2);
    await harness.refresh();

    await expectModel(harness, { available: true });
    expect(harness.buildProjection).toHaveBeenCalledTimes(2);
  });

  test.each(["before", "after"] as const)(
    "converges to models.list availability when owner auth publishes %s attachment",
    async (publicationOrder) => {
      const { harness, owner: preparedOwner } = openaiFixture(undefined, "gpt-5.4");
      harness.setAuthStore({ version: 1, profiles: {} });

      if (publicationOrder === "before") {
        harness.setOwner(preparedOwner);
      } else {
        await harness.refresh();
        await expect(harness.read()).resolves.toMatchObject({ models: [] });
        harness.setOwner(preparedOwner);
      }

      await harness.refresh();
      await expectModel(harness, { id: "gpt-5.4", available: true });
    },
  );

  test("publishes hydrated marker-shaped credentials through the shared model projection", async () => {
    const sourceConfig = {
      agents: { defaults: { models: { "vllm/discovered": {} } } },
      models: {
        providers: {
          vllm: {
            baseUrl: "https://vllm.example/v1",
            apiKey: { source: "store", provider: "default", id: "CATALOG_KEY" },
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    const runtimeConfig: OpenClawConfig = {
      ...sourceConfig,
      models: {
        providers: { vllm: { ...sourceConfig.models.providers.vllm, apiKey: "ollama-local" } },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    const harness = createChatMetadataHarness(runtimeConfig, { useDefaultProjection: true });
    harness.setOwner(createChatMetadataOwner(runtimeConfig, "discovered", {}, "vllm"));
    try {
      await harness.refresh();
      await expectModel(harness, { id: "discovered", provider: "vllm", available: true });
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  test("keeps live provider discovery off chat metadata projection", async () => {
    const config = createOpenAIChatMetadataConfig();
    const harness = createChatMetadataHarness(config, { useDefaultProjection: true });
    const discoveryCredentials: AgentCredentialMap = {
      openai: {
        type: "oauth",
        access: "rejected-access-token",
        refresh: "rejected-refresh-token",
        expires: Date.now() + 30 * 60_000,
      },
    };
    const owner = createChatMetadataOwner(
      config,
      "gpt-5.6-luna",
      discoveryCredentials,
      "openai",
      "openai-chatgpt-responses",
    );
    const fullCatalog = {
      ...owner.modelCatalog,
      providerOutcomes: [{ provider: "openai", status: "auth-rejected" as const }],
    };
    const loadFullModelCatalog = vi.fn(async () => fullCatalog);
    harness.setOwner({
      ...owner,
      loadFullModelCatalog,
    });
    harness.setAuthStore({
      version: 1,
      profiles: {
        "openai:chatgpt": {
          type: "oauth",
          provider: "openai",
          access: "rejected-access-token",
          refresh: "rejected-refresh-token",
          expires: Date.now() + 30 * 60_000,
        },
      },
    });

    await harness.runtime.refresh();

    await expect(harness.runtime.read({ agentId: "main" })).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "gpt-5.6-luna", available: true })],
    });
    expect(loadFullModelCatalog).not.toHaveBeenCalled();
  });

  test("keeps a locked session unavailable while the neutral prepared route is usable", async () => {
    const { harness, owner } = openaiFixture(createOpenAIChatMetadataConfig());
    harness.setOwner(owner);
    harness.setAuthStore({ version: 1, profiles: {} });
    await harness.refresh();
    const sessionEntry = {
      authProfileOverride: "openai:missing-lock",
      authProfileOverrideSource: "user" as const,
    };
    await harness.startup({ sessionEntry });
    const scoped = await harness.read({ sessionEntry });
    expect(scoped.models).toEqual([
      expect.objectContaining({ available: false, unavailableReason: "auth-failed" }),
    ]);
    await expectModel(harness, { available: true });
  });

  test("adopts discovered wildcard models without restarting provider discovery", async () => {
    const config = createOpenAIChatMetadataConfig(["*", "gpt-5.6-luna"]);
    const { harness, owner, auth } = openaiFixture(config);
    const preparedAuthStore: AuthProfileStore = {
      version: 1,
      profiles: { "openai:prepared": { ...auth.openai!, provider: "openai" } },
    };
    harness.setAuthStore(preparedAuthStore);
    const dynamicModel = {
      id: "gpt-5.6-terra",
      name: "GPT-5.6 Terra",
      provider: "openai",
      api: "openai-chatgpt-responses" as const,
    };
    const fullCatalog = markPreparedModelCatalogFull({
      ...owner.modelCatalog,
      entries: [...owner.modelCatalog.entries, dynamicModel],
      routeVariants: [...owner.modelCatalog.routeVariants, dynamicModel],
    });
    setPreparedModelFullCatalogAuth(fullCatalog, {
      providerAuthLabels: new Map(),
      authStore: preparedAuthStore,
      authModes: owner.authModes,
    });
    let completedCatalog: ModelCatalogSnapshot | undefined;
    const generationOwner = {
      ...owner,
      readFullModelCatalog: () => completedCatalog,
      loadFullModelCatalog: vi.fn(async () => {
        completedCatalog = fullCatalog;
        return fullCatalog;
      }),
    };
    harness.setOwner(generationOwner);

    await harness.refresh();
    await expectModel(harness, { id: "gpt-5.6-luna", available: true });

    await generationOwner.loadFullModelCatalog();
    await harness.refresh();

    await expect(harness.read()).resolves.toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ id: "gpt-5.6-luna", available: true }),
        expect.objectContaining({ id: "gpt-5.6-terra", available: true }),
      ]),
    });
    expect(generationOwner.loadFullModelCatalog).toHaveBeenCalledOnce();
  });

  test("rejects a completed catalog without its matching prepared auth generation", async () => {
    const harness = createChatMetadataHarness();
    const owner = harness.getPreparedOwner()!;
    const unpairedCatalog = markPreparedModelCatalogFull({ ...owner.modelCatalog });
    harness.setOwner({ ...owner, readFullModelCatalog: () => unpairedCatalog });

    await expect(harness.refresh()).rejects.toThrow(
      "prepared full model catalog omitted its auth generation",
    );
  });

  test("retains a generation while auth store revisions are unchanged", async () => {
    const harness = createChatMetadataHarness();
    harness.getPreparedAuthStore.mockImplementation(() => ({ version: 1, profiles: {} }));
    await harness.runtime.refresh();
    const first = await harness.runtime.read({ agentId: "main" });

    await harness.runtime.refresh();
    const second = await harness.runtime.read({ agentId: "main" });

    expect(second).toEqual(first);
    expect(harness.buildProjection).toHaveBeenCalledTimes(1);
    expect(harness.getAuthStoreRevision).toHaveBeenCalledWith("/tmp/first/agent");
    expect(harness.getAuthStoreRevision).toHaveBeenCalledWith(undefined);
  });

  test("waits for replacement only for canonical metadata and session auth projections", async () => {
    const harness = await preparedHarness();

    harness.runtime.invalidate();
    const read = harness.read();
    const overriddenStartup = harness.startup({
      agentId: "main",
      sessionEntry: savedSelection(),
    });
    const draft = createDraftChatMetadataScope();
    const draftRead = harness.read(draft.params).catch((error: unknown) => error);
    draft.close();
    const settled = vi.fn();
    const overriddenSettled = vi.fn();
    void read.then(settled, settled);
    void overriddenStartup.then(overriddenSettled, overriddenSettled);
    await expect(harness.startup()).resolves.toBeUndefined();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(overriddenSettled).not.toHaveBeenCalled();

    const nextConfig = { agents: { entries: { main: {} } }, tools: { swarm: { enabled: true } } };
    harness.setConfig(nextConfig);
    harness.setOwner(createChatMetadataOwner(nextConfig, "replacement"));
    await harness.refresh();

    await expect(read).resolves.toMatchObject({
      models: [{ id: "replacement" }],
      swarmEnabled: true,
    });
    await expect(overriddenStartup).resolves.toMatchObject({
      metadata: { commands: [{ name: "command-1-1" }], swarmEnabled: true },
      sessionModelCatalog: [{ id: "replacement" }],
    });
    expect(await draftRead).toEqual(draft.error);
  });

  test("rejects closed draft authority after projection without poisoning shared metadata", async () => {
    const harness = await preparedHarness();
    const shared = await harness.read();
    const draft = createDraftChatMetadataScope();
    const { entered, release } = pauseProjection(harness);
    const reading = harness.read(draft.params).catch((error: unknown) => error);
    try {
      await Promise.race([entered.promise, reading]);
      draft.close();
    } finally {
      release.resolve();
    }
    expect(await reading).toEqual(draft.error);
    await expect(harness.read({ ...draft.params, includeModels: false })).rejects.toBe(draft.error);
    expect(await harness.read()).toEqual(shared);
  });

  test("rejects replacement waiters on failure and recovers on a later generation", async () => {
    const harness = await preparedHarness();

    harness.runtime.invalidate();
    const failedRead = harness.read();
    harness.runtime.fail(new Error("replacement failed"));
    await expect(failedRead).rejects.toThrow("replacement failed");
    await expect(harness.read()).rejects.toThrow("replacement failed");

    const nextConfig = { agents: { entries: { main: {} } } };
    harness.setConfig(nextConfig);
    harness.setOwner(createChatMetadataOwner(nextConfig, "recovered"));
    harness.runtime.invalidate();
    await harness.refresh();

    await expectModel(harness, { id: "recovered" });
  });

  test.each([
    ["buildCommands", "skill scan failed"],
    ["buildProjection", "startup projection failed"],
  ] as const)("recovers models after %s fails", async (phase, message) => {
    const harness = createChatMetadataHarness();
    harness[phase].mockRejectedValueOnce(new Error(message));
    await harness.refresh();
    if (phase === "buildProjection") {
      await expect(harness.read()).rejects.toThrow(message);
    }
    const metadata = await harness.read();
    expect(metadata.models).toEqual([expect.objectContaining({ id: "first" })]);
    if (phase === "buildCommands") {
      expect(metadata.commands).toBeUndefined();
    }
    expect(harness.buildProjection).toHaveBeenCalledTimes(phase === "buildProjection" ? 2 : 1);
  });
});
