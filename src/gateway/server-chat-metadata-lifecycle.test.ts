import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { RuntimeAuthProfileStore } from "../agents/auth-profiles/types.js";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.js";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  bumpSkillsSnapshotVersion,
  getSkillsSnapshotVersion,
  registerSkillsChangeListener,
  resetSkillsRefreshStateForTest,
} from "../skills/runtime/refresh-state.js";
import { writeSkill } from "../skills/test-support/e2e-test-helpers.js";
import { createChatMetadataOwner } from "./server-methods/chat-metadata-runtime.test-support.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";

const mocks = vi.hoisted(() => ({
  createRuntime: vi.fn(),
  fail: vi.fn(),
  invalidate: vi.fn(),
  read: vi.fn(),
  readStartup: vi.fn(),
  refreshPreparedModels: vi.fn(),
  refresh: vi.fn(),
  stop: vi.fn(),
  registerAuthListener: vi.fn(),
  registerModelListener: vi.fn(),
  registerSkillsListener: vi.fn(),
  unregisterAuthListener: vi.fn(),
  unregisterModelListener: vi.fn(),
  unregisterSkillsListener: vi.fn(),
}));

vi.mock("./server-methods/chat-metadata-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./server-methods/chat-metadata-runtime.js")>()),
  createGatewayChatMetadataRuntime: mocks.createRuntime,
}));
vi.mock("../agents/auth-profiles/runtime-snapshots.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/auth-profiles/runtime-snapshots.js")>()),
  registerRuntimeAuthProfileStoreMutationListener: mocks.registerAuthListener,
}));
vi.mock("../agents/prepared-model-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/prepared-model-runtime.js")>()),
  refreshPreparedModelRuntimeSnapshots: mocks.refreshPreparedModels,
  registerPreparedModelRuntimePublicationListener: mocks.registerModelListener,
}));
vi.mock("../skills/runtime/refresh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills/runtime/refresh.js")>()),
  registerSkillsChangeListener: mocks.registerSkillsListener,
}));

const { createGatewayChatMetadataLifecycle } = await import("./server-chat-metadata-lifecycle.js");
const { ChatMetadataSnapshotUnavailableError } =
  await import("./server-methods/chat-metadata-runtime.js");
const authSnapshots = await vi.importActual<
  typeof import("../agents/auth-profiles/runtime-snapshots.js")
>("../agents/auth-profiles/runtime-snapshots.js");

const config = {} as OpenClawConfig;
const context = {} as GatewayRequestContext;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.createRuntime.mockReturnValue({
    fail: mocks.fail,
    invalidate: mocks.invalidate,
    read: mocks.read,
    readStartup: mocks.readStartup,
    refresh: mocks.refresh,
    stop: mocks.stop,
  });
  mocks.refresh.mockResolvedValue(undefined);
  mocks.registerAuthListener.mockReturnValue(mocks.unregisterAuthListener);
  mocks.registerModelListener.mockReturnValue(mocks.unregisterModelListener);
  mocks.registerSkillsListener.mockReturnValue(mocks.unregisterSkillsListener);
});

function createLifecycle(minimalTestGateway: boolean, warn = vi.fn()) {
  return {
    lifecycle: createGatewayChatMetadataLifecycle({
      getConfig: () => config,
      minimalTestGateway,
      log: { warn } as never,
    }),
    sidecarOwner: createGatewaySidecarStopOwner(),
    warn,
  };
}

async function createRealMetadataLifecycle(
  options: {
    attach?: boolean;
    ownerAvailable?: boolean;
    authStore?: RuntimeAuthProfileStore;
    skillsWorkspaceDir?: string;
  } = {},
) {
  const actual = await vi.importActual<typeof import("./server-methods/chat-metadata-runtime.js")>(
    "./server-methods/chat-metadata-runtime.js",
  );
  let owner = createChatMetadataOwner(config, "before-publication");
  let ownerAvailable = options.ownerAvailable ?? true;
  let revision = 0;
  let latestRefresh = Promise.resolve();
  const refresh = vi.fn<() => Promise<void>>();
  const buildCommands = vi.fn(async () => ({ commands: [] }));
  const broadcast = vi.fn();
  if (options.skillsWorkspaceDir) {
    owner = { ...owner, workspaceDir: options.skillsWorkspaceDir };
    mocks.registerSkillsListener.mockImplementation(registerSkillsChangeListener);
  }
  if (options.authStore) {
    authSnapshots.setRuntimeAuthProfileStoreSnapshot(options.authStore, owner.agentDir);
    mocks.registerAuthListener.mockImplementation(
      authSnapshots.registerRuntimeAuthProfileStoreMutationListener,
    );
  }
  mocks.createRuntime.mockImplementation(
    (params: Parameters<typeof actual.createGatewayChatMetadataRuntime>[0]) => {
      const runtime = actual.createGatewayChatMetadataRuntime({
        ...params,
        deps: {
          getPreparedOwner: () => (ownerAvailable ? owner : undefined),
          ...(options.authStore
            ? { getPreparedAuthStore: authSnapshots.getPreparedRuntimeAuthProfileStoreSnapshotCore }
            : {
                getPreparedAuthStore: () => ({ version: 1, profiles: {} }),
                getAuthStoreRevision: () => revision,
              }),
          getSkillsVersion: options.skillsWorkspaceDir ? getSkillsSnapshotVersion : () => 0,
          getPluginRegistryVersion: () => 0,
          buildCommands,
          buildProjection: async ({ facts }) => ({
            modelCatalog: facts.modelCatalog.entries,
            read: () => ({ models: facts.modelCatalog.entries }),
            isCurrent: () => true,
          }),
        },
      });
      refresh.mockImplementation(() => {
        latestRefresh = runtime.refresh();
        return latestRefresh;
      });
      return { ...runtime, refresh };
    },
  );
  const { lifecycle: pendingLifecycle, sidecarOwner, warn } = createLifecycle(false);
  const lifecycle = await pendingLifecycle;
  const attach = () =>
    lifecycle.attachContext(
      { broadcast } as unknown as GatewayRequestContext,
      sidecarOwner.publish,
    );
  if (options.attach !== false) {
    await attach();
  }
  const modelEvent = (event: { phase: string; error?: Error; modelFactsChanged?: boolean }) =>
    mocks.registerModelListener.mock.calls[0]![0](event);
  const authEvent = () => mocks.registerAuthListener.mock.calls[0]![0]();
  return {
    lifecycle,
    attach,
    buildCommands,
    broadcast,
    refresh,
    publishAuthStore(store: RuntimeAuthProfileStore) {
      authSnapshots.updateRuntimeAuthProfileStoreSnapshot(store, owner.agentDir);
      return latestRefresh;
    },
    warn,
    modelEvent,
    queueRefresh(stage: "queued" | "building") {
      const entered = createDeferred();
      const release = createDeferred();
      if (stage === "building") {
        buildCommands.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return { commands: [] };
        });
      }
      revision += 1;
      authEvent();
      const reading =
        stage === "building" ? lifecycle.read({ agentId: "main" }).catch(() => {}) : undefined;
      return {
        entered: stage === "building" ? entered.promise : Promise.resolve(),
        release: () => release.resolve(),
        obsolete: latestRefresh,
        reading,
      };
    },
    replaceOwner() {
      owner = createChatMetadataOwner(config, "after-publication");
      ownerAvailable = true;
      modelEvent({ phase: "published" });
    },
    invalidateOwner() {
      ownerAvailable = false;
      modelEvent({ phase: "invalidated" });
    },
    events: {
      skills: () => mocks.registerSkillsListener.mock.calls[0]![0](),
      auth: () => authEvent(),
      catalog: () => modelEvent({ phase: "catalog-published" }),
      catalogFailure: () =>
        modelEvent({ phase: "catalog-failed", error: new Error("catalog failed") }),
      owner: () => modelEvent({ phase: "invalidated" }),
    },
    async stop() {
      await sidecarOwner.stop();
      if (options.authStore) {
        authSnapshots.clearRuntimeAuthProfileStoreSnapshotCore(owner.agentDir);
      }
    },
  };
}

describe("gateway chat metadata lifecycle", () => {
  it("does not refresh metadata for identical skills rebuilds but publishes instruction changes", async () => {
    const { loadWorkspaceSkills } = await import("../skills/loading/workspace-skill-loader.js");
    resetSkillsRefreshStateForTest();
    const workspaceDir = tempDirs.make("chat-metadata-skills-");
    const skillDir = path.join(workspaceDir, "skills", "demo");
    await writeSkill({ dir: skillDir, name: "demo", description: "Demo", body: "Original body" });
    const loadOptions = { workspaceOnly: true };
    const entries = loadWorkspaceSkills(workspaceDir, loadOptions);
    const version = getSkillsSnapshotVersion(workspaceDir);
    const harness = await createRealMetadataLifecycle({ skillsWorkspaceDir: workspaceDir });
    try {
      const before = await harness.lifecycle.read({ agentId: "main" });
      harness.refresh.mockClear();
      harness.broadcast.mockClear();
      for (let count = 0; count < 3; count += 1) {
        bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
        expect(loadWorkspaceSkills(workspaceDir, loadOptions)).toEqual(entries);
        expect(getSkillsSnapshotVersion(workspaceDir)).toBe(version);
        expect(await harness.lifecycle.read({ agentId: "main" })).toEqual(before);
      }
      expect(harness.refresh).not.toHaveBeenCalled();
      expect(harness.broadcast).not.toHaveBeenCalled();
      expect(harness.buildCommands).toHaveBeenCalledOnce();

      await fs.appendFile(path.join(skillDir, "SKILL.md"), "\nChanged instructions\n");
      bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
      await harness.lifecycle.read({ agentId: "main" });
      expect(getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(version);
      expect(harness.refresh).toHaveBeenCalledOnce();
      expect(harness.buildCommands).toHaveBeenCalledTimes(2);
      expect(harness.broadcast).toHaveBeenCalledExactlyOnceWith(
        "chat.metadata.changed",
        {},
        { dropIfSlow: true },
      );
    } finally {
      await harness.stop();
      resetSkillsRefreshStateForTest();
    }
  });

  it.each([false, true])(
    "keeps bookkeeping from refreshing or broadcasting metadata (inherited: %s)",
    async (inherited) => {
      const store: RuntimeAuthProfileStore = {
        version: 1,
        profiles: { "test:primary": { type: "token", provider: "test", token: "synthetic-token" } },
      };
      const harness = await createRealMetadataLifecycle({ authStore: store });
      try {
        const before = await harness.lifecycle.read({ agentId: "main" });
        harness.refresh.mockClear();
        harness.broadcast.mockClear();
        for (let count = 1; count <= 3; count += 1) {
          await harness.publishAuthStore({
            ...store,
            ...(inherited ? { runtimeInheritsMainState: true } : {}),
            lastGood: { test: "test:primary" },
            usageStats: {
              "test:primary": {
                lastUsed: count,
                errorCount: count,
                failureCounts: { timeout: count },
                lastFailureAt: count,
                lastProbeAt: count,
              },
            },
          });
          expect(harness.refresh).not.toHaveBeenCalled();
          harness.events.catalog();
          expect(await harness.lifecycle.read({ agentId: "main" })).toEqual(before);
          harness.refresh.mockClear();
        }
        expect(harness.buildCommands).toHaveBeenCalledOnce();
        expect(harness.broadcast).not.toHaveBeenCalled();
      } finally {
        await harness.stop();
      }
    },
  );

  it.each<{ name: string; change: Partial<RuntimeAuthProfileStore> }>([
    {
      name: "profile added",
      change: {
        profiles: {
          "test:primary": { type: "token", provider: "test", token: "synthetic-token" },
          "test:second": { type: "api_key", provider: "test", key: "synthetic-key" },
        },
      },
    },
    { name: "profile removed", change: { profiles: {} } },
    {
      name: "token rotated",
      change: {
        profiles: { "test:primary": { type: "token", provider: "test", token: "rotated-token" } },
      },
    },
    {
      name: "expiry changed",
      change: {
        profiles: {
          "test:primary": {
            type: "token",
            provider: "test",
            token: "synthetic-token",
            expires: 50_000,
          },
        },
      },
    },
    {
      name: "cooldown started",
      change: { usageStats: { "test:primary": { cooldownUntil: 50_000 } } },
    },
    { name: "blocked", change: { usageStats: { "test:primary": { blockedUntil: 50_000 } } } },
    {
      name: "inline key disabled",
      change: {
        usageStats: { "inline-api-key:test": { disabledUntil: 50_000, disabledReason: "billing" } },
      },
    },
  ])("refreshes and broadcasts metadata when $name", async ({ change }) => {
    const store: RuntimeAuthProfileStore = {
      version: 1,
      profiles: { "test:primary": { type: "token", provider: "test", token: "synthetic-token" } },
    };
    const harness = await createRealMetadataLifecycle({ authStore: store });
    try {
      await harness.lifecycle.read({ agentId: "main" });
      harness.refresh.mockClear();
      harness.broadcast.mockClear();
      await harness.publishAuthStore({ ...store, ...change });
      expect(harness.refresh).toHaveBeenCalledOnce();
      expect(harness.broadcast).toHaveBeenCalledExactlyOnceWith(
        "chat.metadata.changed",
        {},
        { dropIfSlow: true },
      );
      await harness.lifecycle.read({ agentId: "main" });
      expect(harness.buildCommands).toHaveBeenCalledTimes(2);
      await harness.publishAuthStore(store);
      expect(harness.broadcast).toHaveBeenCalledTimes(2);
    } finally {
      await harness.stop();
    }
  });

  it("does not rebuild or broadcast unchanged metadata after unrelated skill and catalog events", async () => {
    const harness = await createRealMetadataLifecycle();
    try {
      const before = await harness.lifecycle.read({ agentId: "main" });
      for (let event = 0; event < 14; event += 1) {
        harness.events.skills();
        harness.events.catalog();
        expect(await harness.lifecycle.read({ agentId: "main" })).toEqual(before);
      }
      expect(harness.buildCommands).toHaveBeenCalledOnce();
      expect(harness.broadcast).toHaveBeenCalledOnce();
    } finally {
      await harness.stop();
    }
  });

  it.each(["queued", "building"] as const)(
    "keeps readers waiting when %s metadata refresh is superseded by owner publication",
    async (stage) => {
      const harness = await createRealMetadataLifecycle();
      const queued = harness.queueRefresh(stage);
      let read: Promise<unknown> | undefined;
      try {
        await queued.entered;
        harness.invalidateOwner();
        let settled = false;
        read = harness.lifecycle.read({ agentId: "main" }).then(
          (value) => {
            settled = true;
            return value;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
        queued.release();
        await queued.obsolete.catch(() => undefined);
        await nextEventLoopTurn();

        expect(harness.warn).not.toHaveBeenCalled();
        expect(settled).toBe(false);
        harness.replaceOwner();
        await expect(read).resolves.toMatchObject({
          models: [expect.objectContaining({ id: "after-publication" })],
        });
      } finally {
        queued.release();
        await harness.stop();
        await Promise.all([read, queued.reading]);
      }
    },
  );

  it.each(["skills", "auth", "catalog", "catalogFailure", "owner"] as const)(
    "retains a terminal metadata failure through a later %s invalidation",
    async (event) => {
      const harness = await createRealMetadataLifecycle();
      const failure = new Error("prepared owner publication failed");
      let read: Promise<void> | undefined;
      try {
        harness.invalidateOwner();
        harness.modelEvent({ phase: "failed", error: failure });
        await expect(harness.lifecycle.read({ agentId: "main" })).rejects.toBe(failure);
        harness.events[event]();
        let outcome: unknown = Symbol("pending");
        read = harness.lifecycle.read({ agentId: "main" }).then(
          (value) => {
            outcome = value;
          },
          (error: unknown) => {
            outcome = error;
          },
        );
        await nextEventLoopTurn();

        expect(outcome).toBe(failure);
        harness.replaceOwner();
        await expect(harness.lifecycle.read({ agentId: "main" })).resolves.toMatchObject({
          models: [expect.objectContaining({ id: "after-publication" })],
        });
      } finally {
        await harness.stop();
        await read;
      }
    },
  );

  it("publishes initial facts before agent work and fences its read during owner replacement", async () => {
    const harness = await createRealMetadataLifecycle({ attach: false });
    const entered = createDeferred();
    const release = createDeferred();
    harness.buildCommands.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { commands: [] };
    });
    await harness.attach();
    let read: Promise<unknown> | undefined;
    try {
      let settled = false;
      read = harness.lifecycle.read({ agentId: "main" }).then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await entered.promise;
      harness.invalidateOwner();
      release.resolve();
      await nextEventLoopTurn();
      expect(settled).toBe(false);
      expect(harness.warn).not.toHaveBeenCalled();
      harness.replaceOwner();
      await expect(read).resolves.toMatchObject({
        models: [expect.objectContaining({ id: "after-publication" })],
      });
    } finally {
      release.resolve();
      await harness.stop();
      await read;
    }
  });

  it("waits for first publication after an initial missing-owner catch-up", async () => {
    const harness = await createRealMetadataLifecycle({ attach: false, ownerAvailable: false });
    let read: Promise<unknown> | undefined;
    try {
      await harness.attach();
      await expect(harness.lifecycle.read({ agentId: "main" })).rejects.toBeInstanceOf(
        ChatMetadataSnapshotUnavailableError,
      );
      harness.modelEvent({ phase: "invalidated" });
      let settled = false;
      read = harness.lifecycle.read({ agentId: "main" }).then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await nextEventLoopTurn();
      expect(settled).toBe(false);
      harness.replaceOwner();
      await expect(read).resolves.toMatchObject({
        models: [expect.objectContaining({ id: "after-publication" })],
      });
    } finally {
      await harness.stop();
      await read;
    }
  });

  it("broadcasts settled metadata through the production lifecycle without a failure feedback loop", async () => {
    const actual = await vi.importActual<
      typeof import("./server-methods/chat-metadata-runtime.js")
    >("./server-methods/chat-metadata-runtime.js");
    const owner: PreparedModelRuntimeSnapshot = {
      catalogOwner: { agentId: "main", workspaceDir: "/tmp/metadata-lifecycle/workspace" },
      agentId: "main",
      agentDir: "/tmp/metadata-lifecycle/agent",
      workspaceDir: "/tmp/metadata-lifecycle/workspace",
      activeProjectKeys: [],
      config,
      observationConfig: config,
      isCurrent: () => true,
      authModes: {},
      metadataSnapshot: createPluginMetadataSnapshot({
        config,
        manifestRegistry: { plugins: [], diagnostics: [] },
      }),
      allowGatewaySubagentBinding: false,
      modelCatalog: {
        entries: [{ id: "model", name: "Model", provider: "test" }],
        routeVariants: [],
      },
      configuredRuntimeModels: [],
      findConfiguredRuntimeModel: () => undefined,
      inlineProviderModels: [],
      createStores: () => {
        throw new Error("metadata must not create live model stores");
      },
    };
    const getPreparedOwner = vi.fn<() => PreparedModelRuntimeSnapshot | undefined>();
    let available = false;
    let revision = 0;
    const buildProjection = vi.fn(async () => {
      const projection = {
        modelCatalog: owner.modelCatalog.entries,
        models: [{ ...owner.modelCatalog.entries[0], available }],
      };
      return { read: () => projection, isCurrent: () => true };
    });
    mocks.createRuntime.mockImplementation((params) =>
      actual.createGatewayChatMetadataRuntime({
        ...params,
        deps: {
          getPreparedOwner,
          getPreparedAuthStore: () => ({ version: 1, profiles: {} }),
          getAuthStoreRevision: () => revision,
          getSkillsVersion: () => 0,
          getPluginRegistryVersion: () => 0,
          buildCommands: async () => ({ commands: [] }),
          buildProjection,
        },
      }),
    );
    const { lifecycle: pendingLifecycle, sidecarOwner } = createLifecycle(false);
    const lifecycle = await pendingLifecycle;
    const outcomes: unknown[] = [];
    const reads: Promise<void>[] = [];
    const broadcast = vi.fn(() => {
      // Read immediately from the outbound boundary: the replacement must already be settled.
      reads.push(
        lifecycle.read({ agentId: "main" }).then(
          (metadata) => {
            outcomes.push(metadata.models);
          },
          (error: unknown) => {
            outcomes.push(error instanceof Error ? error.message : error);
          },
        ),
      );
    });
    await lifecycle.attachContext(
      { broadcast } as unknown as GatewayRequestContext,
      sidecarOwner.publish,
    );
    await Promise.all(reads);
    expect(outcomes).toEqual([expect.stringContaining("owner is unavailable")]);
    expect(broadcast).toHaveBeenCalledOnce();
    getPreparedOwner.mockReturnValue(owner);
    const modelListener = mocks.registerModelListener.mock.calls[0]![0];
    const authListener = mocks.registerAuthListener.mock.calls[0]![0];
    modelListener({ phase: "published" });
    await vi.waitFor(() => expect(outcomes).toHaveLength(2));
    expect(outcomes[1]).toEqual([expect.objectContaining({ available: false })]);

    modelListener({ phase: "invalidated" });
    available = true;
    revision += 1;
    authListener();
    expect(broadcast).toHaveBeenCalledTimes(2);
    modelListener({ phase: "published" });
    await vi.waitFor(() => expect(outcomes).toHaveLength(3));
    expect(outcomes[2]).toEqual([expect.objectContaining({ available: true })]);

    available = false;
    revision += 1;
    authListener();
    await vi.waitFor(() => expect(outcomes).toHaveLength(4));
    expect(outcomes[3]).toEqual([expect.objectContaining({ available: false })]);

    const gate = createDeferred();
    buildProjection.mockImplementationOnce(async () => {
      await gate.promise;
      throw new Error("superseded projection");
    });
    revision += 1;
    authListener();
    await vi.waitFor(() => expect(buildProjection).toHaveBeenCalledTimes(4));
    modelListener({ phase: "invalidated" });
    available = true;
    revision += 1;
    modelListener({ phase: "published" });
    gate.resolve();
    await vi.waitFor(() => expect(outcomes).toHaveLength(6));
    expect(outcomes.slice(4)).toEqual([
      [expect.objectContaining({ available: true })],
      [expect.objectContaining({ available: true })],
    ]);

    modelListener({ phase: "invalidated" });
    modelListener({ phase: "failed", error: new Error("owner publication failed") });
    await Promise.all(reads);
    await expect(lifecycle.read({ agentId: "main" })).rejects.toThrow("owner publication failed");
    expect(outcomes[6]).toBe("owner publication failed");
    expect(broadcast.mock.calls).toEqual(
      Array.from({ length: 7 }, () => ["chat.metadata.changed", {}, { dropIfSlow: true }]),
    );
  });

  it.each([true, false])(
    "joins pending metadata work before Gateway lifetime shutdown (minimal=%s)",
    async (minimalTestGateway) => {
      const actual = await vi.importActual<
        typeof import("./server-methods/chat-metadata-runtime.js")
      >("./server-methods/chat-metadata-runtime.js");
      const entered = createDeferred();
      const release = createDeferred();
      const events: string[] = [];
      const owner = createChatMetadataOwner(config, "shutdown-model");
      let ownerAvailable = true;
      let revision = 0;
      let held = false;
      const holdWork = async () => {
        if (held) {
          entered.resolve();
          await release.promise;
          events.push("work settled");
        }
      };
      mocks.refreshPreparedModels.mockImplementation(holdWork);
      const buildProjection = vi.fn(async () => {
        if (!minimalTestGateway) {
          await holdWork();
        }
        return {
          modelCatalog: owner.modelCatalog.entries,
          read: () => ({ models: owner.modelCatalog.entries }),
          isCurrent: () => true,
        };
      });
      mocks.createRuntime.mockImplementation(
        (params: Parameters<typeof actual.createGatewayChatMetadataRuntime>[0]) =>
          actual.createGatewayChatMetadataRuntime({
            ...params,
            deps: {
              getPreparedOwner: () => (ownerAvailable ? owner : undefined),
              getPreparedAuthStore: () => ({ version: 1, profiles: {} }),
              getAuthStoreRevision: () => revision,
              getSkillsVersion: () => 0,
              getPluginRegistryVersion: () => 0,
              buildCommands: async () => ({ commands: [] }),
              buildProjection,
            },
          }),
      );
      const {
        lifecycle: pendingLifecycle,
        sidecarOwner,
        warn,
      } = createLifecycle(minimalTestGateway);
      const lifecycle = await pendingLifecycle;
      const broadcast = vi.fn();
      await lifecycle.attachContext(
        { broadcast } as unknown as GatewayRequestContext,
        sidecarOwner.publish,
      );
      held = true;
      revision += 1;
      if (!minimalTestGateway) {
        mocks.registerModelListener.mock.calls[0]![0]({ phase: "published" });
      }
      const read = lifecycle.read({ agentId: "main" }).then(
        (result) => {
          events.push("read settled");
          return result;
        },
        (error: unknown) => {
          events.push("read settled");
          return error;
        },
      );
      try {
        await entered.promise;
        const stopping = sidecarOwner.stop().then(() => {
          ownerAvailable = false;
          events.push("shutdown completed");
        });
        release.resolve();
        await stopping;
        const result = await read;

        expect(events).toEqual(["work settled", "read settled", "shutdown completed"]);
        expect(result).toBeInstanceOf(ChatMetadataSnapshotUnavailableError);
        await expect(lifecycle.read({ agentId: "main" })).rejects.toThrow("stopped");
        await expect(lifecycle.refresh()).rejects.toThrow("stopped");
        await expect(lifecycle.readStartup({ agentId: "main" })).resolves.toBeUndefined();
        expect(warn).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await read;
      }
    },
  );

  it("keeps minimal Gateway attachment lazy while owning shutdown", async () => {
    const { lifecycle: pendingLifecycle, sidecarOwner } = createLifecycle(true);
    const lifecycle = await pendingLifecycle;

    await lifecycle.attachContext(context, sidecarOwner.publish);

    expect(mocks.createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeRefresh: expect.any(Function),
        refreshOnRead: true,
      }),
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.registerAuthListener).not.toHaveBeenCalled();
    expect(mocks.registerModelListener).not.toHaveBeenCalled();
    expect(mocks.registerSkillsListener).not.toHaveBeenCalled();
    expect(sidecarOwner.snapshot()).toHaveLength(1);
    await sidecarOwner.stop();
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it("treats an unavailable catch-up snapshot as expected before owner publication", async () => {
    mocks.refresh.mockRejectedValueOnce(new ChatMetadataSnapshotUnavailableError());
    const { lifecycle: pendingLifecycle, sidecarOwner, warn } = createLifecycle(false);
    const lifecycle = await pendingLifecycle;

    await lifecycle.attachContext(context, sidecarOwner.publish);

    expect(mocks.registerAuthListener).toHaveBeenCalledOnce();
    expect(mocks.registerModelListener).toHaveBeenCalledOnce();
    expect(mocks.registerSkillsListener).toHaveBeenCalledOnce();
    expect(sidecarOwner.snapshot()).toHaveLength(1);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();

    const listener = mocks.registerModelListener.mock.calls[0]?.[0];
    expect(listener).toEqual(expect.any(Function));
    listener({ phase: "published" });

    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
  });

  it("logs unexpected catch-up failures without rejecting startup", async () => {
    mocks.refresh.mockRejectedValueOnce(new Error("metadata unavailable"));
    const { lifecycle: pendingLifecycle, sidecarOwner, warn } = createLifecycle(false);
    const lifecycle = await pendingLifecycle;

    await expect(lifecycle.attachContext(context, sidecarOwner.publish)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "chat metadata catch-up refresh failed: Error: metadata unavailable",
    );
  });

  it("retries subordinate changes after a published owner's catch-up build fails", async () => {
    mocks.refresh.mockRejectedValueOnce(new Error("projection failed"));
    const { lifecycle: pendingLifecycle, sidecarOwner } = createLifecycle(false);
    const lifecycle = await pendingLifecycle;

    await lifecycle.attachContext(context, sidecarOwner.publish);
    const authListener = mocks.registerAuthListener.mock.calls[0]?.[0];

    authListener();

    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
  });

  it("defers subordinate changes until an invalidated model owner publishes", async () => {
    mocks.refresh.mockRejectedValueOnce(new ChatMetadataSnapshotUnavailableError());
    const { lifecycle: pendingLifecycle, sidecarOwner, warn } = createLifecycle(false);
    const lifecycle = await pendingLifecycle;

    await lifecycle.attachContext(context, sidecarOwner.publish);
    expect(mocks.refresh).toHaveBeenCalledOnce();

    const modelListener = mocks.registerModelListener.mock.calls[0]?.[0];
    const authListener = mocks.registerAuthListener.mock.calls[0]?.[0];
    const skillsListener = mocks.registerSkillsListener.mock.calls[0]?.[0];
    expect(modelListener).toEqual(expect.any(Function));
    expect(authListener).toEqual(expect.any(Function));
    expect(skillsListener).toEqual(expect.any(Function));

    modelListener({ phase: "invalidated" });
    modelListener({ phase: "catalog-published" });
    modelListener({ phase: "catalog-failed", error: new Error("obsolete catalog failed") });
    authListener();
    skillsListener();

    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();

    modelListener({ phase: "published" });

    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
    expect(warn).not.toHaveBeenCalled();
  });

  it("refreshes subordinate changes immediately while the model owner is published", async () => {
    const { lifecycle: pendingLifecycle, sidecarOwner } = createLifecycle(false);
    const lifecycle = await pendingLifecycle;

    await lifecycle.attachContext(context, sidecarOwner.publish);
    const authListener = mocks.registerAuthListener.mock.calls[0]?.[0];
    const skillsListener = mocks.registerSkillsListener.mock.calls[0]?.[0];

    authListener();
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
    skillsListener();
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(3));
  });

  it("keeps real metadata reads available after a nonfatal catalog attempt failure", async () => {
    const harness = await createRealMetadataLifecycle();
    try {
      const before = await harness.lifecycle.read({ agentId: "main" });
      harness.modelEvent({
        phase: "catalog-failed",
        error: new Error("catalog attempt failed"),
        modelFactsChanged: false,
      });
      const after = await harness.lifecycle.read({ agentId: "main" });
      expect(after).toEqual(before);
      expect(harness.warn).not.toHaveBeenCalled();
      expect(mocks.fail).not.toHaveBeenCalled();
    } finally {
      await harness.stop();
    }
  });

  it.each([
    { modelFactsChanged: true, refreshStatusChanged: false, refreshes: true },
    { modelFactsChanged: false, refreshStatusChanged: false, refreshes: false },
    { modelFactsChanged: undefined, refreshStatusChanged: false, refreshes: true },
    { modelFactsChanged: false, refreshStatusChanged: true, refreshes: true },
  ])(
    "refreshes catalog metadata only for a change (%j)",
    async ({ modelFactsChanged, refreshStatusChanged, refreshes }) => {
      const { lifecycle: pendingLifecycle, sidecarOwner } = createLifecycle(false);
      const lifecycle = await pendingLifecycle;

      await lifecycle.attachContext(context, sidecarOwner.publish);
      const modelListener = mocks.registerModelListener.mock.calls[0]?.[0];
      modelListener({ phase: "published" });
      await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
      mocks.invalidate.mockClear();

      modelListener({ phase: "catalog-published", modelFactsChanged, refreshStatusChanged });

      expect(mocks.invalidate).not.toHaveBeenCalled();
      expect(mocks.refresh).toHaveBeenCalledTimes(refreshes ? 3 : 2);
      if (refreshes) {
        expect(mocks.refresh).toHaveBeenLastCalledWith({
          notifyIfUnchanged: refreshStatusChanged,
        });
      }
    },
  );

  it("keeps an owner available when a subordinate catalog publishes during attachment", async () => {
    const pendingRefresh = createDeferred();
    mocks.refresh.mockReturnValueOnce(pendingRefresh.promise);
    const { lifecycle: pendingLifecycle, sidecarOwner } = createLifecycle(false);
    const lifecycle = await pendingLifecycle;

    const attachment = lifecycle.attachContext(context, sidecarOwner.publish);
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
    const modelListener = mocks.registerModelListener.mock.calls[0]?.[0];
    modelListener({ phase: "catalog-published" });
    pendingRefresh.resolve();
    await attachment;

    const authListener = mocks.registerAuthListener.mock.calls[0]?.[0];
    authListener();

    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
  });

  it("propagates a failed model publication without starting a refresh", async () => {
    const { lifecycle: pendingLifecycle, sidecarOwner } = createLifecycle(false);
    const lifecycle = await pendingLifecycle;

    await lifecycle.attachContext(context, sidecarOwner.publish);
    const modelListener = mocks.registerModelListener.mock.calls[0]?.[0];
    const publicationError = new Error("replacement failed");

    modelListener({ phase: "invalidated" });
    modelListener({ phase: "failed", error: publicationError });

    expect(mocks.fail).toHaveBeenCalledWith(publicationError);
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });
});
