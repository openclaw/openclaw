import { describe, expect, onTestFinished, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import { markPreparedModelCatalogFull } from "../../agents/prepared-model-runtime.full-catalog.js";
import {
  chatMetadataCommandFields,
  createChatMetadataHarness as createHarness,
  createChatMetadataOwner,
  createDraftChatMetadataScope,
} from "./chat-metadata-runtime.test-support.js";

const savedSelection = () => ({
  authProfileOverride: "test:session",
  authProfileOverrideSource: "user" as const,
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

  test("invalidates models after same-snapshot owner replacement", async () => {
    const onChanged = vi.fn();
    const harness = createChatMetadataHarness(undefined, { onChanged });
    await harness.refresh();
    onChanged.mockClear();
    // Materialization publications can retain both the runtime and catalog objects.
    harness.runtime.invalidate();
    await harness.refresh();
    expect(onChanged).toHaveBeenCalledExactlyOnceWith({
      modelCatalogChanged: true,
      authChanged: true,
    });
  });

  test("single-flights equivalent refresh bursts and reads", async () => {
    const onChanged = vi.fn();
    const harness = createChatMetadataHarness(undefined, { onChanged });
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
    onChanged.mockClear();
    await Promise.all([harness.refresh(), harness.refresh({ notifyIfUnchanged: true })]);
    expect(onChanged).toHaveBeenCalledExactlyOnceWith({
      modelCatalogChanged: true,
      authChanged: false,
      commandsChanged: false,
    });
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
      harness.readProjection.mockClear();

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
          commands: [{ ...chatMetadataCommandFields, name: "command-1-1" }],
          swarmEnabled: true,
        });
        expect(first?.commandsRevision).toBe(compact.revision);
        expect(first?.metadata).not.toHaveProperty("models");
        expect(harness.readProjection).not.toHaveBeenCalled();
      }
      expect(harness.buildProjection).toHaveBeenCalledTimes(1);
      expect(coldReads.map((mock) => mock.mock.calls)).toEqual([[], [], [], []]);
      expect(harness.getAuthStoreRevision).toHaveBeenCalledWith("/tmp/first/agent");
      expect(harness.getAuthStoreRevision).toHaveBeenCalledWith(undefined);
    },
  );

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
    harness.readProjection.mockClear();
    const ready = await harness.startup(params);
    const startup = await canonical;
    expect(ready).toEqual({
      sessionModelCatalog: startup?.sessionModelCatalog,
      defaultModelCatalog: startup?.defaultModelCatalog,
    });
    expect(ready?.sessionModelCatalog).toBe(profileCatalog);
    expect(ready?.defaultModelCatalog).toEqual([expect.objectContaining({ id: "first" })]);
    expect(harness.readProjection).not.toHaveBeenCalled();
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

  test("reuses the prepared generation for equivalent config and auth revisions", async () => {
    const harness = await preparedHarness();
    const first = await harness.read();
    harness.getPreparedAuthStore.mockImplementation(() => ({ version: 1, profiles: {} }));
    harness.setConfig({ agents: { entries: { main: {} } } });
    await harness.refresh();
    const second = await harness.read();

    expect(second).toEqual(first);
    expect(harness.buildCommands).toHaveBeenCalledTimes(1);
    expect(harness.buildProjection).toHaveBeenCalledTimes(1);
    expect(harness.getAuthStoreRevision).toHaveBeenCalledWith("/tmp/first/agent");
    expect(harness.getAuthStoreRevision).toHaveBeenCalledWith(undefined);
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
      metadata: {
        commands: [{ ...chatMetadataCommandFields, name: "command-1-1" }],
        swarmEnabled: true,
      },
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
