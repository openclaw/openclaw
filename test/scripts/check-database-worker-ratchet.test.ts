import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../../scripts/check-database-worker-ratchet.mts";
import { inventory } from "../../scripts/database-worker-inventory.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

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
function recordSessionStateEventInDatabase() {
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
    Array(4).fill(expect.objectContaining({ operation: "recordSessionStateEventInDatabase" })),
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
  const relative = "src/plugin-sdk/sqlite-runtime-legacy.ts";
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(root, "src/runtime.ts"), "executeSqliteQuerySync(query);\n");
  git("init");
  git("add", ".");
  git("commit", "-m", "original call");
  const wrappers = `
import * as queries from "../infra/kysely-sync.js";
/** @deprecated Use the worker backend. */
function executeSqliteQueryTakeFirstSyncLegacy(database, query) {
  return queries.executeSqliteQueryTakeFirstSync(database, query);
}
export {
  executeSqliteQueryTakeFirstSyncLegacy as executeSqliteQueryTakeFirstSync,
};
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
    'export { executeSqliteQueryTakeFirstSync as legacyQuery } from "./sqlite-runtime-legacy.js";\n',
  );
  fs.writeFileSync(
    path.join(root, "src/runtime.ts"),
    'import { legacyQuery as query } from "./plugin-sdk/sqlite-runtime.js"; query(db, sql);\n',
  );
  expect(main(root, ["--base", "HEAD"])).toBe(1);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining("src/runtime.ts"));
});
