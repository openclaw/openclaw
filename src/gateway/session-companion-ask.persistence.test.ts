import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import * as internalSessionEffects from "../agents/internal-session-effects.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  applySessionEntryLifecycleMutation,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionCompanion } from "./session-companion.js";

const runEmbeddedAgent = vi.hoisted(() => vi.fn());
// mock-isolation: Exercise real companion persistence without starting model execution.
vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent }));
// mock-isolation: Persistence tests use a fixed synthetic model selection without provider discovery.
vi.mock("../agents/simple-completion-runtime.js", () => ({
  resolveSimpleCompletionSelectionForAgent: () => ({ provider: "test", modelId: "model-a" }),
}));

afterEach(() => vi.restoreAllMocks());

it.each<[string, Partial<InternalSessionEntry> | undefined]>([
  ["missing", undefined],
  ["replaced", { sessionId: "replacement" }],
  ["reset with the same id", { lifecycleRevision: "replacement-lifecycle" }],
  ["claimed by another writer", { activeWriterRunId: "replacement-writer" }],
])(
  "refuses companion history persistence when the session is %s before admission",
  async (_change, replacement) => {
    await withOpenClawTestState({ label: "companion-seed-owner" }, async () => {
      runEmbeddedAgent.mockClear();
      const prepare = internalSessionEffects.prepareInternalSessionEffectsSession;
      let prepared: Awaited<ReturnType<typeof prepare>> | undefined;
      vi.spyOn(internalSessionEffects, "prepareInternalSessionEffectsSession").mockImplementation(
        async (params) => {
          prepared = await prepare(params);
          return prepared;
        },
      );
      const open = SessionManager.openAsync.bind(SessionManager);
      let changedEntry: InternalSessionEntry | undefined;
      let originalEvents: Awaited<ReturnType<typeof loadTranscriptEvents>> = [];
      vi.spyOn(SessionManager, "openAsync").mockImplementationOnce(async (...args) => {
        const manager = await open(...args);
        const target = expectDefined(prepared, "prepared companion session");
        if (replacement) {
          changedEntry = expectDefined(
            await replaceSessionEntry(target, { ...target.sessionEntry, ...replacement }),
            "replacement companion session",
          );
        } else {
          await applySessionEntryLifecycleMutation({
            agentId: target.agentId,
            storePath: target.storePath,
            removals: [{ sessionKey: target.sessionKey, archiveRemovedTranscript: false }],
            skipMaintenance: true,
          });
        }
        originalEvents = await loadTranscriptEvents(target);
        return manager;
      });
      const companion = createSessionCompanion({
        scheduler: createTestGatewayScheduler(),
        getConfig: () => ({ agents: { defaults: { utilityModel: "test/model-a" } } }),
        contextReader: {
          currentSessionId: async () => "session-1",
          read: async () => ({
            kind: "ready",
            context: { empty: true, messages: [], sessionId: "session-1" },
          }),
        },
        sessionObserver: {
          getCompanionSnapshotAsync: async () => ({ agentId: "main", notes: [] }),
        },
      });
      try {
        await expect(
          companion.ask({
            agentId: "main",
            sessionKey: "agent:main:main",
            question: "What is it doing?",
            connId: "conn-1",
            ownerId: "shared",
          }),
        ).rejects.toThrow("Side chat could not answer right now.");
        const target = expectDefined(prepared, "prepared companion session");
        expect(runEmbeddedAgent).not.toHaveBeenCalled();
        await expect(loadTranscriptEvents(target)).resolves.toEqual(originalEvents);
        await expect(readSessionEntryReadOnlyInWorker(target)).resolves.toEqual(changedEntry);
      } finally {
        companion.dispose();
      }
    });
  },
);
