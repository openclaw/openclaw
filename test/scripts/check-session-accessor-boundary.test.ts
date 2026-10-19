import { afterAll, describe, expect, it } from "vitest";
import {
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
const issue = (line: number, reason: string) => ({ line, reason });
const counts = (
  sessionAccessorRead: Record<string, number>,
  sessionAccessorWrite?: Record<string, number>,
) => ({
  sessionAccessorRead,
  ...(sessionAccessorWrite === undefined ? {} : { sessionAccessorWrite }),
});

type ViolationFinder = typeof findSessionAccessorBoundaryViolations;
function check(
  find: ViolationFinder,
  source: string,
  family: string,
  ...expected: [line: number, action: string, name: string][]
) {
  expect(find(...parseFixture(source))).toEqual(
    expected.map(([line, action, name]) => ({
      line,
      reason: `${action} ${family} "${name}"`,
    })),
  );
}

describe("session accessor guards", () => {
  it("keeps Gateway read paths on non-materializing accessors", () => {
    expect(
      readOnlyGatewaySessionAccessorFiles.has("src/gateway/server-methods/sessions-read.ts"),
    ).toBe(true);
    check(
      findReadOnlySessionAccessorViolations,
      `
        import { listSessionEntriesCore, loadSessionEntry } from "../config/sessions/session-accessor.js";
        listSessionEntriesCore({ storePath });
        sessionUtils.loadSessionEntry(sessionKey);
      `,
      "materializing session entry accessor",
      [2, "imports", "listSessionEntriesCore"],
      [2, "imports", "loadSessionEntry"],
      [3, "calls", "listSessionEntriesCore"],
      [4, "references", "loadSessionEntry"],
    );
    check(
      findReadOnlySessionAccessorViolations,
      `
        import { listSessionEntriesReadOnly, loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
        listSessionEntriesReadOnly({ storePath });
        sessionUtils.loadSessionEntryReadOnly(sessionKey);
      `,
      "materializing session entry accessor",
    );
  });

  it("rejects retired beta.5 compatibility exports and aliases", () => {
    check(
      findSessionStoreRuntimeFileBackedCompatExportViolations,
      `
        export const loadSessionStore = loadSessionStoreImpl;
        export function updateSessionStore() {}
        export function resolveSessionFilePath() {}
        export { resolveSessionStoreEntry } from "../config/sessions/store-entry.js";
        export { resolveSessionFilePath as resolveLegacySessionFilePath, saveSessionStore } from "../config/sessions/paths.js";
      `,
      "retired file-backed SDK session helper",
      [2, "exports", "loadSessionStore"],
      [3, "exports", "updateSessionStore"],
      [4, "exports", "resolveSessionFilePath"],
      [5, "exports", "resolveSessionStoreEntry"],
      [6, "exports", "resolveSessionFilePath"],
      [6, "exports", "saveSessionStore"],
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
    check(
      findSessionAccessorBoundaryViolations,
      `
        const load = sessions.loadSessionStore;
        const { readSessionEntries: readEntries } = sessions;
        const { loadSessionStore } = sessions;
      `,
      "legacy session store access",
      [2, "references", "loadSessionStore"],
      [3, "aliases", "readSessionEntries"],
      [4, "aliases", "loadSessionStore"],
    );
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
    check(
      findMemoryHostSessionCorpusBoundaryViolations,
      `
        function loadViaHelper() { return readSessionTranscriptClassificationStore("sessions.json"); }
        function listSessionTranscriptCorpusEntriesForAgentSync(agentId) { return loadViaHelper(agentId); }
      `,
      "legacy memory-host session corpus helper",
      [2, "calls", "readSessionTranscriptClassificationStore"],
    );
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

  it("allows only the runtime SDK forwarding import, not legacy calls", () => {
    const source = 'import { updateLastRoute } from "../../plugin-sdk/session-store-runtime.js";';
    const runtimePath = "/repo/src/plugins/runtime/runtime-channel.ts";
    const inspect = (content: string, fileName = runtimePath) =>
      findSessionAccessorWriteBoundaryViolations(
        content,
        fileName,
        parser.parseSourceFile(fileName, content),
      );
    for (const [name, file] of [
      ["updateLastRoute", runtimePath],
      ["updateSessionStoreEntry", "/repo/src/plugins/runtime/runtime-agent.ts"],
    ] as const) {
      const forwarded = source.replaceAll("updateLastRoute", name);
      expect(inspect(`${forwarded}\nconst runtime = { ${name} };`, file)).toEqual([]);
      expect(inspect(`${forwarded}\n${name}(params);`, file)).toEqual([
        issue(2, `calls legacy session store writer "${name}"`),
      ]);
    }
    const registryPath = "/repo/src/plugins/registry-runtime-channel.ts";
    expect(inspect("channel.session.updateLastRoute(params);", registryPath)).toEqual([]);
    expect(inspect("other.session.updateLastRoute(params);", registryPath)).toEqual([
      { line: 1, reason: 'references legacy session store writer "updateLastRoute"' },
    ]);
    for (const [content, fileName] of [
      [source, "/repo/src/agents/other.ts"],
      [source.replace("{ updateLastRoute }", "{ updateLastRoute as update }"), runtimePath],
      [source.replace("plugin-sdk/session-store-runtime", "config/sessions"), runtimePath],
    ] as const) {
      expect(inspect(content, fileName)).toEqual([
        { line: 1, reason: 'imports legacy session store writer "updateLastRoute"' },
      ]);
    }
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
    check(
      findTranscriptWriterBoundaryViolations,
      `
        appendSessionTranscriptMessage({ transcriptPath, message });
        transcriptEvents.emitSessionTranscriptUpdate({ sessionFile });
        transcriptAppend["appendSessionTranscriptMessage"]({ transcriptPath, message });
      `,
      "legacy transcript writer",
      [2, "calls", "appendSessionTranscriptMessage"],
      [3, "references", "emitSessionTranscriptUpdate"],
      [4, "references", "appendSessionTranscriptMessage"],
    );
  });

  it("flags legacy writers inside the gateway sessions.create lifecycle", () => {
    check(
      findGatewaySessionCreateLifecycleViolations,
      `
        const handlers = {
          "sessions.create": async () => { await updateSessionStore(storePath, () => undefined); ensureSessionTranscriptFile(params); },
          "sessions.patch": async () => { await updateSessionStore(storePath, () => undefined); },
        };
      `,
      "legacy sessions.create lifecycle writer",
      [3, "calls", "updateSessionStore"],
      [3, "calls", "ensureSessionTranscriptFile"],
    );
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
    check(
      findSessionCompactManualTrimBoundaryViolations,
      `
        import { archiveFileOnDisk } from "../session-utils.js";
        import { readRecentSessionTranscriptLines } from "../session-transcript-readers.js";
        const tail = readRecentSessionTranscriptLines(scope);
        const archived = archiveFileOnDisk(filePath, "bak");
      `,
      "legacy session store manual compact trim",
      [2, "imports", "archiveFileOnDisk"],
      [3, "imports", "readRecentSessionTranscriptLines"],
      [4, "calls", "readRecentSessionTranscriptLines"],
      [5, "calls", "archiveFileOnDisk"],
    );
  });

  it("flags direct lifecycle cleanup helper usage", () => {
    check(
      findSessionLifecycleCleanupBoundaryViolations,
      `
        import { archiveRemovedSessionTranscripts } from "../config/sessions/store.js";
        import { cleanupArchivedSessionTranscripts } from "../gateway/session-utils.fs.js";
        archiveRemovedSessionTranscripts({ removedSessionFiles, referencedSessionIds, storePath, reason: "deleted" });
        cleanupArchivedSessionTranscripts({ directories, rules });
      `,
      "legacy session store lifecycle cleanup",
      [2, "imports", "archiveRemovedSessionTranscripts"],
      [3, "imports", "cleanupArchivedSessionTranscripts"],
      [4, "calls", "archiveRemovedSessionTranscripts"],
      [5, "calls", "cleanupArchivedSessionTranscripts"],
    );
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
        agentRuntime.runEmbeddedAgent({ sessionId, sessionKey, sessionFile });
        runEmbeddedAgent({ sessionId, sessionFile: transcriptPath });
      `),
      ),
    ).toEqual([
      issue(2, 'references legacy embedded-agent session file resolver "resolveSessionFilePath"'),
      ...[3, 4].map((line) =>
        issue(
          line,
          'passes deprecated embedded-agent runtime identity field "sessionFile"; use sessionTarget',
        ),
      ),
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
        counts({ "src/a.ts": 3, "src/unchanged.ts": 1 }, { "src/new.ts": 1 }),
        counts({ "src/a.ts": 2, "src/unchanged.ts": 1 }, {}),
      ),
    ).toEqual({
      regressions: [
        { concern: "sessionAccessorRead", path: "src/a.ts", currentCount: 3, baselineCount: 2 },
        { concern: "sessionAccessorWrite", path: "src/new.ts", currentCount: 1, baselineCount: 0 },
      ],
      improvements: [],
    });
  });

  it("fails with a regen instruction when counts drop below the baseline", () => {
    const debt = compareSessionAccessorDebt(
      counts({ "src/a.ts": 1 }),
      counts({ "src/a.ts": 2, "src/gone.ts": 3 }),
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
