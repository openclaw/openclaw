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

it("reuses identical source snapshots while keeping head analysis fresh and invalidating changed bases", () => {
  const root = tempDirs.make("openclaw-sqlite-cached-ratchet-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: root,
      stdio: "pipe",
    });
  fs.mkdirSync(path.join(root, "src"));
  const file = path.join(root, "src/runtime.ts");
  const source = "executeSqliteQuerySync(query);\n";
  fs.writeFileSync(file, source);
  git("init");
  git("add", "src");
  git("commit", "-m", "base");
  const inspect = vi.spyOn(databaseWorkerCompat, "inspectDatabaseWorkerBoundaries");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  expect(main(root, ["--base", "HEAD"])).toBe(0);
  fs.writeFileSync(file, source.repeat(2));
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

it.each(["contents", "added path", "renamed path", "deleted path"])(
  "analyzes both complete snapshots after a source change: %s",
  (change) => {
    const root = tempDirs.make("openclaw-sqlite-snapshot-ratchet-");
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
        cwd: root,
        stdio: "pipe",
      });
    fs.mkdirSync(path.join(root, "src"));
    const file = path.join(root, "src/runtime.ts");
    fs.writeFileSync(file, "export const value = 1;\n");
    git("init");
    git("add", "src");
    git("commit", "-m", "base");
    if (change === "contents") {
      fs.writeFileSync(file, "export const value = 2;\n");
    } else if (change === "added path") {
      fs.writeFileSync(path.join(root, "src/added.ts"), "export const value = 1;\n");
    } else if (change === "renamed path") {
      fs.renameSync(file, path.join(root, "src/renamed.ts"));
    } else {
      fs.rmSync(file);
    }
    const inspect = vi.spyOn(databaseWorkerCompat, "inspectDatabaseWorkerBoundaries");
    expect(main(root, ["--base", "HEAD"])).toBe(0);
    expect(inspect).toHaveBeenCalledTimes(2);
  },
);

it("excludes the reviewed Vitest suite without exempting arbitrary suite-named runtime files", () => {
  const root = tempDirs.make("openclaw-sqlite-suite-ratchet-");
  const directory = path.join(root, "src/gateway");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "server.auth.default-token.suite.ts"),
    'import { test } from "vitest"; test("profiles", () => executeSqliteQuerySync(query));',
  );
  fs.writeFileSync(
    path.join(directory, "runtime.suite.ts"),
    "export function readRuntime() { return executeSqliteQuerySync(query); }",
  );
  expect(inventory(root).map(({ file, tier }) => ({ file, tier }))).toEqual([
    { file: "src/gateway/runtime.suite.ts", tier: "T1" },
  ]);
});

it("does not exempt a kernel through an unregistered worker-named runtime wrapper", () => {
  const root = tempDirs.make("openclaw-sqlite-entry-ratchet-");
  const relative = "src/state/openclaw-state-db-maintenance.ts";
  const sources = {
    [relative]: `export function writeUnreviewedStateMetadata() {
      return executeSqliteQuerySync(query);
    }`,
    "src/unregistered.worker.ts": `
      import { writeUnreviewedStateMetadata } from './state/openclaw-state-db-maintenance.js';
      export function writeSchema() { return writeUnreviewedStateMetadata(); }
    `,
    "src/gateway/consumer.ts": `
      import { writeSchema } from '../unregistered.worker.js';
      export function handle() { return writeSchema(); }
    `,
  };
  for (const [file, source] of Object.entries(sources)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  }
  expect(inventory(root).find((row) => row.file === relative)).toMatchObject({
    tier: "T1",
    calls: [expect.objectContaining({ operation: "writeUnreviewedStateMetadata" })],
  });
});

it("classifies only the synchronous Doctor enrollment branch as one-shot", () => {
  const root = tempDirs.make("openclaw-sqlite-doctor-enrollment-");
  const relative = "src/agents/auth-profiles/authorization-enrollment-runtime.ts";
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `export function enrollOwnedAuthProfileAuthorization(params) {
      if (params.context.maintenanceScope?.ownsSchemaMaintenance) {
        runOpenClawAgentWriteTransaction(callback);
        return () => runOpenClawAgentWriteTransaction(callback);
      } else {
        runOpenClawAgentWriteTransaction(callback);
      }
    }`,
  );
  const rows = inventory(root);
  expect(rows.map(({ tier, calls }) => [tier, calls.length])).toEqual([
    ["T1", 2],
    ["T3", 1],
  ]);
  expect(rows.find(({ tier }) => tier === "T3")?.calls[0]).toMatchObject({
    operation: "enrollOwnedAuthProfileAuthorization",
    guards: ["params.context.maintenanceScope?.ownsSchemaMaintenance"],
  });
});

it("limits unadmitted mutation classification to its synchronous guarded branch", () => {
  const root = tempDirs.make("openclaw-sqlite-guard-ratchet-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: root,
      stdio: "pipe",
    });
  const relative = "src/config/sessions/session-accessor.sqlite-transcript-state.ts";
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    "function advanceTranscriptMutationAtInTransaction(database) { executeSqliteQuerySync(query); }",
  );
  git("init");
  git("add", ".");
  git("commit", "-m", "unconditional runtime update");
  const guarded = `
function advanceTranscriptMutationAtInTransaction(database) {
  if (!findOpenClawAgentDatabaseIdentity(database)) {
    executeSqliteQuerySync(query);
    return;
  }
  const context = executeSqliteQueryTakeFirstSync(query);
}
`;
  fs.writeFileSync(file, guarded);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(inventory(root).map(({ tier, calls }) => [tier, calls.length])).toEqual([
    ["T1", 1],
    ["T2", 1],
  ]);
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  fs.writeFileSync(
    file,
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
  const root = tempDirs.make("openclaw-sqlite-ratchet-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: root,
      stdio: "pipe",
    });
  fs.mkdirSync(path.join(root, "src"));
  const file = path.join(root, "src/runtime.ts");
  const source = "executeSqliteQuerySync(query);\n";
  fs.writeFileSync(file, source.repeat(2));
  git("init");
  git("add", ".");
  git("commit", "-m", "base");
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  expect(main(root, ["--base", "HEAD", "--staged"])).toBe(0);
  fs.writeFileSync(file, source.repeat(3));
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining("src/runtime.ts: 2 -> 3"));
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("src/runtime.ts:3:1 executeSqliteQuerySync"),
  );
  git("add", ".");
  fs.writeFileSync(file, source);
  errors.mockClear();
  expect(main(root, ["--base", "HEAD", "--staged"])).toBe(1);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining("src/runtime.ts: 2 -> 3"));
  fs.writeFileSync(path.join(root, "src/runtime.worker.ts"), source.repeat(3));
  errors.mockClear();
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  fs.writeFileSync(file, "export {};\n");
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  expect(errors).not.toHaveBeenCalled();
  fs.writeFileSync(file, source);
  fs.writeFileSync(path.join(root, "src/split.ts"), source);
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  fs.writeFileSync(path.join(root, "src/split.ts"), source.repeat(2));
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("src/split.ts:2:1 executeSqliteQuerySync"),
  );
});

it("keeps operation exceptions scoped across line shifts without masking runtime growth", () => {
  const root = tempDirs.make("openclaw-sqlite-mixed-ratchet-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: root,
      stdio: "pipe",
    });
  const relative = "src/gateway/worker-environments/placement-turn-claims.ts";
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
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
  fs.writeFileSync(file, source);
  const eventRelative = "src/sessions/session-state-events.kernel.ts";
  const eventFile = path.join(root, eventRelative);
  fs.mkdirSync(path.dirname(eventFile), { recursive: true });
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
  fs.writeFileSync(eventFile, eventSource);
  git("init");
  git("add", ".");
  git("commit", "-m", "base");
  const rows = inventory(root);
  expect(rows.map(({ tier, calls }) => [tier, calls.length])).toEqual([
    ["T1", 3],
    ["T1", 1],
    ["W", 1],
    ["W", 4],
  ]);
  expect(rows.find(({ tier }) => tier === "W")?.calls[0]).toMatchObject({
    operation: "createPlacementTurnClaimOps.releaseTurn",
  });
  expect(rows.find((row) => row.file === eventRelative && row.tier === "W")?.calls).toEqual(
    Array(4).fill(expect.objectContaining({ operation: "recordSessionStateEventsInDatabase" })),
  );
  expect(
    rows.find((row) => row.file === eventRelative && row.tier === "T1")?.calls[0],
  ).toMatchObject({ operation: "anotherRecorder", binding: "registeredWatcherKeys" });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  fs.writeFileSync(file, "\n\n" + source);
  fs.writeFileSync(eventFile, "\n\n" + eventSource);
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  fs.writeFileSync(path.join(root, "src/another-runtime.ts"), "executeSqliteQuerySync(sql);\n");
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining("src/another-runtime.ts:1:1 executeSqliteQuerySync"),
  );
});

it("separates deprecated-only calls and rejects bundled callers even without T1 growth", () => {
  const root = tempDirs.make("openclaw-sqlite-compat-ratchet-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: root,
      stdio: "pipe",
    });
  const relative = "extensions/matrix/auth-presence.ts";
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(path.join(root, "src/plugin-sdk"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/runtime.ts"), "executeSqliteQuerySync(query);\n");
  git("init");
  git("add", ".");
  git("commit", "-m", "original call");
  const wrappers = `
import * as queries from "../infra/kysely-sync.js";
/** @deprecated Use the worker backend. */
export function hasAnyMatrixAuth(database, query) {
  return queries.executeSqliteQueryTakeFirstSync(database, query);
}
`;
  fs.writeFileSync(file, wrappers);
  vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(inventory(root).find((row) => row.file === relative)).toMatchObject({
    tier: "T1-compat",
    calls: [expect.any(Object)],
  });
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  fs.writeFileSync(
    path.join(root, "src/plugin-sdk/sqlite-runtime.ts"),
    'export { hasAnyMatrixAuth as legacyQuery } from "../../extensions/matrix/auth-presence.js";\n',
  );
  fs.writeFileSync(
    path.join(root, "src/runtime.ts"),
    'import { legacyQuery as query } from "./plugin-sdk/sqlite-runtime.js"; query(db, sql);\n',
  );
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining("src/runtime.ts"));
});

it("validates credential writers in current and staged sources while comparing historical counts", () => {
  const root = tempDirs.make("openclaw-sqlite-writer-ratchet-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: root,
      stdio: "pipe",
    });
  fs.mkdirSync(path.join(root, "src"));
  const file = path.join(root, "src/writer.ts");
  const unreviewed = "export function write() { scope.execute({ type: 'machineState.write' }); }";
  fs.writeFileSync(file, unreviewed);
  git("init");
  git("add", ".");
  git("commit", "-m", "historical writer");
  vi.spyOn(console, "log").mockImplementation(() => {});
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  fs.writeFileSync(file, "export function read() {} ");
  expect(main(root, ["--base", "HEAD"])).toBe(0);
  expect(main(root, ["--base", "HEAD", "--staged"])).toBe(1);
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining(
      "machineState.write credential writes require the host publication adapter",
    ),
  );
  errors.mockClear();
  fs.writeFileSync(file, unreviewed);
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(errors).toHaveBeenCalledWith(
    expect.stringContaining(
      "machineState.write credential writes require the host publication adapter",
    ),
  );
});
