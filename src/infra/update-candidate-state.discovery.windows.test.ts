import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import * as sqliteInspection from "./sqlite-readonly-location.js";
import { readUpdateStateSchemaVersionsInProcess } from "./update-candidate-state.js";

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, default: actual.win32 };
});

afterEach(() => vi.restoreAllMocks());

it("keeps namespaced update versions stable when supplemental discovery returns plain aliases", async () => {
  mockProcessPlatform("win32");
  const plainRoot = String.raw`C:\Users\me\.openclaw`;
  const stateDir = path.toNamespacedPath(plainRoot);
  const relative = String.raw`agents\main\agent\openclaw-agent.sqlite`;
  const agent = path.join(stateDir, relative);
  const plainAgent = path.join(plainRoot, relative);
  const retainedPlugin = path.join(plainRoot, "matrix", "accounts", "retained", "state.sqlite");

  // Only filesystem/header I/O is synthetic; the updater owns inventory merging
  // and publishes the exact paths consumed by released rollback baselines.
  vi.spyOn(fs, "readdir").mockResolvedValue([]);
  vi.spyOn(fs, "access").mockImplementation(async (file) => {
    if ([agent, plainAgent, retainedPlugin].includes(String(file))) {
      return;
    }
    throw Object.assign(new Error("missing fixture database"), { code: "ENOENT" });
  });
  vi.spyOn(sqliteInspection, "inspectSqliteSchemaHeaderInProcess").mockImplementation(
    async (file) => ({ userVersion: file === retainedPlugin ? 4 : 3 }),
  );

  const versions = await readUpdateStateSchemaVersionsInProcess({
    stateDir,
    config: {},
    // Backup discovery resolves real paths, removing the extended-length prefix.
    additionalPaths: [plainAgent, retainedPlugin],
  });
  expect(versions.filter(({ userVersion }) => userVersion === 3)).toEqual([
    { path: agent, userVersion: 3 },
  ]);
  expect(versions).toContainEqual({ path: retainedPlugin, userVersion: 4 });
});
