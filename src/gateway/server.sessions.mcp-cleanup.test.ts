// Registered reset/delete must join transports already retired by the MCP idle sweep.
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, test } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { startCatalogRecoveryMcpServer } from "../agents/agent-bundle-mcp-catalog-recovery.test-support.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsHandlerTestHarness,
  bundleMcpRuntimeMocks,
  writeSingleLineSession,
  sessionStoreEntry,
  directSessionReq,
  getSessionsHandlers,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

afterEach(async () => {
  await disposeSessionReadContexts();
  closeOpenClawStateDatabaseForTest();
});

test.for(["sessions.reset", "sessions.delete"] as const)(
  "%s joins MCP idle disposal before mutating the session",
  async (method, { signal }) => {
    const beforeSettlement = (gate: Promise<unknown>, work: Promise<unknown>, message: string) =>
      withinTest(awaitGateBeforeSettlement(gate, work, message), signal);
    const { dir, storePath } = await createSessionStoreDir();
    const sessionId = `idle-mcp-${method}`;
    const sessionKey = "agent:main:idle-mcp-cleanup";
    const readEntry = () => loadSessionEntry({ agentId: "main", sessionKey, storePath });
    await writeSingleLineSession(dir, sessionId, "hello");
    await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
    const initialEntry = readEntry();
    expect(initialEntry).toBeDefined();
    await Promise.all([
      getSessionsHandlers(),
      import("./session-reset-service.js"),
      import("./server-methods/sessions-mutations.js"),
      import("./server-methods/sessions-delete.js"),
    ]);
    const { acquireSessionMcpRuntime, retireSessionMcpRuntime } =
      await import("../agents/agent-bundle-mcp-manager-api.js");
    const { releaseSessionMcpRuntime } =
      await import("../agents/agent-bundle-mcp-manager-cleanup.js");
    const { createSessionMcpRuntimeManager } =
      await import("../agents/agent-bundle-mcp-manager.js");
    const { SESSION_MCP_RUNTIME_MANAGER_KEY } =
      await import("../agents/agent-bundle-mcp-runtime-shared.js");
    const clock = createGatewaySchedulerClock(Date.now());
    const scheduler = createTestGatewayScheduler(clock.clock);
    const manager = createSessionMcpRuntimeManager({ scheduler });
    const terminate = createDeferred();
    const server = await startCatalogRecoveryMcpServer("idle-session-cleanup", {
      holdTermination: terminate.promise,
    });
    const retirementStarted = createDeferred();
    let retirementFinished = false;
    let mutationFinished = false;
    const pending: Promise<unknown>[] = [];
    bundleMcpRuntimeMocks.retireSessionMcpRuntime.mockImplementation(async (params) => {
      // Observe the existing fixture seam while the real manager owns retirement.
      const retirement = retireSessionMcpRuntime(params);
      retirementStarted.resolve();
      const result = await retirement;
      retirementFinished = true;
      return result;
    });
    const previousManager = Object.getOwnPropertyDescriptor(
      globalThis,
      SESSION_MCP_RUNTIME_MANAGER_KEY,
    );
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => {
      if (previousManager) {
        Object.defineProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY, previousManager);
      } else {
        Reflect.deleteProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
      }
    });
    cleanup.defer(() => scheduler.stop());
    cleanup.defer(() => server.close());
    cleanup.defer(() => manager.disposeAll());
    cleanup.defer(async () => {
      terminate.resolve();
      await Promise.allSettled(pending);
    });
    Object.defineProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: manager,
    });
    const lease = await acquireSessionMcpRuntime({
      sessionId,
      sessionKey,
      workspaceDir: dir,
      manifestRegistry: { plugins: [] },
      cfg: {
        plugins: { enabled: false },
        mcp: {
          sessionIdleTtlMs: 1,
          servers: { fixture: { url: server.url, transport: "streamable-http" } },
        },
      },
    });
    try {
      expect((await lease.runtime.getCatalog()).tools).toHaveLength(1);
    } finally {
      await releaseSessionMcpRuntime(lease);
    }
    clock.setTime(lease.runtime.lastUsedAt + 1);
    const sweep = manager.sweepIdleRuntimes();
    pending.push(sweep);
    await beforeSettlement(
      server.terminationStarted,
      sweep,
      "MCP idle sweep settled before disposal started",
    );
    expect(manager.peekSession({ sessionId })).toBeUndefined();
    const mutation = directSessionReq(method, { key: sessionKey }).then((result) => {
      mutationFinished = true;
      if (!result.ok) {
        throw new Error(`${method} failed: ${JSON.stringify(result.error)}`);
      }
      return result;
    });
    pending.push(mutation);
    await beforeSettlement(
      retirementStarted.promise,
      mutation,
      "Session cleanup settled before retiring MCP",
    );
    await nextTurn();
    expect(retirementFinished).toBe(false);
    expect(mutationFinished).toBe(false);
    const pendingEntry = readEntry();
    expect(pendingEntry?.sessionId).toBe(sessionId);
    expect(pendingEntry?.lifecycleRevision).toBe(initialEntry?.lifecycleRevision);
    terminate.resolve();
    await withinTest(sweep, signal);
    expect(await withinTest(mutation, signal)).toMatchObject({ ok: true });
    const entry = readEntry();
    if (method === "sessions.delete") {
      expect(entry).toBeUndefined();
    } else {
      expect(entry?.sessionId).toBe(sessionId);
      expect(entry?.lifecycleRevision).toEqual(expect.any(String));
      expect(entry?.lifecycleRevision).not.toBe(initialEntry?.lifecycleRevision);
    }
    expect(server.terminationCount()).toBe(1);
  },
);
