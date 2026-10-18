import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { readSessionColdTranscript } from "../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../config/sessions/session-cold-storage.js";
import {
  createSessionColdStorageFixture,
  maintenanceConfig,
} from "../config/sessions/session-cold-storage.test-support.js";
import * as hydration from "../config/sessions/session-transcript-hydration.js";
import { SessionTranscriptStorageUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { waitForSessionTranscriptProjection } from "../config/sessions/session-transcript-reconcile.js";
import { createDeferredCore } from "../shared/deferred.js";
import { recordOpenClawAgentDatabaseOpenFailure } from "../state/openclaw-agent-db-lifecycle.js";
import { clearOpenClawAgentDatabaseOpenFailure } from "../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { readSessionPreviewItemsFromTranscriptAsync } from "./session-transcript-preview.js";
import { readTalkRealtimeInitialItems } from "./talk/session-history.js";

function previewScope(state: OpenClawTestState, sessionId = "preview") {
  return {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:${sessionId}`,
    storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
  };
}

function readPreview(
  scope: Parameters<typeof readSessionPreviewItemsFromTranscriptAsync>[0],
  maxItems = 16,
  maxChars = 800,
) {
  return readSessionPreviewItemsFromTranscriptAsync(scope, maxItems, maxChars, "model-context");
}

function holdHydration(once = false) {
  const received = createDeferredCore();
  const release = createDeferredCore();
  const storageRoots = new Set<string | undefined>();
  const prepare = hydration.prepareSessionTranscriptHydration;
  let first = true;
  const intercept: typeof prepare = (...args) => {
    const prepared = prepare(...args);
    storageRoots.add(prepared.target.env.OPENCLAW_STATE_DIR);
    const pause = first;
    first = false;
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
  };
  const held = vi.spyOn(hydration, "prepareSessionTranscriptHydration");
  if (once) {
    held.mockImplementationOnce(intercept);
  } else {
    held.mockImplementation(intercept);
  }
  return { received, release, storageRoots, held };
}

it("keeps missing preview storage absent and propagates terminal read refusal", async () => {
  await withOpenClawTestState({ label: "preview-reader-refusal" }, async (state) => {
    const scope = previewScope(state);
    await expect(readPreview(scope, 3, 100)).rejects.toBeInstanceOf(
      SessionTranscriptStorageUnavailableError,
    );
    expect(fs.existsSync(scope.storePath)).toBe(false);
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const refusal = new Error("Synthetic terminal database refusal");
    recordOpenClawAgentDatabaseOpenFailure(scope.storePath, refusal);
    try {
      await expect(readPreview(scope, 3, 100)).rejects.toThrow(refusal);
    } finally {
      clearOpenClawAgentDatabaseOpenFailure(scope.storePath);
    }
  });
});

it("keeps widened model previews bound to their prepared storage environment", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const env = { OPENCLAW_STATE_DIR: state.stateDir };
    const scope = {
      ...previewScope(state, "preview-captured-environment"),
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
    const { received, release, storageRoots, held } = holdHydration();
    const pending = readPreview(scope, 1, 100);
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
    expect(await readPreview(fixture.scope)).toEqual(expected);
    expect(
      await runSessionColdStorageMaintenance({
        config: maintenanceConfig(fixture.scope.storePath),
      }),
    ).toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
    expect(readSessionColdTranscript(fixture.database(), fixture.scope.sessionId)).toBeDefined();
    await replaceSessionEntry(fixture.scope, { sessionId: fixture.scope.sessionId, updatedAt: 1 });
    expect(readSessionColdTranscript(fixture.database(), fixture.scope.sessionId)).toBeDefined();
    const items = await readTalkRealtimeInitialItems(
      { ...fixture.scope, canonicalKey: fixture.scope.sessionKey, assertCurrent: vi.fn() },
      () => undefined,
    );
    expect(items).toEqual(expected);
    expect(readSessionColdTranscript(fixture.database(), fixture.scope.sessionId)).toBeUndefined();
  });
});

it("rejects Talk history when its live authority is revoked during real hydration", async () => {
  await withOpenClawTestState({ label: "preview-authority" }, async (state) => {
    const scope = previewScope(state);
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    SessionManager.open(scope).appendMessage({
      role: "user",
      content: "retained history",
      timestamp: 1,
    });
    await waitForSessionTranscriptProjection(scope);
    const { received, release, held } = holdHydration(true);
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("Synthetic Talk authority revoked");
      }
    };
    const pending = readTalkRealtimeInitialItems(
      { ...scope, canonicalKey: scope.sessionKey, assertCurrent },
      assertCurrent,
    );
    const rejected = expect(pending).rejects.toThrow("Synthetic Talk authority revoked");
    try {
      await received.promise;
      current = false;
      release.resolve();
      await rejected;
      expect(await readPreview(scope)).toEqual([{ role: "user", text: "retained history" }]);
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
      held.mockRestore();
    }
  });
});
