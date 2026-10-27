import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import {
  createAdmittedRunOperatorAuthority,
  readRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../agents/admitted-run-context.js";
import { createAgentHarnessToolSurfaceRuntimeCore } from "../agents/harness/tool-surface-bridge.js";
import * as internalSessions from "../agents/internal-session-effects.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { refreshPreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { createStubTool } from "../agents/test-helpers/agent-tool-stubs.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadExactSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import * as hydration from "../config/sessions/session-transcript-hydration.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { defaultSessionCompanionContextReader } from "./session-companion-context.js";
import { sessionCompanionHandlers } from "./session-companion-rpc.js";
import { companionRuntimeConfig } from "./session-companion-runtime.test-support.js";
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
      const cfg: OpenClawConfig = companionRuntimeConfig(
        {
          agents: {
            entries: {
              main: {
                workspace: state.workspaceDir,
                models: { "test-provider/utility-model": { codeMode: true } },
                tools: { codeMode: true },
              },
            },
            defaults: {
              models: { "test-provider/utility-model": { codeMode: true } },
            },
          },
          plugins: { allow: [], slots: { memory: "none" } },
          tools: {
            codeMode: true,
            toolSearch: { enabled: true, mode: "directory" },
            sessions: { visibility: "all" },
            fs: { workspaceOnly: false },
          },
        },
        state.workspaceDir,
        "test-provider",
        ["test-model", "utility-model"],
      );
      const companion = createSessionCompanion({
        scheduler: createTestGatewayScheduler(),
        getConfig: () => cfg,
        contextReader: defaultSessionCompanionContextReader,
        sessionObserver: {
          getCompanionSnapshotAsync: async () => ({ agentId: "main", notes: [] }),
        },
      });
      const observedTools: string[][] = [];
      const observedModels: Array<{
        model: string | undefined;
        authority: AdmittedRunOperatorAuthority | undefined;
      }> = [];
      const internalTargets: Parameters<typeof SessionManager.open>[0][] = [];
      const seededHistory: unknown[][] = [];
      runLoop.mockImplementation(async (_refresh, { runParams }) => {
        observedModels.push({
          model: runParams.model,
          authority: readRunOperatorAuthority(runParams),
        });
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
        const committedConfig = { ...cfg, messages: { responsePrefix: "committed" } };
        setRuntimeConfigSnapshot(committedConfig);
        await refreshPreparedModelRuntimeSnapshots(committedConfig, {
          gatewayLifecycle: true,
          catalogMode: "static",
        });
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
            const target = await awaitGateBeforeSettlement(
              received.promise,
              pending,
              "Ask settled before hydration barrier",
            );
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
        const operatorAuthority = (allow: string[]) =>
          createAdmittedRunOperatorAuthority({
            profileId: "companion-reader",
            scopes: ["operator.read"],
            assertCurrent: () => {},
            modelPolicy: prepareOperatorModelPolicy({
              cfg,
              policy: { sourceAgent: "main", allow },
              manifestPlugins: [],
            }),
          });
        const authority = operatorAuthority(["test-provider/test-model"]);
        const deniedAuthority = operatorAuthority([]);
        const syncOpen = SessionManager.open.bind(SessionManager);
        const asyncOpen = SessionManager.openAsync.bind(SessionManager);
        let hydrationCount = 0;
        const hydrationFailures: unknown[] = [];
        const probeHydration = () => {
          const sql = observeMainThreadSql();
          return {
            [Symbol.dispose]() {
              hydrationCount++;
              try {
                sql.expectIdle();
              } catch (error) {
                hydrationFailures.push(error);
              } finally {
                sql.restore();
              }
            },
          };
        };
        const syncProbe = vi.spyOn(SessionManager, "open").mockImplementation((...args) => {
          using _ = probeHydration();
          return syncOpen(...args);
        });
        const asyncProbe = vi
          .spyOn(SessionManager, "openAsync")
          .mockImplementation(async (...args) => {
            using _ = probeHydration();
            return await asyncOpen(...args);
          });
        try {
          for (const question of ["What is it doing?", "What did I ask before?"]) {
            const respond = await invoke(question);
            expect(respond).toHaveBeenCalledWith(true, {
              answer: "The selected session is ready.",
              ts: expect.any(Number),
            });
          }
          await expect(
            companion.ask({
              agentId: "main",
              sessionKey: selected.sessionKey,
              question: "What is it doing now?",
              connId: "restricted-connection",
              operatorAuthority: authority,
            }),
          ).resolves.toMatchObject({ answer: "The selected session is ready." });
          await expect(
            companion.ask({
              agentId: "main",
              sessionKey: selected.sessionKey,
              question: "Use another model?",
              connId: "denied-connection",
              operatorAuthority: deniedAuthority,
            }),
          ).rejects.toThrow("Side chat");
        } finally {
          syncProbe.mockRestore();
          asyncProbe.mockRestore();
        }
        expect(observedModels).toEqual([
          { model: "utility-model", authority: undefined },
          { model: "utility-model", authority: undefined },
          { model: "test-model", authority },
        ]);
        expect(observedModels[2]?.authority).toBe(authority);
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
          Array.from({ length: 3 }, () => ["read", "sessions_history", "sessions_search"]),
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
