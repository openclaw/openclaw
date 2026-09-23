import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../agents/harness/tool-surface-bridge.js";
import * as internalSessions from "../agents/internal-session-effects.js";
import { refreshPreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { createStubTool } from "../agents/test-helpers/agent-tool-stubs.js";
import {
  loadExactSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import * as hydration from "../config/sessions/session-transcript-hydration.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { defaultSessionCompanionContextReader } from "./session-companion-context.js";
import { sessionCompanionHandlers } from "./session-companion-rpc.js";
import { createSessionCompanion } from "./session-companion.js";

const runLoop = vi.hoisted(() =>
  vi.fn<
    (typeof import("../agents/embedded-agent-runner/run-loop.js"))["runPreparedEmbeddedLoop"]
  >(),
);
vi.mock("../agents/embedded-agent-runner/run-loop.js", () => ({
  runPreparedEmbeddedLoop: runLoop,
}));

afterEach(async () => {
  vi.restoreAllMocks();
  runLoop.mockReset();
  await resetPreparedModelRuntimeSnapshotsForTest();
});

describe("Side chat with a published Gateway runtime", () => {
  it.each(["success", "request-abort", "disconnected"] as const)(
    "preserves registered ask history and read-only policy across %s hydration",
    async (outcome) => {
      const state = await createOpenClawTestState({
        label: "companion-runtime",
        env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
      });
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: { workspace: state.workspaceDir } },
          defaults: {
            workspace: state.workspaceDir,
            model: "test-provider/test-model",
            utilityModel: "test-provider/test-model",
          },
        },
        models: {
          providers: {
            "test-provider": {
              api: "openai-completions",
              apiKey: "synthetic-test-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: [
                {
                  id: "test-model",
                  name: "Test model",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 1024,
                },
              ],
            },
          },
        },
        plugins: { allow: [], slots: { memory: "none" } },
        tools: {
          codeMode: true,
          toolSearch: { enabled: true, mode: "directory" },
          sessions: { visibility: "all" },
          fs: { workspaceOnly: false },
        },
      };
      const companion = createSessionCompanion({
        getConfig: () => cfg,
        contextReader: defaultSessionCompanionContextReader,
        sessionObserver: { getCompanionSnapshot: () => ({ agentId: "main", notes: [] }) },
      });
      const observedTools: string[][] = [];
      const internalTargets: Parameters<typeof SessionManager.open>[0][] = [];
      const seededHistory: unknown[][] = [];
      runLoop.mockImplementation(async (_refresh, { runParams }) => {
        const target = runParams.sessionTarget;
        if (!target?.agentId || !target.sessionId || !target.sessionKey || !target.storePath) {
          throw new Error("Expected the run-owned internal session target");
        }
        internalTargets.push({
          ...target,
          agentId: target.agentId,
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
          storePath: target.storePath,
        });
        seededHistory.push(
          (await SessionManager.openAsync(internalTargets.at(-1)!)).buildSessionContext().messages,
        );
        const surface = createAgentHarnessToolSurfaceRuntimeCore({
          config: runParams.config,
          agentId: runParams.agentId,
          sessionId: runParams.sessionId,
          sessionKey: runParams.sessionKey,
          runId: runParams.runId,
          modelProvider: "test-provider",
          modelId: "test-model",
          codeModeOverride: runParams.codeModeOverride,
          disableToolSearch: runParams.disableToolSearch,
          toolsAllow: runParams.toolsAllow,
          modelToolsEnabled: true,
          executeTool: async () => ({ content: [], details: {} }),
        });
        try {
          expect.soft(surface.toolSearchControlsEnabled).toBe(false);
          observedTools.push(
            surface
              .compactTools(["read", "sessions_history", "sessions_search"].map(createStubTool))
              .tools.map((tool) => tool.name),
          );
          expect.soft(runParams.requireWorkspaceOnly).toBe(true);
          expect.soft(runParams.sessionReadScopeKey).toBe("agent:main:selected");
          expect.soft(runParams.sessionKey).not.toBe(runParams.sessionReadScopeKey);
          expect.soft(runParams.config?.messages?.responsePrefix).toBe("committed");
        } finally {
          surface.cleanup();
        }
        return {
          meta: { durationMs: 1, finalAssistantVisibleText: "The selected session is ready." },
        };
      });
      try {
        await state.writeConfig(cfg);
        const selected = {
          agentId: "main",
          sessionId: "selected-session",
          sessionKey: "agent:main:selected",
          storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
        };
        const seededEntry = { sessionId: selected.sessionId, updatedAt: 1 };
        await patchSessionEntryCore(selected, () => seededEntry, {
          fallbackEntry: seededEntry,
          // Prevent fixture-seed maintenance from overlapping the hydration SQL measurement.
          skipMaintenance: true,
        });
        const selectedManager = SessionManager.open(selected);
        selectedManager.appendMessage({
          role: "user",
          content: "Inspect the synthetic project.",
          timestamp: 1,
        });
        await waitForSessionTranscriptProjection(selected);
        const retained = selectedManager.getPersistedEntries();
        // Admission must use committed Gateway policy, not the caller's stale config.
        await refreshPreparedModelRuntimeSnapshots(
          { ...cfg, messages: { responsePrefix: "committed" } },
          { gatewayLifecycle: true, catalogMode: "static" },
        );
        // Keep source-module preparation outside the RPC deadline and hydration barrier.
        await import("../agents/embedded-agent-runner/run.js");
        let connected = true;
        const invoke = async (question: string, signal?: AbortSignal) => {
          const respond = vi.fn();
          await sessionCompanionHandlers["sessions.companion.ask"]!({
            params: { agentId: "main", sessionKey: selected.sessionKey, question },
            client: { connId: "test-connection" },
            context: {
              sessionCompanion: companion,
              getRuntimeConfig: () => cfg,
              isConnectionActive: () => connected,
            },
            respond,
            signal,
          } as never);
          return respond;
        };
        if (outcome !== "success") {
          const received = createDeferredCore<Parameters<typeof SessionManager.open>[0]>();
          const release = createDeferredCore();
          const cleaned = createDeferredCore();
          const prepare = hydration.prepareSessionTranscriptHydration;
          const hold = vi
            .spyOn(hydration, "prepareSessionTranscriptHydration")
            .mockImplementationOnce((...args) => {
              const prepared = prepare(...args);
              return {
                ...prepared,
                read: async () => {
                  const snapshot = await prepared.read();
                  received.resolve(prepared.target);
                  await release.promise;
                  return snapshot;
                },
              };
            });
          const remove = internalSessions.removeInternalSessionEffectsSession;
          const cleanup = vi
            .spyOn(internalSessions, "removeInternalSessionEffectsSession")
            .mockImplementation(async (...args) => {
              try {
                await remove(...args);
              } finally {
                cleaned.resolve();
              }
            });
          const controller = new AbortController();
          const pending = invoke("What is it doing?", controller.signal);
          try {
            const target = await Promise.race([
              received.promise,
              pending.then(() => {
                throw new Error("Ask settled before hydration barrier");
              }),
            ]);
            expect(
              loadTranscriptEventsSync(target).filter(
                (entry) => isRecord(entry) && entry.type === "message",
              ),
            ).toEqual([]);
            expect(runLoop).not.toHaveBeenCalled();
            if (outcome === "request-abort") {
              controller.abort(new Error("Synthetic request cancellation"));
            } else {
              connected = false;
            }
            release.resolve();
            const respond = await pending;
            expect(respond).toHaveBeenCalledWith(
              false,
              undefined,
              expect.objectContaining({ code: "UNAVAILABLE" }),
            );
            await cleaned.promise;
            expect(loadExactSessionEntry(target)).toBeUndefined();
            expect(runLoop).not.toHaveBeenCalled();
            expect(companion.state(selected).exchanges).toEqual([]);
            expect((await SessionManager.openAsync(selected)).getPersistedEntries()).toEqual(
              retained,
            );
          } finally {
            release.resolve();
            await pending;
            hold.mockRestore();
            cleanup.mockRestore();
          }
          return;
        }
        const syncOpen = SessionManager.open.bind(SessionManager);
        const asyncOpen = SessionManager.openAsync.bind(SessionManager);
        const nativeExec: unknown = Object.getOwnPropertyDescriptor(
          DatabaseSync.prototype,
          "exec",
        )?.value;
        if (typeof nativeExec !== "function") {
          throw new Error("Expected the native SQLite exec method");
        }
        let nextHydrationProbe = 0;
        const observeHydrationSql = (target: Parameters<typeof SessionManager.open>[0]) => {
          const execCalls: Array<{
            database: string | null | undefined;
            stack: string | undefined;
          }> = [];
          const sql = observeMainThreadSql();
          const exec = vi.spyOn(DatabaseSync.prototype, "exec");
          exec.mockImplementation(function (this: DatabaseSync, statement) {
            let database: string | null | undefined;
            try {
              database = this.location();
            } catch {
              // Diagnostic lookup must not replace the native operation's error.
              database = undefined;
            }
            const stackTraceLimit = Error.stackTraceLimit;
            let stack: string | undefined;
            try {
              // Coordinator callers can sit beyond the default ten stack frames.
              Error.stackTraceLimit = Math.max(stackTraceLimit, 32);
              stack = new Error("Observed SQLite exec").stack;
            } finally {
              Error.stackTraceLimit = stackTraceLimit;
            }
            execCalls.push({ database, stack });
            Reflect.apply(nativeExec, this, [statement]);
          });
          return {
            ...sql,
            diagnostics: {
              probe: ++nextHydrationProbe,
              agentId: target.agentId,
              sessionId: target.sessionId,
              storePath: target.storePath,
              execCalls,
            },
          };
        };
        let hydrationCount = 0;
        const hydrationFailures: unknown[] = [];
        const recordHydration = (sql: ReturnType<typeof observeHydrationSql>) => {
          hydrationCount++;
          try {
            sql.expectIdle();
          } catch (error) {
            console.error("Side chat hydration SQL diagnostics", JSON.stringify(sql.diagnostics));
            hydrationFailures.push(error);
          }
        };
        const syncProbe = vi.spyOn(SessionManager, "open").mockImplementation((...args) => {
          const sql = observeHydrationSql(args[0]);
          try {
            const result = syncOpen(...args);
            recordHydration(sql);
            return result;
          } finally {
            sql.restore();
          }
        });
        const asyncProbe = vi
          .spyOn(SessionManager, "openAsync")
          .mockImplementation(async (...args) => {
            const sql = observeHydrationSql(args[0]);
            try {
              const result = await asyncOpen(...args);
              recordHydration(sql);
              return result;
            } finally {
              sql.restore();
            }
          });
        try {
          for (const question of ["What is it doing?", "What did I ask before?"]) {
            const respond = await invoke(question);
            expect(respond).toHaveBeenCalledWith(true, {
              answer: "The selected session is ready.",
              ts: expect.any(Number),
            });
          }
        } finally {
          syncProbe.mockRestore();
          asyncProbe.mockRestore();
        }
        expect(hydrationCount).toBeGreaterThan(0);
        expect(hydrationFailures).toEqual([]);
        expect(seededHistory[0]).toEqual([
          expect.objectContaining({
            role: "assistant",
            content: [
              { type: "text", text: expect.stringContaining("Inspect the synthetic project.") },
            ],
          }),
        ]);
        expect(seededHistory[1]).toEqual([
          expect.objectContaining({ role: "assistant" }),
          expect.objectContaining({ role: "user", content: "What is it doing?" }),
          expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "The selected session is ready." }],
          }),
        ]);
        for (const target of internalTargets) {
          expect(loadExactSessionEntry(target)).toBeUndefined();
        }
        expect((await SessionManager.openAsync(selected)).getPersistedEntries()).toEqual(retained);
        expect(observedTools).toEqual(
          Array.from({ length: 2 }, () => ["read", "sessions_history", "sessions_search"]),
        );
        expect(cfg.tools?.toolSearch).toEqual({ enabled: true, mode: "directory" });
        expect(cfg.tools?.sessions?.visibility).toBe("all");
        expect(cfg.tools?.fs?.workspaceOnly).toBe(false);
      } finally {
        companion.dispose();
        await resetPreparedModelRuntimeSnapshotsForTest();
        await state.cleanup();
      }
    },
  );
});
