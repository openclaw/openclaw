import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { prepareMemoryRuntimeReload } from "../plugins/memory-runtime.js";
import {
  captureActivePluginRegistrySnapshot,
  createPluginRegistryOwner,
  disposePluginRegistryInstances,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { getGatewayContextLifetime } from "../plugins/runtime/gateway-request-scope.js";
import {
  beginGatewayShutdownCleanup,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { getOpenClawAgentDatabaseIfOpen } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { createGatewayMemoryCloseRegistryFactory } from "./server-close.memory.test-support.js";
import { createGatewayKernel } from "./server-kernel.js";
import type { GatewayServer } from "./server-public.js";
import { startGatewayServerCore } from "./server-start.js";

async function createFixture(label: string) {
  const state = await createOpenClawTestState({
    label,
    layout: "home",
    env: {
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      VITEST: "1",
    },
  });
  state.applyEnv();
  const config: OpenClawConfig = {
    plugins: { enabled: true },
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        model: { primary: "openai/gpt-5.6-luna" },
      },
    },
    memory: {
      search: {
        provider: "fixture-embedding",
        model: "synthetic-embedding",
        fallback: "none",
        store: { vector: { enabled: false } },
      },
    },
  };
  const registry = await createGatewayMemoryCloseRegistryFactory(config);
  return { state, config, registry };
}

it("joins accepted Memory sync through Gateway close without reopening its executor between publications", async ({
  signal,
}) => {
  const original = captureActivePluginRegistrySnapshot();
  const fixture = await createFixture("gateway-memory-sync-close");
  const embeddingEntered = createDeferredCore();
  const releaseEmbedding = createDeferredCore();
  const closePreludeEntered = createDeferredCore();
  const beforeEmbedBatch = vi.fn(async () => {});
  fixture.config.memory!.search!.sources = ["memory"];
  const memory = fixture.registry(async () => {}, beforeEmbedBatch);
  let server: GatewayServer | undefined;
  let syncing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const messages = vi.spyOn(Worker.prototype, "postMessage");
  try {
    await fs.mkdir(path.join(fixture.state.workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(fixture.state.workspaceDir, "memory", "shutdown.md"),
      "# Accepted shutdown memory\nKeep the synthetic blue release preference.\n",
    );
    const port = await getFreePort();
    const token = "accepted-memory-close-token";
    await fixture.state.writeConfig({
      ...fixture.config,
      gateway: {
        auth: { mode: "token", token },
        port,
        controlUi: { enabled: false },
        reload: { mode: "off" },
      },
    });
    setActivePluginRegistry(memory.registry);
    const create = createGatewayKernel;
    const factory = vi
      .spyOn(await import("./server-kernel.js"), "createGatewayKernel")
      .mockImplementation(async (...args) => {
        const kernel = await create(...args);
        kernel.scheduler.signal.addEventListener("abort", () => closePreludeEntered.resolve(), {
          once: true,
        });
        return kernel;
      });
    try {
      server = await startGatewayServerCore(port, {
        auth: { mode: "token", token },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
    } finally {
      factory.mockRestore();
    }
    await server.startupSettled;
    const result = await memory.runtime.getMemorySearchManager({
      cfg: fixture.config,
      agentId: "main",
    });
    const manager = result.manager;
    assert(manager?.sync && manager.close, result.error ?? "Memory manager unavailable");
    await manager.probeEmbeddingAvailability();
    const options = { agentId: "main", env: fixture.state.env };
    const agent = getOpenClawAgentDatabaseIfOpen(options);
    assert(agent);
    const agentOpenRequests = () =>
      messages.mock.calls.filter(([request]) => {
        const value: unknown = request;
        return (
          value !== null &&
          typeof value === "object" &&
          "type" in value &&
          value.type === "open" &&
          "databasePath" in value &&
          value.databasePath === agent.path
        );
      });
    const shared = openOpenClawStateDatabase({ env: fixture.state.env });
    const readLeases = () =>
      shared.db
        .prepare("SELECT lease_id FROM agent_database_leases WHERE path = ? ORDER BY lease_id")
        .all(agent.path);
    const hostLeases = readLeases();
    beforeEmbedBatch.mockImplementation(async () => {
      embeddingEntered.resolve();
      await releaseEmbedding.promise;
    });
    syncing = manager.sync({ reason: "accepted-before-close", force: true });
    void syncing.catch(() => {});
    await withinTest(
      awaitGateBeforeSettlement(
        embeddingEntered.promise,
        syncing,
        "Memory sync settled before its accepted embedding work",
      ),
      signal,
    );
    const acceptedLeases = readLeases();
    expect(acceptedLeases).toHaveLength(hostLeases.length + 1);
    expect(agentOpenRequests().length).toBeGreaterThan(0);
    // Cache reads have admitted the native writer; remaining cache/index writes
    // must finish on that generation after the real close prelude begins.
    messages.mockClear();
    markGatewayRestartDraining();
    beginGatewayShutdownCleanup();
    closing = server.close({ reason: "accepted Memory sync close" });
    void closing.catch(() => {});
    await withinTest(
      awaitGateBeforeSettlement(
        closePreludeEntered.promise,
        closing,
        "Gateway closed without beginning its close prelude",
      ),
      signal,
    );
    expect(agent.db.isOpen).toBe(true);
    releaseEmbedding.resolve();
    await syncing;
    await closing;
    expect(agentOpenRequests().length).toBe(0);
    expect(agent.db.isOpen).toBe(false);
    expect(shared.db.isOpen).toBe(false);
    const stored = new DatabaseSync(agent.path, { readOnly: true });
    const leases = new DatabaseSync(shared.path, { readOnly: true });
    try {
      expect(
        stored
          .prepare("SELECT text FROM memory_index_chunks WHERE path = ?")
          .all("memory/shutdown.md"),
      ).toEqual([{ text: expect.stringContaining("Keep the synthetic blue release preference.") }]);
      expect(
        stored.prepare("SELECT count(*) AS count FROM memory_embedding_cache").get(),
      ).toMatchObject({
        count: 1,
      });
      expect(
        leases.prepare("SELECT lease_id FROM agent_database_leases WHERE path = ?").all(agent.path),
      ).toEqual([]);
    } finally {
      stored.close();
      leases.close();
    }
  } finally {
    releaseEmbedding.resolve();
    await Promise.allSettled([syncing, closing]);
    await server?.close().catch(() => {});
    vi.restoreAllMocks();
    resetGatewayWorkAdmission();
    restoreActivePluginRegistrySnapshot(original);
    await fixture.state.cleanup();
  }
});

it("preserves terminal close and healthy siblings after memory cleanup fails", async () => {
  const original = captureActivePluginRegistrySnapshot();
  const fixture = await createFixture("gateway-memory-close-failure");
  const kernels: Awaited<ReturnType<typeof createGatewayKernel>>[] = [];
  const servers: GatewayServer[] = [];
  const create = createGatewayKernel;
  let refuse = true;
  const memoryFailure = new Error("synthetic memory close refused");
  const completed: string[] = [];
  const firstClose = vi.fn(async () => {
    expect(getGatewayContextLifetime(kernels[0]!.resolvePluginGatewayContext).signal.aborted).toBe(
      false,
    );
    if (refuse) {
      throw memoryFailure;
    }
    completed.push("first");
  });
  const siblingClose = vi.fn(async () => {
    completed.push("sibling");
  });
  const first = fixture.registry(firstClose);
  const sibling = fixture.registry(siblingClose);
  try {
    for (const [index, owner] of [first, sibling].entries()) {
      const port = await getFreePort();
      const token = `memory-close-token-${index}`;
      await fixture.state.writeConfig({
        ...fixture.config,
        gateway: {
          auth: { mode: "token", token },
          port,
          controlUi: { enabled: false },
          reload: { mode: "off" },
        },
      });
      setActivePluginRegistry(owner.registry);
      const factory = vi
        .spyOn(await import("./server-kernel.js"), "createGatewayKernel")
        .mockImplementation(async (...args) => {
          const kernel = await create(...args);
          kernels.push(kernel);
          return kernel;
        });
      let server: GatewayServer;
      try {
        server = await startGatewayServerCore(port, {
          auth: { mode: "token", token },
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        servers.push(server);
      } finally {
        factory.mockRestore();
      }
      await server.startupSettled;
      expect(kernels[index]!.pluginRuntime.registry).toBe(owner.registry);
    }
    const one = await first.runtime.getMemorySearchManager({
      cfg: fixture.config,
      agentId: "main",
    });
    const two = await sibling.runtime.getMemorySearchManager({
      cfg: fixture.config,
      agentId: "main",
    });
    assert(one.manager, one.error ?? "First memory manager unavailable");
    assert(two.manager, two.error ?? "Sibling memory manager unavailable");
    await one.manager.probeEmbeddingAvailability();
    await two.manager.probeEmbeddingAvailability();
    const metadata = getGatewayPluginMetadataSnapshot();
    assert(metadata);
    const warning = new Error("synthetic earlier shutdown warning");
    const firstKernel = kernels[0];
    assert(firstKernel);
    const registryClose = vi.spyOn(firstKernel.pluginRuntime, "close");
    setActivePluginRegistry(first.registry);
    vi.spyOn(firstKernel.terminalSessions, "disposeAll").mockImplementationOnce(() => {
      throw warning;
    });
    const failure = await servers[0]!
      .close({ reason: "memory close proof" })
      .catch((error: unknown) => error);
    expect.soft(failure).toBeInstanceOf(AggregateError);
    expect.soft(collectNestedErrorCandidates(failure)).toContain(warning);
    const failedAttempts = firstClose.mock.calls.length;
    expect.soft(firstClose).toHaveBeenCalled();
    const registryResult = await registryClose.mock.results[0]?.value;
    expect(registryClose).toHaveBeenCalledOnce();
    expect(registryResult?.memoryErrors).toContain(memoryFailure);
    expect(first.instance.lifecycle.signal.aborted).toBe(true);
    expect(getGatewayContextLifetime(firstKernel.resolvePluginGatewayContext).signal.aborted).toBe(
      true,
    );
    expect(() => firstKernel.pluginRuntime.publish(first.registry)).toThrow();
    expect(siblingClose).not.toHaveBeenCalled();
    await expect(two.manager.probeEmbeddingAvailability()).resolves.toMatchObject({ ok: true });
    expect(completed).toEqual([]);
    expect(getGatewayPluginMetadataSnapshot()).toBe(metadata);
    const newcomer = await startGatewayServerCore(await getFreePort(), {
      auth: { mode: "token", token: "memory-close-newcomer" },
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    servers.push(newcomer);
    await newcomer.startupSettled;
    await expect(two.manager.probeEmbeddingAvailability()).resolves.toMatchObject({ ok: true });
    await newcomer.close({ reason: "newcomer leaves shared memory running" });
    expect(siblingClose).not.toHaveBeenCalled();
    expect(getGatewayPluginMetadataSnapshot()).toBe(metadata);
    await expect(servers[0]!.close({ reason: "warning failure stays terminal" })).rejects.toBe(
      failure,
    );
    expect(firstClose).toHaveBeenCalledTimes(failedAttempts);
    await servers[1]!.close({ reason: "sibling close proof" });
    expect(siblingClose).toHaveBeenCalledOnce();
    expect(completed).toEqual(["sibling"]);
    expect(getGatewayPluginMetadataSnapshot()).toBeUndefined();
    await expect(servers[0]!.close({ reason: "already closed" })).rejects.toBe(failure);
    expect(firstClose).toHaveBeenCalledTimes(failedAttempts);
    expect(registryClose).toHaveBeenCalledOnce();
  } finally {
    refuse = false;
    for (const server of servers.toReversed()) {
      await server.close().catch(() => {});
    }
    restoreActivePluginRegistrySnapshot(original);
    await fixture.state.cleanup();
  }
});

it("closes one managed memory runtime exactly once when its registry owners close together", async () => {
  const original = captureActivePluginRegistrySnapshot();
  const fixture = await createFixture("gateway-shared-memory-close");
  const close = vi.fn(async () => {});
  const memory = fixture.registry(close);
  setActivePluginRegistry(memory.registry);
  const first = createPluginRegistryOwner(memory.registry);
  const second = createPluginRegistryOwner(memory.registry);
  try {
    const result = await memory.runtime.getMemorySearchManager({
      cfg: fixture.config,
      agentId: "main",
    });
    assert(result.manager, result.error ?? "Shared memory manager unavailable");
    await result.manager.probeEmbeddingAvailability();
    await Promise.all([first.close(), second.close()]);
    expect(close).toHaveBeenCalledOnce();
    expect(memory.instance.lifecycle.signal.aborted).toBe(true);
  } finally {
    await Promise.allSettled([first.close(), second.close()]);
    restoreActivePluginRegistrySnapshot(original);
    await fixture.state.cleanup();
  }
});

it("retains memory shared with an open owner other than the process projection survivor", async () => {
  const original = captureActivePluginRegistrySnapshot();
  const fixture = await createFixture("gateway-three-memory-owners");
  const close = vi.fn(async () => {});
  const shared = fixture.registry(close);
  const unrelated = fixture.registry(async () => {});
  setActivePluginRegistry(shared.registry);
  const first = createPluginRegistryOwner(shared.registry);
  const sharing = createPluginRegistryOwner(shared.registry);
  setActivePluginRegistry(unrelated.registry);
  const last = createPluginRegistryOwner(unrelated.registry);
  try {
    const result = await shared.runtime.getMemorySearchManager({
      cfg: fixture.config,
      agentId: "main",
    });
    assert(result.manager, result.error ?? "Shared memory manager unavailable");
    await result.manager.probeEmbeddingAvailability();
    await first.close();
    expect.soft(close).not.toHaveBeenCalled();
    await expect(result.manager.probeEmbeddingAvailability()).resolves.toMatchObject({ ok: true });
    await sharing.close();
    expect(close).toHaveBeenCalledOnce();
  } finally {
    await Promise.allSettled([first.close(), sharing.close(), last.close()]);
    restoreActivePluginRegistrySnapshot(original);
    await fixture.state.cleanup();
  }
});

it("resumes only currently retained managed memory runtimes after raw close settles", async () => {
  const fixture = await createFixture("gateway-memory-retention-change");
  const first = fixture.registry(async () => {});
  const second = fixture.registry(async () => {});
  const release = createDeferredCore();
  const resumed: string[] = [];
  for (const [id, owner] of [
    ["first", first],
    ["second", second],
  ] as const) {
    const runtime = owner.instance.wrap({
      ...owner.runtime,
      prepareReload: () => ({
        drain: () => release.promise,
        resume: () => {
          resumed.push(id);
        },
      }),
    });
    owner.registry.memoryCapabilities[0]!.capability = owner.instance.wrap({ runtime });
  }
  const memoryCapabilities = [
    ...first.registry.memoryCapabilities,
    ...second.registry.memoryCapabilities,
  ];
  const reload = prepareMemoryRuntimeReload(
    {
      memoryCapabilities,
      embeddingProviders: [
        ...first.registry.embeddingProviders,
        ...second.registry.embeddingProviders,
      ],
    },
    { memoryCapabilities, embeddingProviders: [] },
  );
  const closing = reload.close();
  try {
    release.resolve();
    await closing;
    reload.commit({
      memoryCapabilities: second.registry.memoryCapabilities,
      embeddingProviders: [],
    });
    expect(resumed).toEqual(["second"]);
  } finally {
    release.resolve();
    await closing;
    await disposePluginRegistryInstances(first.registry);
    await disposePluginRegistryInstances(second.registry);
    await fixture.state.cleanup();
  }
});
