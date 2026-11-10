import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  compareSessionAccessorDebt,
  collectSessionAccessorSyntaxFacts,
  collectSessionAccessorFindings,
  findEmbeddedAgentSessionTargetViolations,
  findGatewaySessionCreateLifecycleViolations,
  findMemoryHostSessionCorpusBoundaryViolations,
  findReadOnlySessionAccessorViolations,
  findSessionAccessorBoundaryViolations,
  findSessionAccessorWriteBoundaryViolations,
  findSessionStoreRuntimeFileBackedCompatExportViolations,
  formatSessionAccessorDebtImprovements,
} from "../../scripts/check-session-accessor-boundary.mts";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function parseFixture(content: string) {
  return [
    content,
    "source.ts",
    collectSessionAccessorSyntaxFacts(parser.parseSourceFile("source.ts", content)),
  ] as const;
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
  it.each([
    [
      "non-materializing reads",
      findReadOnlySessionAccessorViolations,
      'import { listSessionEntriesReadOnly, loadSessionEntryReadOnly } from "./session-accessor.js"; listSessionEntriesReadOnly(); sessionUtils.loadSessionEntryReadOnly();',
    ],
    [
      "migrated reads",
      findSessionAccessorBoundaryViolations,
      'import { listSessionEntriesCore } from "./session-accessor.js"; listSessionEntriesCore();',
    ],
    [
      "accessor-backed corpus",
      findMemoryHostSessionCorpusBoundaryViolations,
      "function listSessionTranscriptCorpusEntriesForAgentSync() { return listSessionEntriesCore(); } export async function listSessionFilesForAgent() { return (await listSessionTranscriptCorpusEntriesForAgent()).map(entry => entry.sessionFile); }",
    ],
    [
      "comments and strings",
      findSessionAccessorBoundaryViolations,
      '// resolveSessionStoreEntryCore must not be called here.\nconst description = "resolveSessionStoreEntryCore";',
    ],
    [
      "sessionTarget identity",
      findEmbeddedAgentSessionTargetViolations,
      "agentRuntime.runEmbeddedAgent({ sessionId, sessionKey, sessionTarget: { agentId, sessionId, sessionKey, storePath } });",
    ],
  ] as const)("allows %s", (_name, find, source) => {
    expect(find(...parseFixture(source))).toEqual([]);
  });

  it("rejects file-backed SDK exports and aliases", () => {
    check(
      findSessionStoreRuntimeFileBackedCompatExportViolations,
      `
        export const resolveAndPersistSessionFile = resolveFile;
        export function resolveSessionFilePath() {}
        export { readLatestAssistantTextFromSessionTranscript } from "./transcript.js";
        export { resolveSessionFilePath as resolveLegacySessionFilePath } from "./paths.js";
      `,
      "retired file-backed SDK session helper",
      [2, "exports", "resolveAndPersistSessionFile"],
      [3, "exports", "resolveSessionFilePath"],
      [4, "exports", "readLatestAssistantTextFromSessionTranscript"],
      [5, "exports", "resolveSessionFilePath"],
    );
    check(
      findSessionStoreRuntimeFileBackedCompatExportViolations,
      "export { getSessionEntry, listSessionEntries } from './accessor.js';",
      "retired file-backed SDK session helper",
    );
  });

  it("flags whole-store selection across imports, calls, references and bindings", () => {
    check(
      findSessionAccessorBoundaryViolations,
      `
        import { resolveSessionStoreEntryCore as resolve } from "../config/sessions.js";
        resolveSessionStoreEntryCore({ store, sessionKey });
        sessions.resolveSessionStoreEntryCore({ store, sessionKey });
        sessions["resolveSessionStoreEntryCore"]({ store, sessionKey });
        const { resolveSessionStoreEntryCore: read } = sessions;
      `,
      "legacy session store access",
      [2, "imports", "resolveSessionStoreEntryCore"],
      [3, "calls", "resolveSessionStoreEntryCore"],
      [4, "references", "resolveSessionStoreEntryCore"],
      [5, "references", "resolveSessionStoreEntryCore"],
      [6, "aliases", "resolveSessionStoreEntryCore"],
    );
  });

  it("flags legacy memory-host corpus classification calls in migrated entrypoints", () => {
    check(
      findMemoryHostSessionCorpusBoundaryViolations,
      `
        function listSessionTranscriptCorpusEntriesForAgentSync(agentId) {
          return loadSessionTranscriptClassificationForSessionsDir(resolveSessionTranscriptsDirForAgent(agentId));
        }
        export async function listSessionFilesForAgent(agentId) {
          return readSessionTranscriptClassificationStore("sessions.json");
        }
      `,
      "legacy memory-host session corpus helper",
      [3, "calls", "loadSessionTranscriptClassificationForSessionsDir"],
      [6, "calls", "readSessionTranscriptClassificationStore"],
    );
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

  it("allows only the runtime SDK forwarding import, not legacy calls", () => {
    const source = 'import { updateLastRoute } from "../../plugin-sdk/session-store-runtime.js";';
    const runtimePath = "/repo/src/plugins/runtime/runtime-channel.ts";
    const inspect = (content: string, fileName = runtimePath) =>
      findSessionAccessorWriteBoundaryViolations(
        content,
        fileName,
        collectSessionAccessorSyntaxFacts(parser.parseSourceFile(fileName, content)),
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

  it("restricts opaque writers only within sessions.create handlers", () => {
    check(
      findGatewaySessionCreateLifecycleViolations,
      `
      const handlers = {
        "sessions.create": () => sessions.updateSessionStoreEntry(params),
        "sessions.patch": () => sessions.updateSessionStoreEntry(params),
      };
    `,
      "legacy sessions.create lifecycle writer",
      [3, "calls", "updateSessionStoreEntry"],
    );
    check(
      findGatewaySessionCreateLifecycleViolations,
      'const handlers = { "sessions.create": () => createSessionEntryWithTranscript(params) };',
      "legacy sessions.create lifecycle writer",
    );
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

describe("session accessor scan", () => {
  it("enforces every retained family and ratchets only unmigrated source", async () => {
    const root = tempDirs.make("session-accessor-scan-");
    const fixtures = [
      [
        "src/commands/health.ts",
        "resolveSessionStoreEntryCore(store);",
        'calls legacy session store reader "resolveSessionStoreEntryCore"',
      ],
      [
        "src/agents/live-model-switch.ts",
        "updateLastRoute(params);",
        'calls legacy session store writer "updateLastRoute"',
      ],
      [
        "src/agents/command/attempt-execution.ts",
        "emitSessionTranscriptUpdate(params);",
        'calls legacy transcript writer "emitSessionTranscriptUpdate"',
      ],
      [
        "src/gateway/server-methods/sessions-create.ts",
        'const handlers = { "sessions.create": () => updateSessionStoreEntry(params) };',
        'calls legacy sessions.create lifecycle writer "updateSessionStoreEntry"',
      ],
      [
        "src/cron/session-reaper.ts",
        "cleanupArchivedSessionTranscripts(params);",
        'calls legacy session store lifecycle cleanup "cleanupArchivedSessionTranscripts"',
      ],
      [
        "packages/memory-host-sdk/src/host/session-files.ts",
        "function listSessionFilesForAgent() { return readSessionTranscriptClassificationStore(path); }",
        'calls legacy memory-host session corpus helper "readSessionTranscriptClassificationStore"',
      ],
      [
        "extensions/voice-call/src/response-generator.ts",
        "runEmbeddedAgent({ sessionFile });",
        'passes deprecated embedded-agent runtime identity field "sessionFile"; use sessionTarget',
      ],
      [
        "src/gateway/server-methods/sessions-read.ts",
        "loadSessionEntry(scope);",
        'calls materializing session entry accessor "loadSessionEntry"',
      ],
      [
        "src/plugin-sdk/session-store-runtime.ts",
        "export function resolveSessionFilePath() {}",
        'exports retired file-backed SDK session helper "resolveSessionFilePath"',
      ],
    ] as const;
    const write = async (file: string, text: string) => {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), text);
    };
    for (const [file, source] of fixtures) {
      await write(file, source);
    }
    await write("src/agents/future.ts", "updateLastRoute(params);");
    await write("src/agents/ignored.test.ts", "updateLastRoute(params);");
    const red = await collectSessionAccessorFindings(root);
    const expected: Array<{ path: string; line: number; reason: string }> = fixtures.map(
      ([file, , reason]) => ({ path: file.split("/").join(path.sep), line: 1, reason }),
    );
    expected.splice(2, 0, {
      path: path.join("src", "gateway", "server-methods", "sessions-create.ts"),
      line: 1,
      reason: 'calls legacy session store writer "updateSessionStoreEntry"',
    });
    expect(red.violations).toEqual(expected);
    expect(red.counts).toEqual({
      embeddedAgentSessionTarget: {},
      memoryHostSessionCorpus: {},
      sessionAccessorRead: {},
      sessionAccessorWrite: { "src/agents/future.ts": 1 },
      sessionLifecycleCleanup: {},
      transcriptWriter: {},
    });
    for (const [file] of fixtures) {
      await write(file, "export {};\n");
    }
    await write("src/agents/future.ts", "patchSessionEntry(params);");
    const green = await collectSessionAccessorFindings(root);
    expect(green.violations).toEqual([]);
    expect(Object.values(green.counts).every((files) => Object.keys(files).length === 0)).toBe(
      true,
    );
  });
});
