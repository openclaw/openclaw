import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCommandBuffered } from "../process/exec.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { readUpdateStateSchemaVersions } from "./update-candidate-state.js";

vi.mock("../process/exec.js", () => ({ runCommandBuffered: vi.fn() }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => vi.mocked(runCommandBuffered).mockReset());

function result(value: unknown, error?: string): Awaited<ReturnType<typeof runCommandBuffered>> {
  return {
    stdout: Buffer.from(error ? "" : JSON.stringify(value)),
    stderr: Buffer.from(error ?? ""),
    code: error ? 1 : 0,
    signal: null,
    killed: false,
    termination: "exit",
  };
}

it.each([false, true])("budgets the discovered registry inventory (legacy=%s)", async (legacy) => {
  const stateDir = tempDirs.make("openclaw-inspection-budget-");
  const shared = path.join(stateDir, "state", "openclaw.sqlite");
  const external = path.join(tempDirs.make("openclaw-registry-only-"), "agent.sqlite");
  fs.mkdirSync(path.dirname(shared));
  const database = openNodeSqliteDatabase(shared);
  database.exec("PRAGMA user_version = 3; CREATE TABLE agent_databases (path TEXT);");
  database.prepare("INSERT INTO agent_databases VALUES (?)").run(external);
  database.close();
  fs.writeFileSync(external, "");
  fs.truncateSync(external, 3_489_660_928);
  fs.writeFileSync(`${external}-wal`, "");
  fs.truncateSync(`${external}-wal`, 64 * 1024 * 1024);
  const sharedVersion = { path: shared, userVersion: 3, contentVersion: 3 };
  const discovery = {
    files: [
      [shared, { spellings: [shared] }],
      [external, { spellings: [external] }],
    ],
    sharedVersion,
  };
  if (legacy) {
    vi.mocked(runCommandBuffered).mockResolvedValueOnce(
      result(null, "Unknown update state inspection mode"),
    );
    vi.mocked(runCommandBuffered).mockImplementationOnce(async (_argv, options) => {
      const location = path.join(String(options?.env?.XDG_CACHE_HOME), "database.sqlite");
      fs.copyFileSync(shared, location);
      return result({ ok: true, location });
    });
  } else {
    vi.mocked(runCommandBuffered).mockResolvedValueOnce(result(discovery));
  }
  vi.mocked(runCommandBuffered).mockResolvedValueOnce(
    result([sharedVersion, { path: external, userVersion: 7 }]),
  );

  await expect(readUpdateStateSchemaVersions({ stateDir, config: {} })).resolves.toContainEqual({
    path: external,
    userVersion: 7,
  });
  const calls = vi.mocked(runCommandBuffered).mock.calls;
  expect(calls).toHaveLength(legacy ? 3 : 2);
  expect(calls[0]?.[1]?.timeoutMs).toBe(31_000);
  // 134 seconds for the database plus 2 for its WAL; legacy also recopies shared.
  expect(calls.at(-1)?.[1]?.timeoutMs).toBe(legacy ? 167_000 : 136_000);
  for (const [, options] of calls) {
    expect(options).toMatchObject({ killGraceMs: 500 });
    expect(fs.existsSync(String(options?.env?.XDG_CACHE_HOME))).toBe(false);
  }
});

it("rejects a versions array as a discovery response", async () => {
  vi.mocked(runCommandBuffered).mockResolvedValueOnce(result([]));
  await expect(
    readUpdateStateSchemaVersions({
      stateDir: tempDirs.make("openclaw-invalid-discovery-"),
      config: {},
    }),
  ).rejects.toThrow();
  expect(runCommandBuffered).toHaveBeenCalledTimes(1);
});
