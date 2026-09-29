import { afterAll, describe, expect, it } from "vitest";
import {
  collectSessionStoreRuntimeFileBackedCompatExports,
  compareSessionAccessorDebt,
  findGatewaySessionCreateLifecycleViolations,
  findEmbeddedAgentSessionTargetViolations,
  findMemoryHostSessionCorpusBoundaryViolations,
  findReadOnlySessionAccessorViolations,
  findSessionAccessorBoundaryViolations,
  findSessionCompactManualTrimBoundaryViolations,
  findSessionAccessorWriteBoundaryViolations,
  findSessionLifecycleCleanupBoundaryViolations,
  findSessionStoreRuntimeFileBackedCompatExportViolations,
  findTranscriptWriterBoundaryViolations,
  formatSessionAccessorDebtImprovements,
  readOnlyGatewaySessionAccessorFiles,
} from "../../scripts/check-session-accessor-boundary.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function parseFixture(content: string) {
  return [content, "source.ts", parser.parseSourceFile("source.ts", content)] as const;
}

describe("session accessor boundary guard", () => {
  it("keeps Gateway read paths on non-materializing accessors", () => {
    expect(
      readOnlyGatewaySessionAccessorFiles.has("src/gateway/server-methods/sessions-read.ts"),
    ).toBe(true);
    expect(
      findReadOnlySessionAccessorViolations(
        ...parseFixture(`
        import { listSessionEntriesCore, loadSessionEntry } from "../config/sessions/session-accessor.js";
        listSessionEntriesCore({ storePath });
        sessionUtils.loadSessionEntry(sessionKey);
      `),
      ),
    ).toEqual([
      { line: 2, reason: 'imports materializing session entry accessor "listSessionEntriesCore"' },
      { line: 2, reason: 'imports materializing session entry accessor "loadSessionEntry"' },
      { line: 3, reason: 'calls materializing session entry accessor "listSessionEntriesCore"' },
      { line: 4, reason: 'references materializing session entry accessor "loadSessionEntry"' },
    ]);
    expect(
      findReadOnlySessionAccessorViolations(
        ...parseFixture(`
        import { listSessionEntriesReadOnly, loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
        listSessionEntriesReadOnly({ storePath });
        sessionUtils.loadSessionEntryReadOnly(sessionKey);
      `),
      ),
    ).toEqual([]);
  });

  it("allows the exact beta.5 compatibility exports without opening aliases", () => {
    expect(
      findSessionStoreRuntimeFileBackedCompatExportViolations(
        ...parseFixture(`
        export function loadSessionStore() {}
        export function updateSessionStore() {}
        export function resolveSessionFilePath() {}
        export { resolveSessionStoreEntry } from "../config/sessions/store-entry.js";
      `),
      ),
    ).toEqual([]);
    expect(
      findSessionStoreRuntimeFileBackedCompatExportViolations(
        ...parseFixture(`
        export { resolveSessionFilePath as resolveLegacySessionFilePath } from "../config/sessions/paths.js";
        export { saveSessionStore } from "../config/sessions/store.js";
      `),
      ),
    ).toEqual([
      {
        line: 2,
        reason: 'exports unratcheted file-backed SDK session helper "resolveSessionFilePath"',
      },
      {
        line: 3,
        reason: 'exports unratcheted file-backed SDK session helper "saveSessionStore"',
      },
    ]);
  });

  it("collects file-backed SDK session compatibility exports", () => {
    expect(
      collectSessionStoreRuntimeFileBackedCompatExports(
        ...parseFixture(`
        export const loadSessionStore = loadSessionStoreImpl;
        export { resolveSessionFilePath } from "../config/sessions/paths.js";
        export { saveSessionStore, updateSessionStore } from "../config/sessions/store.js";
      `),
      ),
    ).toEqual(
      new Map([
        ["loadSessionStore", { line: 2, sourceName: "loadSessionStore" }],
        ["resolveSessionFilePath", { line: 3, sourceName: "resolveSessionFilePath" }],
        ["saveSessionStore", { line: 4, sourceName: "saveSessionStore" }],
        ["updateSessionStore", { line: 4, sourceName: "updateSessionStore" }],
      ]),
    );
  });

  it("flags legacy reader imports", () => {
    expect(
      findSessionAccessorBoundaryViolations(
        ...parseFixture(`
        import { loadSessionStore, readSessionEntries as readEntries } from "../config/sessions.js";
        import { readSessionEntry, readSessionStoreReadOnly } from "../config/sessions/store-load.js";
      `),
      ),
    ).toEqual([
      { line: 2, reason: 'imports legacy session store access "loadSessionStore"' },
      { line: 2, reason: 'imports legacy session store access "readSessionEntries"' },
      { line: 3, reason: 'imports legacy session store access "readSessionEntry"' },
      { line: 3, reason: 'imports legacy session store access "readSessionStoreReadOnly"' },
    ]);
  });

  it("flags direct and namespace legacy access calls", () => {
    expect(
      findSessionAccessorBoundaryViolations(
        ...parseFixture(`
        loadSessionStore(storePath);
        sessions.readSessionEntries(storePath);
        sessions["loadSessionStore"](storePath);
        readSessionStoreReadOnly(storePath);
        resolveSessionStoreEntry({ store, sessionKey });
        resolveSessionStoreEntryCore({ store, sessionKey });
      `),
      ),
    ).toEqual([
      { line: 2, reason: 'calls legacy session store access "loadSessionStore"' },
      { line: 3, reason: 'references legacy session store access "readSessionEntries"' },
      { line: 4, reason: 'references legacy session store access "loadSessionStore"' },
      { line: 5, reason: 'calls legacy session store access "readSessionStoreReadOnly"' },
      { line: 6, reason: 'calls legacy session store access "resolveSessionStoreEntry"' },
      { line: 7, reason: 'calls legacy session store access "resolveSessionStoreEntryCore"' },
    ]);
  });

  it("flags aliased namespace reader references", () => {
    expect(
      findSessionAccessorBoundaryViolations(
        ...parseFixture(`
        const load = sessions.loadSessionStore;
        const { readSessionEntries: readEntries } = sessions;
        const { loadSessionStore } = sessions;
      `),
      ),
    ).toEqual([
      { line: 2, reason: 'references legacy session store access "loadSessionStore"' },
      { line: 3, reason: 'aliases legacy session store access "readSessionEntries"' },
      { line: 4, reason: 'aliases legacy session store access "loadSessionStore"' },
    ]);
  });

  it("flags legacy whole-store writes", () => {
    expect(
      findSessionAccessorBoundaryViolations(
        ...parseFixture(`
        import { saveSessionStore, updateSessionStore } from "../config/sessions.js";
        saveSessionStore(storePath, store);
        updateSessionStore(storePath, update);
      `),
      ),
    ).toEqual([
      { line: 2, reason: 'imports legacy session store access "saveSessionStore"' },
      { line: 2, reason: 'imports legacy session store access "updateSessionStore"' },
      { line: 3, reason: 'calls legacy session store access "saveSessionStore"' },
      { line: 4, reason: 'calls legacy session store access "updateSessionStore"' },
    ]);
  });

  it("allows migrated accessor reads", () => {
    expect(
      findSessionAccessorBoundaryViolations(
        ...parseFixture(`
        import { listSessionEntriesCore } from "../config/sessions/session-accessor.js";
        listSessionEntriesCore({ storePath });
      `),
      ),
    ).toEqual([]);
  });

  it("flags legacy memory-host corpus classification calls in migrated entrypoints", () => {
    expect(
      findMemoryHostSessionCorpusBoundaryViolations(
        ...parseFixture(`
        function listSessionTranscriptCorpusEntriesForAgentSync(agentId) {
          return loadSessionTranscriptClassificationForSessionsDir(resolveSessionTranscriptsDirForAgent(agentId));
        }
        export async function listSessionFilesForAgent(agentId) {
          return readSessionTranscriptClassificationStore("sessions.json");
        }
      `),
      ),
    ).toEqual([
      {
        line: 3,
        reason:
          'calls legacy memory-host session corpus helper "loadSessionTranscriptClassificationForSessionsDir"',
      },
      {
        line: 6,
        reason:
          'calls legacy memory-host session corpus helper "readSessionTranscriptClassificationStore"',
      },
    ]);
  });

  it("follows memory-host corpus helper calls when checking legacy access", () => {
    expect(
      findMemoryHostSessionCorpusBoundaryViolations(
        ...parseFixture(`
        function loadViaHelper() {
          return readSessionTranscriptClassificationStore("sessions.json");
        }
        function listSessionTranscriptCorpusEntriesForAgentSync(agentId) {
          return loadViaHelper(agentId);
        }
      `),
      ),
    ).toEqual([
      {
        line: 3,
        reason:
          'calls legacy memory-host session corpus helper "readSessionTranscriptClassificationStore"',
      },
    ]);
  });

  it("allows memory-host corpus entrypoints to use the accessor-backed corpus helper", () => {
    expect(
      findMemoryHostSessionCorpusBoundaryViolations(
        ...parseFixture(`
        function listSessionTranscriptCorpusEntriesForAgentSync(agentId) {
          return listSessionEntriesCore({ agentId });
        }
        export async function listSessionFilesForAgent(agentId) {
          return (await listSessionTranscriptCorpusEntriesForAgent(agentId)).map((entry) => entry.sessionFile);
        }
      `),
      ),
    ).toEqual([]);
  });

  it("flags legacy writer imports and calls", () => {
    expect(
      findSessionAccessorWriteBoundaryViolations(
        ...parseFixture(`
        import { applySessionStoreEntryPatch, saveSessionStore, updateSessionStore, updateSessionStoreEntry as updateEntry } from "../config/sessions.js";
        saveSessionStore(storePath, store);
        updateSessionStore(storePath, () => undefined);
        sessions.updateSessionStoreEntry({ storePath, sessionKey, update });
        applySessionStoreEntryPatch({ storePath, sessionKey, patch });
      `),
      ),
    ).toEqual([
      { line: 2, reason: 'imports legacy session store writer "applySessionStoreEntryPatch"' },
      { line: 2, reason: 'imports legacy session store writer "saveSessionStore"' },
      { line: 2, reason: 'imports legacy session store writer "updateSessionStore"' },
      { line: 2, reason: 'imports legacy session store writer "updateSessionStoreEntry"' },
      { line: 3, reason: 'calls legacy session store writer "saveSessionStore"' },
      { line: 4, reason: 'calls legacy session store writer "updateSessionStore"' },
      { line: 5, reason: 'references legacy session store writer "updateSessionStoreEntry"' },
      { line: 6, reason: 'calls legacy session store writer "applySessionStoreEntryPatch"' },
    ]);
  });

  it("allows migrated accessor writes", () => {
    expect(
      findSessionAccessorWriteBoundaryViolations(
        ...parseFixture(`
        import { updateSessionEntry } from "../config/sessions/session-accessor.js";
        updateSessionEntry({ storePath, sessionKey }, () => undefined);
      `),
      ),
    ).toEqual([]);
  });

  it("flags legacy transcript writer imports", () => {
    expect(
      findTranscriptWriterBoundaryViolations(
        ...parseFixture(`
        import { appendSessionTranscriptMessage } from "../config/sessions/transcript-append.test-support.js";
        import { emitSessionTranscriptUpdate as emitUpdate } from "../sessions/transcript-events.js";
      `),
      ),
    ).toEqual([
      { line: 2, reason: 'imports legacy transcript writer "appendSessionTranscriptMessage"' },
      { line: 3, reason: 'imports legacy transcript writer "emitSessionTranscriptUpdate"' },
    ]);
  });
  it("flags direct and namespace legacy transcript writer calls", () => {
    expect(
      findTranscriptWriterBoundaryViolations(
        ...parseFixture(`
        appendSessionTranscriptMessage({ transcriptPath, message });
        transcriptEvents.emitSessionTranscriptUpdate({ sessionFile });
        transcriptAppend["appendSessionTranscriptMessage"]({ transcriptPath, message });
      `),
      ),
    ).toEqual([
      { line: 2, reason: 'calls legacy transcript writer "appendSessionTranscriptMessage"' },
      { line: 3, reason: 'references legacy transcript writer "emitSessionTranscriptUpdate"' },
      { line: 4, reason: 'references legacy transcript writer "appendSessionTranscriptMessage"' },
    ]);
  });

  it("allows migrated transcript writer helpers", () => {
    expect(
      findTranscriptWriterBoundaryViolations(
        ...parseFixture(`
        import { appendTranscriptMessage, publishTranscriptUpdate } from "../config/sessions/session-accessor.js";
        appendTranscriptMessage(scope, { message });
        publishTranscriptUpdate(scope, { messageId });
      `),
      ),
    ).toEqual([]);
  });

  it("flags legacy writers inside the gateway sessions.create lifecycle", () => {
    expect(
      findGatewaySessionCreateLifecycleViolations(
        ...parseFixture(`
        const handlers = {
          "sessions.create": async () => {
            await updateSessionStore(storePath, () => undefined);
            ensureSessionTranscriptFile(params);
          },
          "sessions.patch": async () => {
            await updateSessionStore(storePath, () => undefined);
          },
        };
      `),
      ),
    ).toEqual([
      { line: 4, reason: 'calls legacy sessions.create lifecycle writer "updateSessionStore"' },
      {
        line: 5,
        reason: 'calls legacy sessions.create lifecycle writer "ensureSessionTranscriptFile"',
      },
    ]);
  });

  it("allows the gateway sessions.create lifecycle accessor seam", () => {
    expect(
      findGatewaySessionCreateLifecycleViolations(
        ...parseFixture(`
        const handlers = {
          "sessions.create": async () => {
            await createSessionEntryWithTranscript(scope, createEntry);
          },
        };
      `),
      ),
    ).toEqual([]);
  });

  it("flags gateway manual compact trim file mutations", () => {
    expect(
      findSessionCompactManualTrimBoundaryViolations(
        ...parseFixture(`
        import { archiveFileOnDisk } from "../session-utils.js";
        import { readRecentSessionTranscriptLines } from "../session-transcript-readers.js";
        const tail = readRecentSessionTranscriptLines(scope);
        const archived = archiveFileOnDisk(filePath, "bak");
      `),
      ),
    ).toEqual([
      { line: 2, reason: 'imports legacy session store manual compact trim "archiveFileOnDisk"' },
      {
        line: 3,
        reason:
          'imports legacy session store manual compact trim "readRecentSessionTranscriptLines"',
      },
      {
        line: 4,
        reason: 'calls legacy session store manual compact trim "readRecentSessionTranscriptLines"',
      },
      { line: 5, reason: 'calls legacy session store manual compact trim "archiveFileOnDisk"' },
    ]);
  });

  it("flags direct lifecycle cleanup helper usage", () => {
    expect(
      findSessionLifecycleCleanupBoundaryViolations(
        ...parseFixture(`
        import { archiveRemovedSessionTranscripts } from "../config/sessions/store.js";
        import { cleanupArchivedSessionTranscripts } from "../gateway/session-utils.fs.js";
        archiveRemovedSessionTranscripts({ removedSessionFiles, referencedSessionIds, storePath, reason: "deleted" });
        cleanupArchivedSessionTranscripts({ directories, rules });
      `),
      ),
    ).toEqual([
      {
        line: 2,
        reason: 'imports legacy session store lifecycle cleanup "archiveRemovedSessionTranscripts"',
      },
      {
        line: 3,
        reason:
          'imports legacy session store lifecycle cleanup "cleanupArchivedSessionTranscripts"',
      },
      {
        line: 4,
        reason: 'calls legacy session store lifecycle cleanup "archiveRemovedSessionTranscripts"',
      },
      {
        line: 5,
        reason: 'calls legacy session store lifecycle cleanup "cleanupArchivedSessionTranscripts"',
      },
    ]);
  });

  it("ignores comments and strings that describe legacy readers", () => {
    expect(
      findSessionAccessorBoundaryViolations(
        ...parseFixture(`
        // loadSessionStore and readSessionEntries used to be called here.
        const description = "loadSessionStore";
      `),
      ),
    ).toEqual([]);
  });

  it("flags embedded-agent calls that pass deprecated sessionFile identity", () => {
    expect(
      findEmbeddedAgentSessionTargetViolations(
        ...parseFixture(`
        const sessionFile = agentRuntime.session.resolveSessionFilePath(sessionId, entry);
        agentRuntime.runEmbeddedAgent({
          sessionId,
          sessionKey,
          sessionFile,
        });
        runEmbeddedAgent({
          sessionId,
          sessionFile: transcriptPath,
        });
      `),
      ),
    ).toEqual([
      {
        line: 2,
        reason: 'references legacy embedded-agent session file resolver "resolveSessionFilePath"',
      },
      {
        line: 6,
        reason:
          'passes deprecated embedded-agent runtime identity field "sessionFile"; use sessionTarget',
      },
      {
        line: 10,
        reason:
          'passes deprecated embedded-agent runtime identity field "sessionFile"; use sessionTarget',
      },
    ]);
  });

  it("allows embedded-agent calls that pass sessionTarget identity", () => {
    expect(
      findEmbeddedAgentSessionTargetViolations(
        ...parseFixture(`
        agentRuntime.runEmbeddedAgent({
          sessionId,
          sessionKey,
          sessionTarget: { agentId, sessionId, sessionKey, storePath },
        });
      `),
      ),
    ).toEqual([]);
  });
});

describe("session accessor debt ratchet", () => {
  it("flags unmigrated files whose legacy call-site count exceeds the baseline", () => {
    expect(
      compareSessionAccessorDebt(
        {
          sessionAccessorRead: { "src/a.ts": 3 },
          sessionAccessorWrite: { "src/new.ts": 1 },
        },
        {
          sessionAccessorRead: { "src/a.ts": 2 },
          sessionAccessorWrite: {},
        },
      ),
    ).toEqual({
      regressions: [
        { concern: "sessionAccessorRead", path: "src/a.ts", currentCount: 3, baselineCount: 2 },
        { concern: "sessionAccessorWrite", path: "src/new.ts", currentCount: 1, baselineCount: 0 },
      ],
      improvements: [],
    });
  });

  it("passes when counts match the baseline", () => {
    expect(
      compareSessionAccessorDebt(
        { sessionAccessorRead: { "src/a.ts": 2 } },
        { sessionAccessorRead: { "src/a.ts": 2 } },
      ),
    ).toEqual({ regressions: [], improvements: [] });
  });

  it("fails with a regen instruction when counts drop below the baseline", () => {
    const debt = compareSessionAccessorDebt(
      { sessionAccessorRead: { "src/a.ts": 1 } },
      { sessionAccessorRead: { "src/a.ts": 2, "src/gone.ts": 3 } },
    );
    expect(debt).toEqual({
      regressions: [],
      improvements: [
        { concern: "sessionAccessorRead", path: "src/a.ts", currentCount: 1, baselineCount: 2 },
        { concern: "sessionAccessorRead", path: "src/gone.ts", currentCount: 0, baselineCount: 3 },
      ],
    });
    expect(formatSessionAccessorDebtImprovements(debt.improvements)).toEqual([
      "Legacy session accessor debt dropped below scripts/lib/session-accessor-debt-baseline.json:",
      "- src/a.ts [sessionAccessorRead]: 1 legacy call site(s), stale baseline allows 2",
      "- src/gone.ts [sessionAccessorRead]: 0 legacy call site(s), stale baseline allows 3",
      "Run `pnpm lint:tmp:session-accessor-boundary:gen` to ratchet the baseline down and commit it.",
    ]);
  });
});
