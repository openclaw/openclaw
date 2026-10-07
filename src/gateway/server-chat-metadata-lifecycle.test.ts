import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { RuntimeAuthProfileStore } from "../agents/auth-profiles/types.js";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { publishSessionCostUsageUpdated } from "../infra/session-cost-usage-events.js";
import {
  bumpSkillsSnapshotVersion,
  getSkillsSnapshotVersion,
  notifySkillsWatchAvailable,
  registerSkillsChangeListener,
  resetSkillsRefreshStateForTest,
} from "../skills/runtime/refresh-state.js";
import { writeSkill } from "../skills/test-support/e2e-test-helpers.js";
import { publishOperatorRoleConfigChange } from "./operator-role-policy.js";
import { createChatMetadataOwner } from "./server-methods/chat-metadata-runtime.test-support.js";
import { createPreparedReadHandler } from "./server-methods/prepared-read.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./server-methods/types.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";
import { dispatchSharedRead, invalidateSharedReadResponses } from "./shared-read-responses.js";

const mocks = vi.hoisted(() => ({
  createRuntime: vi.fn(),
  fail: vi.fn(),
  invalidate: vi.fn(),
  read: vi.fn(),
  readStartup: vi.fn(),
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
  registerPreparedModelRuntimePublicationListener: mocks.registerModelListener,
}));
vi.mock("../skills/runtime/refresh.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills/runtime/refresh.js")>()),
  registerSkillsChangeListener: mocks.registerSkillsListener,
}));

const { createGatewayChatMetadataLifecycle } = await import("./server-chat-metadata-lifecycle.js");
const { ChatMetadataSnapshotUnavailableError } =
  await import("./server-methods/chat-metadata-facts.js");
const authSnapshots = await vi.importActual<
  typeof import("../agents/auth-profiles/runtime-snapshots.js")
>("../agents/auth-profiles/runtime-snapshots.js");

const config = {} as OpenClawConfig;
const context = {} as GatewayRequestContext;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sidecarOwners = new Set<ReturnType<typeof createGatewaySidecarStopOwner>>();

afterEach(async () => {
  for (const owner of sidecarOwners) {
    await owner.stop();
  }
  sidecarOwners.clear();
});

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

function createLifecycle(warn = vi.fn()) {
  const sidecarOwner = createGatewaySidecarStopOwner();
  sidecarOwners.add(sidecarOwner);
  return {
    lifecycle: createGatewayChatMetadataLifecycle({
      getConfig: () => config,
      log: { warn } as never,
    }),
    sidecarOwner,
    warn,
  };
}

it.each([false, true])(
  "publishes usage completion (failed: %s) without rebuilding metadata and retires its listener on stop",
  async (failed) => {
    const broadcast = vi.fn();
    const { lifecycle: pending, sidecarOwner } = createLifecycle();
    const lifecycle = await pending;
    await lifecycle.attachContext({ ...context, broadcast }, sidecarOwner.publish);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    mocks.refresh.mockClear();
    expect(sidecarOwner.snapshot()).toHaveLength(1);
    publishSessionCostUsageUpdated("main", failed);
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(
      "chat.metadata.changed",
      {
        agentId: "main",
        usageUpdatedAt: expect.any(Number),
        modelCatalogChanged: false,
        authChanged: false,
        commandsChanged: false,
        ...(failed ? { usageRefreshFailed: true } : {}),
      },
      { dropIfSlow: true },
    );
    expect(mocks.refresh).not.toHaveBeenCalled();
    await sidecarOwner.stop();
    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.unregisterAuthListener).toHaveBeenCalledOnce();
    expect(mocks.unregisterModelListener).toHaveBeenCalledOnce();
    expect(mocks.unregisterSkillsListener).toHaveBeenCalledOnce();
    publishSessionCostUsageUpdated("main");
    expect(broadcast).toHaveBeenCalledTimes(1);
  },
);

it("retires model choices at its config commit before pending metadata settles", async () => {
  const broadcast = vi.fn();
  let committedConfig: OpenClawConfig = {};
  const ownedContext = {
    ...context,
    broadcast,
    getCommittedRuntimeConfig: () => committedConfig,
  };
  const entered = createDeferred();
  const release = createDeferred();
  mocks.refresh.mockImplementationOnce(() => {
    entered.resolve();
    return release.promise;
  });
  const { lifecycle: pendingLifecycle, sidecarOwner } = createLifecycle();
  const lifecycle = await pendingLifecycle;
  const attaching = lifecycle.attachContext(ownedContext, sidecarOwner.publish);
  try {
    await entered.promise;
    publishOperatorRoleConfigChange({});
    expect(broadcast).not.toHaveBeenCalled();
    committedConfig = { auth: { profiles: { account: { provider: "fixture", mode: "api_key" } } } };
    publishOperatorRoleConfigChange(ownedContext);
    expect(broadcast).not.toHaveBeenCalled();
    committedConfig = { ...committedConfig, models: { mode: "replace" } };
    publishOperatorRoleConfigChange(ownedContext);
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(
      "chat.metadata.changed",
      { modelSelectionChanged: true, commandsChanged: false },
      { dropIfSlow: true },
    );
    broadcast.mockClear();
    committedConfig = {
      ...committedConfig,
      agents: { defaults: { modelPolicy: { allow: ["fixture/allowed"] } } },
    };
    publishOperatorRoleConfigChange(ownedContext);
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(
      "chat.metadata.changed",
      { modelSelectionChanged: true, commandsChanged: false },
      { dropIfSlow: true },
    );
  } finally {
    release.resolve();
    await attaching;
    await sidecarOwner.stop();
  }
  broadcast.mockClear();
  publishOperatorRoleConfigChange(ownedContext);
  expect(broadcast).not.toHaveBeenCalled();
});

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
  const { lifecycle: pendingLifecycle, sidecarOwner, warn } = createLifecycle();
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
      skills: () => mocks.registerSkillsListener.mock.calls[0]![0]({ reason: "watch" }),
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
        notifySkillsWatchAvailable({ workspaceDir, sourceScope: {} });
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
        { modelCatalogChanged: false, authChanged: false },
        { dropIfSlow: true },
      );
    } finally {
      await harness.stop();
      resetSkillsRefreshStateForTest();
    }
  });

  it.each([true])(
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
          harness.modelEvent({ phase: "catalog-published", modelFactsChanged: false });
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
      name: "token rotated",
      change: {
        profiles: { "test:primary": { type: "token", provider: "test", token: "rotated-token" } },
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
        { modelCatalogChanged: true, authChanged: true, commandsChanged: false },
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

  it.each(["queued", "building", "initial build", "missing owner"] as const)(
    "keeps readers waiting for owner publication after %s",
    async (stage) => {
      const initial = stage === "initial build";
      const missing = stage === "missing owner";
      const harness = await createRealMetadataLifecycle({
        attach: !initial && !missing,
        ownerAvailable: !missing,
      });
      const entered = createDeferred();
      const release = createDeferred();
      const queued =
        stage === "queued" || stage === "building" ? harness.queueRefresh(stage) : undefined;
      let settled = false;
      const readMetadata = () =>
        harness.lifecycle.read({ agentId: "main" }).then(
          (value) => {
            settled = true;
            return value;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
      let read: Promise<unknown> | undefined;
      try {
        if (initial) {
          harness.buildCommands.mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            return { commands: [] };
          });
          await harness.attach();
          read = readMetadata();
          await entered.promise;
        } else if (missing) {
          await harness.attach();
          expect(harness.warn).not.toHaveBeenCalled();
          await expect(harness.lifecycle.read({ agentId: "main" })).rejects.toBeInstanceOf(
            ChatMetadataSnapshotUnavailableError,
          );
        } else {
          await queued?.entered;
        }
        harness.invalidateOwner();
        read ??= readMetadata();
        release.resolve();
        queued?.release();
        await queued?.obsolete.catch(() => undefined);
        await nextEventLoopTurn();
        expect(harness.warn).not.toHaveBeenCalled();
        expect(settled).toBe(false);
        harness.replaceOwner();
        await expect(read).resolves.toMatchObject({
          models: [expect.objectContaining({ id: "after-publication" })],
        });
      } finally {
        release.resolve();
        queued?.release();
        await harness.stop();
        await Promise.all([read, queued?.reading]);
      }
    },
  );

  it.each(["auth", "owner"] as const)(
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

  it("broadcasts settled metadata through the production lifecycle without a failure feedback loop", async () => {
    const actual = await vi.importActual<
      typeof import("./server-methods/chat-metadata-runtime.js")
    >("./server-methods/chat-metadata-runtime.js");
    const owner = {
      ...createChatMetadataOwner(config, "model"),
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
    const { lifecycle: pendingLifecycle, sidecarOwner } = createLifecycle();
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
      Array.from({ length: 7 }, (_, index) => [
        "chat.metadata.changed",
        {
          modelCatalogChanged: true,
          authChanged: true,
          ...(index === 3 || index === 4 ? { commandsChanged: false } : {}),
        },
        { dropIfSlow: true },
      ]),
    );
  });

  it("joins pending metadata work before Gateway lifetime shutdown", async () => {
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
    const buildProjection = vi.fn(async () => {
      await holdWork();
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
    const { lifecycle: pendingLifecycle, sidecarOwner, warn } = createLifecycle();
    const lifecycle = await pendingLifecycle;
    const broadcast = vi.fn();
    await lifecycle.attachContext(
      { broadcast } as unknown as GatewayRequestContext,
      sidecarOwner.publish,
    );
    held = true;
    revision += 1;
    mocks.registerModelListener.mock.calls[0]![0]({ phase: "published" });
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
  });

  it.each(["build failed", "catalog during attachment", "owner invalidated"] as const)(
    "refreshes subordinate changes after %s catch-up",
    async (startup) => {
      const entered = createDeferred();
      const release = createDeferred();
      if (startup === "build failed") {
        mocks.refresh.mockRejectedValueOnce(new Error("metadata unavailable"));
      } else if (startup === "owner invalidated") {
        mocks.refresh.mockRejectedValueOnce(new ChatMetadataSnapshotUnavailableError());
      } else if (startup === "catalog during attachment") {
        mocks.refresh.mockImplementationOnce(() => {
          entered.resolve();
          return release.promise;
        });
      }
      const { lifecycle: pending, sidecarOwner, warn } = createLifecycle();
      const lifecycle = await pending;
      const attachment = lifecycle.attachContext(context, sidecarOwner.publish);
      try {
        if (startup === "catalog during attachment") {
          await entered.promise;
          expect(mocks.refresh).toHaveBeenCalledOnce();
          mocks.registerModelListener.mock.calls[0]![0]({ phase: "catalog-published" });
          release.resolve();
        }
        await expect(attachment).resolves.toBeUndefined();
        expect(mocks.refresh).toHaveBeenCalledOnce();
        if (startup === "build failed") {
          expect(warn).toHaveBeenCalledWith(
            "chat metadata catch-up refresh failed: Error: metadata unavailable",
          );
        } else {
          expect(warn).not.toHaveBeenCalled();
        }
        const modelListener = mocks.registerModelListener.mock.calls[0]![0];
        const authListener = mocks.registerAuthListener.mock.calls[0]![0];
        const skillsListener = mocks.registerSkillsListener.mock.calls[0]![0];
        for (const listener of [modelListener, authListener, skillsListener]) {
          expect(listener).toEqual(expect.any(Function));
        }
        if (startup === "owner invalidated") {
          modelListener({ phase: "invalidated" });
          modelListener({ phase: "catalog-published" });
          modelListener({ phase: "catalog-failed", error: new Error("obsolete catalog failed") });
          authListener();
          skillsListener({ reason: "watch" });
          expect(mocks.refresh).toHaveBeenCalledOnce();
          expect(warn).not.toHaveBeenCalled();
          modelListener({ phase: "published" });
          expect(mocks.refresh).toHaveBeenCalledTimes(2);
          expect(warn).not.toHaveBeenCalled();
        } else {
          authListener();
          expect(mocks.refresh).toHaveBeenCalledTimes(2);
          skillsListener({ reason: "watch" });
          expect(mocks.refresh).toHaveBeenCalledTimes(3);
        }
      } finally {
        release.resolve();
        await attachment;
      }
    },
  );

  it.each([
    {
      phase: "catalog-observation",
      modelFactsChanged: false,
      refreshStatusChanged: false,
      refreshes: false,
    },
    { modelFactsChanged: true, refreshStatusChanged: false, refreshes: true },
    { modelFactsChanged: false, refreshStatusChanged: false, refreshes: false },
    { modelFactsChanged: undefined, refreshStatusChanged: false, refreshes: true },
    { modelFactsChanged: false, refreshStatusChanged: true, refreshes: true },
    {
      phase: "catalog-status",
      modelFactsChanged: false,
      refreshStatusChanged: false,
      refreshes: false,
    },
  ])(
    "refreshes catalog metadata only for a change (%j)",
    async ({ phase = "catalog-published", modelFactsChanged, refreshStatusChanged, refreshes }) => {
      const { lifecycle: pendingLifecycle, sidecarOwner } = createLifecycle();
      const lifecycle = await pendingLifecycle;
      const requestContext = { ...context, broadcast: vi.fn(), getRuntimeConfig: () => config };
      let pending = true;
      let payloadJson: string | undefined;
      const produce = vi.fn(() => ({ pendingProviders: pending ? ["synthetic"] : undefined }));
      const handler = createPreparedReadHandler(() => ({
        run: (respond) => respond(true, produce()),
      }));
      const options = {
        req: { type: "req", id: "catalog", method: "models.list" },
        params: {},
        client: null,
        context: requestContext,
        isWebchatConnect: () => false,
        respond: (_ok, payload) => {
          payloadJson = JSON.stringify(payload);
        },
      } satisfies GatewayRequestHandlerOptions;
      const sharing = {
        shareKey: () => "catalog",
        shareInvalidationEvents: ["chat.metadata.changed"],
        shareMaxAgeMs: 1_000,
      };
      const read = () => dispatchSharedRead(handler, options, sharing, () => {});
      vi.useFakeTimers();
      try {
        await lifecycle.attachContext(requestContext, sidecarOwner.publish);
        const modelListener = mocks.registerModelListener.mock.calls[0]?.[0];
        modelListener({ phase: "published" });
        expect(mocks.refresh).toHaveBeenCalledTimes(2);
        mocks.invalidate.mockClear();
        await read();
        await read();
        expect(produce).toHaveBeenCalledOnce();
        expect(payloadJson).toBe('{"pendingProviders":["synthetic"]}');

        pending = false;
        modelListener({ phase, modelFactsChanged, refreshStatusChanged, agentId: "main" });
        await read();

        expect(payloadJson).toBe("{}");
        if (phase === "catalog-observation") {
          expect(requestContext.broadcast).toHaveBeenCalledExactlyOnceWith(
            "chat.metadata.changed",
            {
              agentId: "main",
              modelCatalogChanged: true,
              authChanged: false,
              commandsChanged: false,
            },
            { dropIfSlow: true },
          );
        }
        expect(produce).toHaveBeenCalledTimes(2);
        expect(mocks.invalidate).not.toHaveBeenCalled();
        expect(mocks.refresh).toHaveBeenCalledTimes(refreshes ? 3 : 2);
        if (refreshes) {
          expect(mocks.refresh).toHaveBeenLastCalledWith({
            notifyIfUnchanged: refreshStatusChanged,
          });
        }
      } finally {
        invalidateSharedReadResponses(requestContext.broadcast);
        vi.useRealTimers();
      }
    },
  );
});
