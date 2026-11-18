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
  chatMetadataCommandFields,
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

  test("startup reads do not await a pending exact catalog projection", async () => {
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
    const canonical = harness.read({ sessionEntry });
    await vi.waitFor(() => expect(harness.buildProjection).toHaveBeenCalledTimes(2));
    let settled = false;
    const optional = harness.startup(params).then((value) => {
      expect(value).toBeUndefined();
      settled = true;
    });
    const startupSettled = vi.fn();
    const startupRead = harness.startup({ sessionEntry }).then((value) => {
      startupSettled(value);
      return value;
    });
    try {
      await vi.waitFor(() => expect(settled).toBe(true));
      await vi.waitFor(() => expect(startupSettled).toHaveBeenCalledOnce());
      expect(await startupRead).toMatchObject({ metadata: { commands: expect.any(Array) } });
      expect((await startupRead)?.sessionModelCatalog).toBeUndefined();
      expect((await startupRead)?.defaultModelCatalog).toBeUndefined();
      expect(harness.buildProjection).toHaveBeenCalledTimes(2);
    } finally {
      release.resolve();
      await Promise.all([canonical, optional, startupRead]);
    }
    const ready = await harness.startup(params);
    const startup = await harness.startup({ sessionEntry });
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

  test.each(["generation", "owner", "auth"] as const)(
    "omits startup metadata when its %s changes during command preparation",
    async (change) => {
      const harness = createChatMetadataHarness();
      let ownerCurrent = true;
      harness.setOwner({ ...harness.getPreparedOwner()!, isCurrent: () => ownerCurrent });
      await harness.refresh();
      const entered = createDeferred();
      const release = createDeferred();
      harness.buildCommands.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { commands: [] };
      });
      const startup = harness.startup({ sessionEntry: savedSelection() });
      try {
        await entered.promise;
        if (change === "generation") {
          harness.runtime.invalidate();
        } else if (change === "owner") {
          ownerCurrent = false;
        } else {
          harness.setAuthStoreRevision(2);
        }
      } finally {
        release.resolve();
      }
      await expect(startup).resolves.toBeUndefined();
      expect(harness.buildProjection).not.toHaveBeenCalled();
    },
  );

  test.each(["invalidate", "pending projection", "failed", "stale auth"] as const)(
    "ready reads omit projections after %s without starting replacement work",
    async (state) => {
      const harness = createChatMetadataHarness();
      const sessionEntry = { authProfileOverride: "test:session" };
      await harness.refresh();
      await harness.read();
      await harness.read({ sessionEntry });
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

  test("waits for replacement only for canonical metadata, including session auth projections", async () => {
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
    void read.then(settled, settled);
    await expect(harness.startup()).resolves.toBeUndefined();
    await expect(overriddenStartup).resolves.toBeUndefined();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    const nextConfig = { agents: { entries: { main: {} } }, tools: { swarm: { enabled: true } } };
    harness.setConfig(nextConfig);
    harness.setOwner(createChatMetadataOwner(nextConfig, "replacement"));
    await harness.refresh();

    await expect(read).resolves.toMatchObject({
      models: [{ id: "replacement" }],
      swarmEnabled: true,
    });
    const recoveredStartup = await harness.startup({ sessionEntry: savedSelection() });
    expect(recoveredStartup).toMatchObject({
      metadata: {
        commands: [{ ...chatMetadataCommandFields, name: "command-1-1" }],
        swarmEnabled: true,
      },
    });
    expect(recoveredStartup?.sessionModelCatalog).toBeUndefined();
    expect(harness.buildProjection).toHaveBeenCalledOnce();
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
