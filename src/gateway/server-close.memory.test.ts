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
import {
  captureActivePluginRegistrySnapshot,
  createPluginRegistryOwner,
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
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { createGatewayMemoryCloseRegistryFactory } from "./server-close.memory.test-support.js";
import type { createGatewayKernel } from "./server-kernel.js";
import type { GatewayServer } from "./server-public.js";
import { startGatewayServerCore } from "./server-start.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";

type Kernel = Awaited<ReturnType<typeof createGatewayKernel>>;
type Fixture = Awaited<ReturnType<typeof createFixture>>;
async function openManager(fixture: Fixture, memory: ReturnType<Fixture["registry"]>) {
  const result = await memory.runtime.getMemorySearchManager({
    cfg: fixture.config,
    agentId: "main",
  });
  assert(result.manager, result.error ?? "Memory manager unavailable");
  await result.manager.probeEmbeddingAvailability();
  return result.manager;
}
const contextAborted = (kernel: Kernel) =>
  getGatewayContextLifetime(kernel.resolvePluginGatewayContext).signal.aborted;
const beforeSettlement = (
  gate: Promise<void>,
  settlement: Promise<unknown>,
  signal: AbortSignal,
  phase: string,
) => withinTest(awaitGateBeforeSettlement(gate, settlement, `Settled before ${phase}`), signal);

async function createFixture(label: string) {
  const original = captureActivePluginRegistrySnapshot();
  const state = await createOpenClawTestState({
    label,
    layout: "home",
    env: { ...KERNEL_TEST_ENV, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  state.applyEnv();
  const config: OpenClawConfig = {
    plugins: { enabled: true },
    agents: {
      defaults: { workspace: state.workspaceDir, model: { primary: "openai/gpt-5.6-luna" } },
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
  const registry = createGatewayMemoryCloseRegistryFactory(config);
  const servers: GatewayServer[] = [];
  return {
    state,
    config,
    registry,
    async start(memory: ReturnType<typeof registry>) {
      const port = await getFreePort();
      const auth = { mode: "token" as const, token: "memory-close-token" };
      await state.writeConfig({
        ...config,
        gateway: { auth, port, controlUi: { enabled: false }, reload: { mode: "off" } },
      });
      setActivePluginRegistry(memory.registry);
      const factory = vi.spyOn(await import("./server-kernel.js"), "createGatewayKernel");
      let server: GatewayServer;
      let kernel: Kernel | undefined;
      try {
        server = await startGatewayServerCore(port, {
          auth,
          bind: "loopback",
          controlUiEnabled: false,
          sidecarStartup: "defer",
        });
        servers.push(server);
        kernel = await factory.mock.results[0]?.value;
      } finally {
        factory.mockRestore();
      }
      assert(kernel);
      await server.startupSettled;
      return { server, kernel };
    },
    async cleanup() {
      for (const server of servers.toReversed()) {
        await server.close().catch(() => {});
      }
      restoreActivePluginRegistrySnapshot(original);
      await state.cleanup();
    },
  };
}

it("settles accepted Memory sync before closing its existing executor", async ({ signal }) => {
  const fixture = await createFixture("gateway-memory-sync-close");
  const embeddingEntered = createDeferredCore();
  const releaseEmbedding = createDeferredCore();
  const closePreludeEntered = createDeferredCore();
  const beforeEmbedBatch = vi.fn(async () => {});
  fixture.config.memory!.search!.sources = ["memory"];
  const memory = fixture.registry(async () => {}, beforeEmbedBatch);
  let syncing: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const messages = vi.spyOn(Worker.prototype, "postMessage");
  try {
    await fs.mkdir(path.join(fixture.state.workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(fixture.state.workspaceDir, "memory", "shutdown.md"),
      "# Accepted shutdown memory\nKeep the synthetic blue release preference.\n",
    );
    const { server, kernel } = await fixture.start(memory);
    kernel.scheduler.signal.addEventListener("abort", () => closePreludeEntered.resolve(), {
      once: true,
    });
    const manager = await openManager(fixture, memory);
    assert(manager.sync && manager.close);
    const agentPath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: fixture.state.env });
    const requests = () => messages.mock.calls.map(([request]) => request);
    const agentOpen = expect.objectContaining({ type: "open", databasePath: agentPath });
    const shared = openOpenClawStateDatabase({ env: fixture.state.env });
    const readLeases = () =>
      shared.db
        .prepare("SELECT lease_id FROM agent_database_leases WHERE path = ? ORDER BY lease_id")
        .all(agentPath);
    beforeEmbedBatch.mockImplementation(async () => {
      embeddingEntered.resolve();
      await releaseEmbedding.promise;
    });
    const acceptedLeases = readLeases();
    expect(acceptedLeases.length).toBeGreaterThan(0);
    expect(requests()).toContainEqual(agentOpen);
    messages.mockClear();
    let closeRequested = false;
    syncing = manager.sync({
      reason: "accepted-before-close",
      force: true,
      progress: () => {
        if (closeRequested) {
          return;
        }
        closeRequested = true;
        // The first report precedes awaited source reads and the first publication.
        markGatewayRestartDraining();
        beginGatewayShutdownCleanup();
        closing = server.close({ reason: "accepted Memory sync close" });
        void closing.catch(() => {});
      },
    });
    void syncing.catch(() => {});
    await beforeSettlement(embeddingEntered.promise, syncing, signal, "accepted embedding");
    assert(closing, "Memory sync did not report progress before embedding");
    await beforeSettlement(closePreludeEntered.promise, closing, signal, "close prelude");
    expect(readLeases()).toEqual(acceptedLeases);
    releaseEmbedding.resolve();
    await syncing;
    await closing;
    expect(requests()).not.toContainEqual(agentOpen);
    expect(shared.db.isOpen).toBe(false);
    const stored = new DatabaseSync(agentPath, { readOnly: true });
    const leases = new DatabaseSync(shared.path, { readOnly: true });
    try {
      const chunks = stored.prepare("SELECT text FROM memory_index_chunks WHERE path = ?");
      const cached = stored.prepare("SELECT count(*) AS count FROM memory_embedding_cache");
      const live = leases.prepare("SELECT lease_id FROM agent_database_leases WHERE path = ?");
      expect(chunks.all("memory/shutdown.md")).toEqual([
        { text: expect.stringContaining("Keep the synthetic blue release preference.") },
      ]);
      expect(cached.get()).toMatchObject({ count: 1 });
      expect(live.all(agentPath)).toEqual([]);
    } finally {
      stored.close();
      leases.close();
    }
  } finally {
    releaseEmbedding.resolve();
    await Promise.allSettled([syncing, closing]);
    try {
      await fixture.cleanup();
    } finally {
      vi.restoreAllMocks();
      resetGatewayWorkAdmission();
    }
  }
});

it("drains memory before stalled connection cleanup while preserving terminal close", async ({
  signal,
}) => {
  const fixture = await createFixture("gateway-memory-close-failure");
  let kernel: Kernel;
  let server: GatewayServer;
  let refuse = true;
  const memoryFailure = new Error("synthetic memory close refused");
  const completed: string[] = [];
  const memoryCloseStarted = createDeferredCore();
  const releaseConnectionWork = createDeferredCore();
  let connectionWork: Promise<void> | undefined;
  const firstClose = vi.fn(async () => {
    expect(contextAborted(kernel)).toBe(false);
    memoryCloseStarted.resolve();
    if (refuse) {
      throw memoryFailure;
    }
    completed.push("first");
  });
  const first = fixture.registry(firstClose);
  try {
    ({ server, kernel } = await fixture.start(first));
    expect(kernel.pluginRuntime.registry).toBe(first.registry);
    await openManager(fixture, first);
    const warning = new Error("synthetic earlier shutdown warning");
    const registryClose = vi.spyOn(kernel.pluginRuntime, "close");
    vi.spyOn(kernel.terminalSessions, "disposeAll").mockImplementationOnce(() => {
      throw warning;
    });
    connectionWork = kernel.connectionWork.track(() => releaseConnectionWork.promise);
    const closing = server.close({ reason: "memory close proof" }).catch((error: unknown) => error);
    await beforeSettlement(memoryCloseStarted.promise, closing, signal, "memory drainage");
    expect(first.instance.lifecycle.signal.aborted).toBe(false);
    expect(contextAborted(kernel)).toBe(false);
    expect(registryClose).not.toHaveBeenCalled();
    releaseConnectionWork.resolve();
    const failure = await closing;
    expect.soft(failure).toBeInstanceOf(AggregateError);
    expect.soft(collectNestedErrorCandidates(failure)).toContain(warning);
    const failedAttempts = firstClose.mock.calls.length;
    expect.soft(firstClose).toHaveBeenCalled();
    const registryResult = await registryClose.mock.results[0]?.value;
    expect(registryClose).toHaveBeenCalledOnce();
    expect(registryResult?.memoryErrors).toContain(memoryFailure);
    expect([first.instance.lifecycle.signal.aborted, contextAborted(kernel)]).toEqual([true, true]);
    expect(() => kernel.pluginRuntime.publish(first.registry)).toThrow();
    expect(completed).toEqual([]);
    await expect(server.close({ reason: "warning failure stays terminal" })).rejects.toBe(failure);
    expect(firstClose).toHaveBeenCalledTimes(failedAttempts);
    expect(getGatewayPluginMetadataSnapshot()).toBeUndefined();
    expect(registryClose).toHaveBeenCalledOnce();
  } finally {
    releaseConnectionWork.resolve();
    await connectionWork;
    refuse = false;
    await fixture.cleanup();
  }
});

it("closes one managed memory runtime exactly once across repeated owner close calls", async () => {
  const discoveryEnv = captureEnv([
    "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
    "OPENCLAW_BUNDLED_PLUGINS_DIR",
  ]);
  using _ = {
    [Symbol.dispose]: () => discoveryEnv.restore(),
  };
  setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "0");
  const originalDiscoveryEnv = {
    disabled: process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS,
    directory: process.env.OPENCLAW_BUNDLED_PLUGINS_DIR,
  };
  const fixture = await createFixture("gateway-shared-memory-close");
  const close = vi.fn(async () => {});
  const memory = fixture.registry(close);
  setActivePluginRegistry(memory.registry);
  const owner = createPluginRegistryOwner(memory.registry);
  try {
    await openManager(fixture, memory);
    const preparation = owner.prepareClose();
    expect(owner.prepareClose()).toBe(preparation);
    await preparation;
    expect(close).toHaveBeenCalledOnce();
    expect(memory.instance.lifecycle.signal.aborted).toBe(false);
    await Promise.all([owner.close(), owner.close()]);
    expect(close).toHaveBeenCalledOnce();
    expect(memory.instance.lifecycle.signal.aborted).toBe(true);
  } finally {
    await Promise.allSettled([owner.close()]);
    await fixture.cleanup();
  }
  // Vitest cleanup must not resurrect the inner fixture's disabled selector.
  vi.unstubAllEnvs();
  expect({
    disabled: process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS,
    directory: process.env.OPENCLAW_BUNDLED_PLUGINS_DIR,
  }).toEqual(originalDiscoveryEnv);
});
