import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../../scripts/check-database-worker-ratchet.mts";
import { inventory } from "../../scripts/database-worker-inventory.mjs";
import * as databaseWorkerCompat from "../../scripts/lib/database-worker-compat.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([
  ["session-cold-storage-chunks.ts", "readSessionColdChunks", "executeSqliteQuerySync"],
  [
    "session-cold-storage-chunks.ts",
    "readVerifiedSessionColdChunks",
    "executeSqliteQueryTakeFirstSync",
  ],
  [
    "session-cold-storage-chunks.ts",
    "iterateSessionColdRecords",
    "executeSqliteQueryTakeFirstSync",
  ],
  [
    "session-cold-storage-prepare.ts",
    "prepareSessionColdArchiveInWorker",
    "withOpenClawAgentDatabaseReadOnly",
  ],
  [
    "session-cold-storage-prepare.ts",
    "prepareSessionColdBatchInWorker",
    "withOpenClawAgentDatabaseReadOnly",
  ],
])(
  "proves the cold-storage kernel %s:%s only through reviewed entries",
  (file, operation, primitive) => {
    const relative = `src/config/sessions/${file}`;
    const sources = new Map([
      [relative, `export function ${operation}() { return ${primitive}(query); }`],
      [
        "src/config/sessions/session-accessor.sqlite-archive.worker.ts",
        `export async function dispatchColdPreparation() {
          const { ${operation} } = await import('./${file.replace(/\.ts$/, ".js")}');
          return scope.run(options, () => ${operation}());
        }`,
      ],
    ]);
    const tiers = () => inventory(process.cwd(), "", false, sources).map(({ tier }) => tier);
    expect(tiers()).toEqual(["W"]);
    sources.set(
      "scripts/perf/session-cold-selection.ts",
      `(await import('../../src/config/sessions/${file.replace(/\.ts$/, ".js")}')).${operation}();`,
    );
    expect(tiers()).toEqual(["T3"]);
    sources.set(
      "src/plugin-sdk/runtime.ts",
      `import { ${operation} } from '../config/sessions/${file.replace(/\.ts$/, ".js")}';
     export function runtime() { return ${operation}(); }`,
    );
    expect(tiers()).toEqual(["T1"]);
  },
);

it("preserves worker ownership through the synchronous agent read scope", () => {
  const sources = new Map([
    [
      "src/state/openclaw-agent-db-readonly.ts",
      "export function withOpenClawAgentDatabaseReadOnly(operation) { return operation(database); }",
    ],
    [
      "src/config/sessions/session-cold-storage-prepare.ts",
      `import { withOpenClawAgentDatabaseReadOnly } from '../../state/openclaw-agent-db-readonly.js';
       export function prepareSessionColdBatchInWorker() {
         return withOpenClawAgentDatabaseReadOnly(() => executeSqliteQuerySync(query), options);
       }`,
    ],
    [
      "src/config/sessions/session-accessor.sqlite-archive.worker.ts",
      `import { prepareSessionColdBatchInWorker } from './session-cold-storage-prepare.js';
       prepareSessionColdBatchInWorker();`,
    ],
  ]);
  const tiers = () => inventory(process.cwd(), "", false, sources).map(({ tier }) => tier);
  expect(tiers()).toEqual(["W"]);
  sources.set(
    "src/plugin-sdk/runtime.ts",
    `import { prepareSessionColdBatchInWorker } from '../config/sessions/session-cold-storage-prepare.js';
     export function runtime() { return prepareSessionColdBatchInWorker(); }`,
  );
  expect(tiers()).toEqual(["T1"]);
});

it.each([
  ["session-claim-repair-copy.ts", "copySessionClaimForRepair"],
  ["session-accessor.sqlite-delivery-repair.ts", "copySessionDeliveriesForRepair"],
  ["session-accessor.sqlite-delivery-repair.ts", "readSessionDeliveryRepairInventory"],
])("keeps offline session repair classification operation-scoped: %s %s", (file, operation) => {
  const relative = `src/config/sessions/${file}`;
  const rows = inventory(
    process.cwd(),
    "",
    false,
    new Map([
      [
        relative,
        `function ${operation}() { executeSqliteQuerySync(query); }
         function unreviewedRuntime() { executeSqliteQuerySync(query); }`,
      ],
    ]),
  );
  expect(rows.map(({ tier, calls }) => [tier, calls.map((call) => call.operation)])).toEqual([
    ["T1", ["unreviewedRuntime"]],
    ["T2", [operation]],
  ]);
});

function sourceFixture(sources: Record<string, string>) {
  const root = tempDirs.make("openclaw-sqlite-ratchet-");
  const write = (file: string, source: string) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  };
  Object.entries(sources).forEach(([file, source]) => write(file, source));
  return { root, write };
}

function fixture(sources: Record<string, string>) {
  const { root, write } = sourceFixture(sources);
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: root,
      stdio: "pipe",
    });
  git("init");
  git("add", ".");
  git("commit", "-m", "base");
  vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  return { root, git, write, errors };
}

const expectError = (errors: ReturnType<typeof fixture>["errors"], text: string) =>
  expect(errors).toHaveBeenCalledWith(expect.stringContaining(text));

it("reuses identical source snapshots while keeping head analysis fresh and invalidating changed bases", () => {
  const source = "executeSqliteQuerySync(query);\n";
  const { root, git, write } = fixture({ "src/runtime.ts": source });
  const inspect = vi.spyOn(databaseWorkerCompat, "inspectDatabaseWorkerBoundaries");

  expect(main(root, ["--base", "HEAD"])).toBe(0);
  write("src/runtime.ts", source.repeat(2));
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(inspect).toHaveBeenCalledTimes(2);

  git("add", "src");
  git("commit", "-m", "changed base");
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  expect(inspect).toHaveBeenCalledTimes(3);

  // Simulate an edit after module load without changing the running test's source files.
  const analyzerFile = path.resolve("scripts/lib/database-worker-compat.mts");
  const readFile = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((filePath, options) => {
    const bytes = readFile(filePath, options);
    return filePath !== analyzerFile
      ? bytes
      : typeof bytes === "string"
        ? `${bytes}\n`
        : Buffer.concat([bytes, Buffer.from("\n")]);
  });
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  expect(inspect).toHaveBeenCalledTimes(7);
});

it.each(["contents", "added path", "renamed path"])(
  "analyzes both complete snapshots after a source change: %s",
  (change) => {
    const { root } = fixture({ "src/runtime.ts": "export const value = 1;\n" });
    vi.restoreAllMocks();
    const file = path.join(root, "src/runtime.ts");
    if (change === "contents") {
      fs.writeFileSync(file, "export const value = 2;\n");
    } else if (change === "added path") {
      fs.writeFileSync(path.join(root, "src/added.ts"), "export const value = 1;\n");
    } else {
      fs.renameSync(file, path.join(root, "src/renamed.ts"));
    }
    const inspect = vi.spyOn(databaseWorkerCompat, "inspectDatabaseWorkerBoundaries");
    expect(main(root, ["--base", "HEAD"])).toBe(0);
    expect(inspect).toHaveBeenCalledTimes(2);
  },
);

it("excludes the reviewed Vitest suite without exempting arbitrary suite-named runtime files", () => {
  const { root } = sourceFixture({
    "src/gateway/server.auth.default-token.suite.ts":
      'import { test } from "vitest"; test("profiles", () => executeSqliteQuerySync(query));',
    "src/gateway/runtime.suite.ts":
      "export function readRuntime() { return executeSqliteQuerySync(query); }",
  });
  expect(inventory(root).map(({ file, tier }) => ({ file, tier }))).toEqual([
    { file: "src/gateway/runtime.suite.ts", tier: "T1" },
  ]);
});

it("classifies only the synchronous Doctor enrollment branch as one-shot", () => {
  const relative = "src/agents/auth-profiles/authorization-enrollment-runtime.ts";
  const { root } = sourceFixture({
    [relative]: `export function enrollOwnedAuthProfileAuthorization(params) {
      if (params.context.maintenanceScope?.ownsSchemaMaintenance) {
        runOpenClawAgentWriteTransaction(callback);
        return () => runOpenClawAgentWriteTransaction(callback);
      } else {
        runOpenClawAgentWriteTransaction(callback);
      }
    }`,
  });
  const rows = inventory(root);
  expect(rows.map(({ tier, calls }) => [tier, calls.length])).toEqual([
    ["T1", 2],
    ["T3", 1],
  ]);
});

it("limits unadmitted mutation classification to its synchronous guarded branch", () => {
  const relative = "src/config/sessions/session-accessor.sqlite-transcript-state.ts";
  const { root, write } = fixture({
    [relative]:
      "function advanceTranscriptMutationAtInTransaction(database) { executeSqliteQuerySync(query); }",
  });
  const guarded = `
function advanceTranscriptMutationAtInTransaction(database) {
  if (!findOpenClawAgentDatabaseIdentity(database)) {
    executeSqliteQuerySync(query);
    return;
  }
  const context = executeSqliteQueryTakeFirstSync(query);
}
`;
  write(relative, guarded);
  expect(inventory(root).map(({ tier, calls }) => [tier, calls.length])).toEqual([
    ["T1", 1],
    ["T2", 1],
  ]);
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  write(
    relative,
    guarded.replace(
      "    return;\n  }",
      "    callback(() => executeSqliteQuerySync(query));\n  } else { executeSqliteQuerySync(query); }",
    ),
  );
  expect(inventory(root).map(({ tier, calls }) => [tier, calls.length])).toEqual([
    ["T1", 3],
    ["T2", 1],
  ]);
  expect(main(root, ["--base", "HEAD"])).toBe(1);
});

it("rejects total T1 growth with call sites and allows splits, shrinkage, and worker calls", () => {
  const source = "executeSqliteQuerySync(query);\n";
  const { root, git, write, errors } = fixture({ "src/runtime.ts": source.repeat(2) });
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  expect(main(root, ["--base", "HEAD", "--staged"])).toBe(0);
  write("src/runtime.ts", source.repeat(3));
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expectError(errors, "src/runtime.ts: 2 -> 3");
  expectError(errors, "src/runtime.ts:3:1 executeSqliteQuerySync");
  git("add", ".");
  write("src/runtime.ts", source);
  errors.mockClear();
  expect(main(root, ["--base", "HEAD", "--staged"])).toBe(1);
  expectError(errors, "src/runtime.ts: 2 -> 3");
  write("src/runtime.worker.ts", source.repeat(3));
  errors.mockClear();
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  write("src/runtime.ts", "export {};\n");
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  expect(errors).not.toHaveBeenCalled();
  write("src/runtime.ts", source);
  write("src/split.ts", source);
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  write("src/split.ts", source.repeat(2));
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expectError(errors, "src/split.ts:2:1 executeSqliteQuerySync");
});

it("keeps operation exceptions scoped across line shifts without masking runtime growth", () => {
  const relative = "src/gateway/worker-environments/placement-turn-claims.ts";
  const source = `
import { executeSqliteQuerySync as query } from "./queries.js";
function createPlacementTurnClaimOps() {
  return {
    releaseTurn() { transaction(() => query(sql)); },
    clearLocalTurnClaimsAfterRestart: () => query(sql),
    claimTurn() { query(sql); },
  };
}
function anotherFactory() {
  return { releaseTurn() { query(sql); } };
}
`;
  const eventRelative = "src/sessions/session-state-events.kernel.ts";
  const eventSource = `
import { executeSqliteQuerySync as query } from "./queries.js";
function recordSessionStateEventsInDatabase() {
  query(sql);
  const registeredWatcherKeys = notify
    ? query(sql).rows.map(() => query(sql))
    : [];
  const otherKeys = query(sql);
}
function anotherRecorder() {
  const registeredWatcherKeys = query(sql);
}
`;
  const { root, write, errors } = fixture({ [relative]: source, [eventRelative]: eventSource });
  const rows = inventory(root);
  expect(rows.map(({ tier, calls }) => [tier, calls.length])).toEqual([
    ["T1", 3],
    ["T1", 1],
    ["W", 1],
    ["W", 4],
  ]);
  write(relative, "\n\n" + source);
  write(eventRelative, "\n\n" + eventSource);
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  write("src/another-runtime.ts", "executeSqliteQuerySync(sql);\n");
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expectError(errors, "src/another-runtime.ts:1:1 executeSqliteQuerySync");
});

it("separates deprecated-only calls and rejects bundled callers even without T1 growth", () => {
  const { root, write, errors } = fixture({ "src/runtime.ts": "executeSqliteQuerySync(query);\n" });
  const relative = "extensions/matrix/auth-presence.ts";
  const wrappers = `
import * as queries from "../infra/kysely-sync.js";
/** @deprecated Use the worker backend. */
export function hasAnyMatrixAuth(database, query) {
  return queries.executeSqliteQueryTakeFirstSync(database, query);
}
`;
  write(relative, wrappers);
  expect(inventory(root).find((row) => row.file === relative)).toMatchObject({
    tier: "T1-compat",
    calls: [expect.any(Object)],
  });
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  write(
    "src/plugin-sdk/sqlite-runtime.ts",
    'export { hasAnyMatrixAuth as legacyQuery } from "../../extensions/matrix/auth-presence.js";\n',
  );
  write(
    "src/runtime.ts",
    'import { legacyQuery as query } from "./plugin-sdk/sqlite-runtime.js"; query(db, sql);\n',
  );
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expectError(errors, "src/runtime.ts");
});

it("validates credential writers in current and staged sources while comparing historical counts", () => {
  const unreviewed = "export function write() { scope.execute({ type: 'machineState.write' }); }";
  const { root, write, errors } = fixture({ "src/writer.ts": unreviewed });
  write("src/writer.ts", "export function read() {} ");
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  expect(main(root, ["--base", "HEAD", "--staged"])).toBe(1);
  const diagnostic = "machineState.write credential writes require the host publication adapter";
  expectError(errors, diagnostic);
  errors.mockClear();
  write("src/writer.ts", unreviewed);
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expectError(errors, diagnostic);
});
