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

async function duringHydration<T>(read: () => Promise<T>, mutate: () => void, once = false) {
  const storageRoots = new Set<string | undefined>();
  const prepare = hydration.prepareSessionTranscriptHydration;
  let first = true;
  const mutation = vi.fn(mutate);
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
          mutation();
        }
        return snapshot;
      },
    };
  };
  const held = vi.spyOn(hydration, "prepareSessionTranscriptHydration");
  held[once ? "mockImplementationOnce" : "mockImplementation"](intercept);
  try {
    const items = await read();
    expect(mutation).toHaveBeenCalledOnce();
    return { items, storageRoots: [...storageRoots] };
  } finally {
    held.mockRestore();
  }
}

async function persistHistory(
  scope: ReturnType<typeof previewScope>,
  texts: string[],
  toolCount = 0,
) {
  const history = SessionManager.inMemory("/synthetic/preview-history");
  history.newSession({ id: scope.sessionId });
  texts.forEach((content, index) =>
    history.appendMessage({ role: "user", content, timestamp: index + 1 }),
  );
  for (let index = 0; index < toolCount; index++) {
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
}

function readTalk(scope: ReturnType<typeof previewScope>, assertCurrent: () => void = vi.fn()) {
  return readTalkRealtimeInitialItems(
    { ...scope, canonicalKey: scope.sessionKey, assertCurrent },
    assertCurrent,
  );
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
    const scope = { ...previewScope(state, "preview-captured-environment"), env };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await persistHistory(scope, ["Retained question"], 65);
    const result = await duringHydration(
      () => readPreview(scope, 1, 100),
      () => {
        env.OPENCLAW_STATE_DIR = state.statePath("replacement-namespace");
      },
    );
    expect(result).toEqual({
      items: [{ role: "user", text: "Retained question" }],
      storageRoots: [state.stateDir],
    });
  });
});

it("restores cold Talk history through its existing owner before bounded hydration", async () => {
  await withOpenClawTestState({ label: "preview-cold-history" }, async (state) => {
    const fixture = await createSessionColdStorageFixture(
      path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    );
    const texts = ["Archived question", "Archived followup"];
    await persistHistory(fixture.scope, texts);
    const database = fixture.database();
    database
      .prepare(
        "UPDATE session_windows SET updated_at = 1, transcript_updated_at = 1 WHERE session_id = ?",
      )
      .run(fixture.scope.sessionId);
    const expected = texts.map((text) => ({ role: "user", text }));
    expect(await readPreview(fixture.scope)).toEqual(expected);
    expect(
      await runSessionColdStorageMaintenance({
        config: maintenanceConfig(fixture.scope.storePath),
      }),
    ).toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
    const coldTranscript = () => readSessionColdTranscript(database, fixture.scope.sessionId);
    expect(coldTranscript()).toBeDefined();
    await replaceSessionEntry(fixture.scope, { sessionId: fixture.scope.sessionId, updatedAt: 1 });
    expect(coldTranscript()).toBeDefined();
    expect(await readTalk(fixture.scope)).toEqual(expected);
    expect(coldTranscript()).toBeUndefined();
  });
});

it("rejects Talk history when its live authority is revoked during real hydration", async () => {
  await withOpenClawTestState({ label: "preview-authority" }, async (state) => {
    const scope = previewScope(state);
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    await persistHistory(scope, ["retained history"]);
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("Synthetic Talk authority revoked");
      }
    };
    const pending = duringHydration(
      () => readTalk(scope, assertCurrent),
      () => {
        current = false;
      },
      true,
    );
    await expect(pending).rejects.toThrow("Synthetic Talk authority revoked");
    expect(await readPreview(scope)).toEqual([{ role: "user", text: "retained history" }]);
  });
});
