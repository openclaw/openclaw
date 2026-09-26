import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { aroundEach, vi } from "vitest";
import { resolveServiceManagerEnv } from "../../src/daemon/service-process-env.js";
import { withStateDatabaseCoordinatorRuntimeDirectory } from "../../src/infra/state-database-coordinator.js";
import * as temporaryRoot from "../../src/infra/tmp-openclaw-dir.js";
import * as managedHandoff from "../../src/infra/update-managed-service-handoff-lease.js";

// The handoff store and the lifecycle coordinator are distinct SQLite stores.
// Keep the entire test lifetime (including hooks) in its owned coordinator scope.
aroundEach(async (runTest) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "update-coordinator-")));
  try {
    await withStateDatabaseCoordinatorRuntimeDirectory(directory, runTest);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

export function installPrivateUpdateHandoffStore(directory: string) {
  const privateDirectory = fs.realpathSync(directory);
  const databasePath = path.join(privateDirectory, "managed-update-handoffs.sqlite");
  const assertDatabasePath = (actual: string) => {
    assert.equal(path.isAbsolute(actual), true);
    assert.equal(path.resolve(actual), databasePath);
    assert.equal(fs.realpathSync(path.dirname(actual)), privateDirectory);
    assert.notEqual(actual, "/tmp/openclaw/managed-update-handoffs.sqlite");
    assert.notEqual(actual, "/private/tmp/openclaw/managed-update-handoffs.sqlite");
    if (fs.existsSync(actual)) {
      assert.equal(fs.realpathSync(actual), databasePath);
    }
  };
  assertDatabasePath(databasePath);
  vi.spyOn(temporaryRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(privateDirectory);
  vi.spyOn(managedHandoff, "resolveManagedUpdateLeaseDatabasePath").mockReturnValue(databasePath);
  const createStore = managedHandoff.createManagedHandoffLeaseStore;
  vi.spyOn(managedHandoff, "createManagedHandoffLeaseStore").mockImplementation(
    (options, logger) => {
      const selected = options ?? { databasePath, serviceManagerEnv: resolveServiceManagerEnv() };
      assertDatabasePath(selected.databasePath);
      return createStore(selected, logger);
    },
  );
  return { databasePath, assertDatabasePath };
}

export function writePrivateUpdateHandoffChildGuard(databasePath: string, directory: string) {
  const guard = path.join(directory, "private-handoff-guard.cjs");
  fs.writeFileSync(
    guard,
    `const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { syncBuiltinESMExports } = require("node:module");
const sqlite = require("node:sqlite");
const expected = ${JSON.stringify(databasePath)};
const root = ${JSON.stringify(fs.realpathSync(path.dirname(directory)))};
const relativePath = (from, to) => path.relative(path.toNamespacedPath(from), path.toNamespacedPath(to));
const original = sqlite.DatabaseSync;
sqlite.DatabaseSync = new Proxy(original, {
  construct(target, args, newTarget) {
    const input = String(args[0]);
    let location = input;
    if (input.startsWith("file:")) {
      const queryAt = input.indexOf("?");
      const pathname = queryAt < 0 ? input : input.slice(0, queryAt);
      const query = queryAt < 0 ? "" : input.slice(queryAt);
      assert(["", "?mode=rw", "?mode=ro&immutable=1"].includes(query), "Unexpected SQLite URI options");
      location = process.platform === "win32" ? decodeURIComponent(pathname.slice(5)) : fileURLToPath(pathname);
      const canonical = process.platform === "win32"
        ? "file:" + encodeURIComponent(path.toNamespacedPath(path.resolve(location)))
        : pathToFileURL(path.resolve(location)).href;
      assert.equal(pathname, canonical, "Non-canonical SQLite URI refused");
    }
    if (location !== ":memory:") {
      assert(!location.replaceAll(path.sep, "/").split("/").includes(".."), "SQLite parent traversal refused");
      const absolute = path.resolve(location);
      let ancestor = absolute;
      let entry = fs.lstatSync(ancestor, { throwIfNoEntry: false });
      while (!entry) {
        ancestor = path.dirname(ancestor);
        entry = fs.lstatSync(ancestor, { throwIfNoEntry: false });
      }
      assert(!entry.isSymbolicLink() || fs.existsSync(ancestor), "Dangling SQLite alias refused");
      const physical = fs.realpathSync(ancestor);
      const relative = relativePath(root, absolute);
      const physicalRelative = relativePath(root, physical);
      const within = (value) => !path.isAbsolute(value) && value !== ".." && !value.startsWith(".." + path.sep);
      assert(relative !== "" && within(relative), "SQLite must stay in its owned fixture");
      assert(within(physicalRelative), "SQLite alias escaped its owned fixture");
    }
    if (path.basename(location) === "managed-update-handoffs.sqlite") {
      assert.equal(relativePath(expected, path.resolve(location)), "");
      assert.equal(relativePath(path.dirname(expected), fs.realpathSync(path.dirname(location))), "");
      if (fs.existsSync(location)) assert.equal(relativePath(expected, fs.realpathSync(location)), "");
    }
    return Reflect.construct(target, args, newTarget);
  },
});
syncBuiltinESMExports();\n`,
    { mode: 0o600 },
  );
  return (env: NodeJS.ProcessEnv) => ({
    ...env,
    OPENCLAW_TEST_PRIVATE_HANDOFF_PATH: databasePath,
    NODE_OPTIONS: [env.NODE_OPTIONS, `--require=${JSON.stringify(guard)}`]
      .filter(Boolean)
      .join(" "),
  });
}
