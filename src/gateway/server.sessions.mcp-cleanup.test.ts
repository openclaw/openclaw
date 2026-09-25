// Registered reset/delete must join transports already retired by the MCP idle sweep.
import { afterEach, expect, test } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { startCatalogRecoveryMcpServer } from "../agents/agent-bundle-mcp-catalog-recovery.test-support.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
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

test.each(["sessions.reset", "sessions.delete"] as const)(
  "%s joins MCP idle disposal before mutating the session",
  async (method) => {
    const { dir, storePath } = await createSessionStoreDir();
    const sessionId = `idle-mcp-${method}`;
    const sessionKey = "agent:main:idle-mcp-cleanup";
    await writeSingleLineSession(dir, sessionId, "hello");
    await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
    const initialEntry = loadSessionEntry({ agentId: "main", sessionKey, storePath });
    expect(initialEntry).toBeDefined();
    await Promise.all([
      getSessionsHandlers(),
      import("./session-reset-service.js"),
      import("./server-methods/sessions-mutations.js"),
      import("./server-methods/sessions-delete.js"),
    ]);
    const { acquireSessionMcpRuntime, releaseSessionMcpRuntime, retireSessionMcpRuntime } =
      await import("../agents/agent-bundle-mcp-manager-api.js");
    const { createSessionMcpRuntimeManager } =
      await import("../agents/agent-bundle-mcp-manager.js");
    const { SESSION_MCP_RUNTIME_MANAGER_KEY } =
      await import("../agents/agent-bundle-mcp-runtime-shared.js");
    let nowMs = Date.now();
    const manager = createSessionMcpRuntimeManager({
      now: () => nowMs,
      enableIdleSweepTimer: false,
    });
    const terminate = createDeferred();
    const server = await startCatalogRecoveryMcpServer("idle-session-cleanup", {
      holdTermination: terminate.promise,
    });
    const retirementStarted = createDeferred();
    let retirementFinished = false;
    let mutationFinished = false;
    let sweep: Promise<number> | undefined;
    let mutation: ReturnType<typeof directSessionReq> | undefined;
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
    Object.defineProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: manager,
    });
    try {
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
      nowMs = lease.runtime.lastUsedAt + 1;
      sweep = manager.sweepIdleRuntimes();
      await withTestTimeout(server.terminationStarted, 2_000, "MCP idle disposal did not start");
      expect(manager.peekSession({ sessionId })).toBeUndefined();
      mutation = directSessionReq(method, { key: sessionKey }).then((result) => {
        mutationFinished = true;
        return result;
      });
      await withTestTimeout(retirementStarted.promise, 2_000, "Session cleanup did not retire MCP");
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(retirementFinished).toBe(false);
      expect(mutationFinished).toBe(false);
      const pendingEntry = loadSessionEntry({ agentId: "main", sessionKey, storePath });
      expect(pendingEntry?.sessionId).toBe(sessionId);
      expect(pendingEntry?.lifecycleRevision).toBe(initialEntry?.lifecycleRevision);
      terminate.resolve();
      await expect(sweep).resolves.toBe(1);
      expect(await mutation).toMatchObject({ ok: true });
      const entry = loadSessionEntry({ agentId: "main", sessionKey, storePath });
      if (method === "sessions.delete") {
        expect(entry).toBeUndefined();
      } else {
        expect(entry?.sessionId).toBe(sessionId);
        expect(entry?.lifecycleRevision).toEqual(expect.any(String));
        expect(entry?.lifecycleRevision).not.toBe(initialEntry?.lifecycleRevision);
      }
      expect(server.terminationCount()).toBe(1);
    } finally {
      terminate.resolve();
      await Promise.allSettled([sweep, mutation]);
      try {
        await manager.disposeAll();
      } finally {
        try {
          await server.close();
        } finally {
          if (previousManager) {
            Object.defineProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY, previousManager);
          } else {
            Reflect.deleteProperty(globalThis, SESSION_MCP_RUNTIME_MANAGER_KEY);
          }
        }
      }
    }
  },
);
