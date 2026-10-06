import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  replaceSessionEntry,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  readSessionColdTranscript,
  SessionTranscriptColdError,
} from "../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import * as hydration from "../config/sessions/session-transcript-hydration.js";
import { SessionTranscriptStorageUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  recordOpenClawAgentDatabaseOpenFailure,
  clearOpenClawAgentDatabaseOpenFailure,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readSessionPreviewItemsFromTranscriptAsync } from "./session-transcript-preview.js";
import { readTalkRealtimeInitialItems } from "./talk/session-history.js";

it("keeps missing preview storage absent and propagates terminal read refusal", async () => {
  await withOpenClawTestState({ label: "preview-reader-refusal" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "preview",
      sessionKey: "agent:main:preview",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await expect(
      readSessionPreviewItemsFromTranscriptAsync(scope, 3, 100, "model-context"),
    ).rejects.toBeInstanceOf(SessionTranscriptStorageUnavailableError);
    expect(fs.existsSync(scope.storePath)).toBe(false);
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const refusal = new Error("Synthetic terminal database refusal");
    recordOpenClawAgentDatabaseOpenFailure(scope.storePath, refusal);
    try {
      await expect(
        readSessionPreviewItemsFromTranscriptAsync(scope, 3, 100, "model-context"),
      ).rejects.toThrow(refusal);
    } finally {
      clearOpenClawAgentDatabaseOpenFailure(scope.storePath);
    }
  });
});

it("keeps widened model previews bound to their prepared storage environment", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const env = { OPENCLAW_STATE_DIR: state.stateDir };
    const scope = {
      agentId: "main",
      sessionId: "preview-captured-environment",
      sessionKey: "agent:main:preview-captured-environment",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      env,
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const history = SessionManager.inMemory("/synthetic/preview-capture");
    history.newSession({ id: scope.sessionId });
    history.appendMessage({ role: "user", content: "Retained question", timestamp: 1 });
    for (let index = 0; index < 65; index++) {
      history.appendMessage({
        role: "toolResult",
        toolCallId: `synthetic-call-${index}`,
        toolName: "synthetic_tool",
        content: [{ type: "text", text: "Tool activity" }],
        isError: false,
        timestamp: index + 2,
      });
    }
    await replaceTranscriptEvents(scope, history.getPersistedEntries());
    await waitForSessionTranscriptProjection(scope);
    const received = createDeferredCore();
    const release = createDeferredCore();
    const storageRoots = new Set<string | undefined>();
    const prepare = hydration.prepareSessionTranscriptHydration;
    let firstRead = true;
    const held = vi
      .spyOn(hydration, "prepareSessionTranscriptHydration")
      .mockImplementation((...args) => {
        const prepared = prepare(...args);
        const pause = firstRead;
        firstRead = false;
        storageRoots.add(prepared.target.env.OPENCLAW_STATE_DIR);
        return {
          ...prepared,
          read: async () => {
            const snapshot = await prepared.read();
            if (pause) {
              received.resolve();
              await release.promise;
            }
            return snapshot;
          },
        };
      });
    const pending = readSessionPreviewItemsFromTranscriptAsync(scope, 1, 100, "model-context");
    const outcome = pending.then(
      (items) => ({ items }),
      (error: unknown) => ({ error }),
    );
    try {
      await Promise.race([
        received.promise,
        outcome.then(() => {
          throw new Error("Preview settled before its hydration boundary");
        }),
      ]);
      env.OPENCLAW_STATE_DIR = state.statePath("replacement-namespace");
      release.resolve();
      expect(await outcome).toEqual({ items: [{ role: "user", text: "Retained question" }] });
      expect([...storageRoots]).toEqual([state.stateDir]);
    } finally {
      release.resolve();
      await outcome;
      held.mockRestore();
    }
  });
});

it("restores cold Talk history through its existing owner before bounded hydration", async () => {
  await withOpenClawTestState({ label: "preview-cold-history" }, async (state) => {
    const fixture = await createSessionColdStorageFixture(
      path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    );
    const history = SessionManager.inMemory("/synthetic/cold-history");
    history.newSession({ id: fixture.scope.sessionId });
    history.appendMessage({ role: "user", content: "Archived question", timestamp: 1 });
    history.appendMessage({ role: "user", content: "Archived followup", timestamp: 2 });
    await replaceTranscriptEvents(fixture.scope, history.getPersistedEntries());
    await waitForSessionTranscriptProjection(fixture.scope);
    fixture
      .database()
      .prepare(
        "UPDATE session_windows SET updated_at = 1, transcript_updated_at = 1 WHERE session_id = ?",
      )
      .run(fixture.scope.sessionId);
    const expected = [
      { role: "user", text: "Archived question" },
      { role: "user", text: "Archived followup" },
    ];
    expect(
      await readSessionPreviewItemsFromTranscriptAsync(fixture.scope, 16, 800, "model-context"),
    ).toEqual(expected);
    expect(
      await runSessionColdStorageMaintenance({
        config: maintenanceConfig(fixture.scope.storePath),
      }),
    ).toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
    await expect(
      readSessionPreviewItemsFromTranscriptAsync(fixture.scope, 16, 800, "model-context"),
    ).rejects.toBeInstanceOf(SessionTranscriptColdError);
    await replaceSessionEntry(fixture.scope, { sessionId: fixture.scope.sessionId, updatedAt: 1 });
    expect(readSessionColdTranscript(fixture.database(), fixture.scope.sessionId)).toBeDefined();
    const items = await readTalkRealtimeInitialItems(
      { ...fixture.scope, canonicalKey: fixture.scope.sessionKey },
      () => undefined,
    );
    expect(items).toEqual(expected);
    expect(readSessionColdTranscript(fixture.database(), fixture.scope.sessionId)).toBeUndefined();
  });
});

it("rejects Talk history when its live authority is revoked during real hydration", async () => {
  await withOpenClawTestState({ label: "preview-authority" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "preview",
      sessionKey: "agent:main:preview",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    SessionManager.open(scope).appendMessage({
      role: "user",
      content: "retained history",
      timestamp: 1,
    });
    await waitForSessionTranscriptProjection(scope);
    const received = createDeferredCore();
    const release = createDeferredCore();
    const prepare = hydration.prepareSessionTranscriptHydration;
    const held = vi
      .spyOn(hydration, "prepareSessionTranscriptHydration")
      .mockImplementationOnce((...args) => {
        const prepared = prepare(...args);
        return {
          ...prepared,
          read: async () => {
            const snapshot = await prepared.read();
            received.resolve();
            await release.promise;
            return snapshot;
          },
        };
      });
    let current = true;
    const pending = readTalkRealtimeInitialItems(
      { ...scope, canonicalKey: scope.sessionKey },
      () => {
        if (!current) {
          throw new Error("Synthetic Talk authority revoked");
        }
      },
    );
    const rejected = expect(pending).rejects.toThrow("Synthetic Talk authority revoked");
    try {
      await received.promise;
      current = false;
      release.resolve();
      await rejected;
      expect(
        await readSessionPreviewItemsFromTranscriptAsync(scope, 16, 800, "model-context"),
      ).toEqual([{ role: "user", text: "retained history" }]);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
      held.mockRestore();
    }
  });
});
