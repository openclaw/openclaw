import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { acquireTestPortBlock, type TestPortClaim } from "../../test-utils/port-claims.js";
import { writeFixtureJsonSync } from "../cli-fixtures.test-support.js";
import { updateStatusCommand } from "./status.js";

const copies = vi.hoisted(() => ({ count: 0, afterCopy: () => {} }));
vi.mock("../../infra/sqlite-snapshot-source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/sqlite-snapshot-source.js")>();
  const settled = <T>(value: T) => {
    copies.count += 1;
    copies.afterCopy();
    return value;
  };
  return {
    ...actual,
    prepareSqliteReadOnlyLocationSync: (
      ...args: Parameters<typeof actual.prepareSqliteReadOnlyLocationSync>
    ) => settled(actual.prepareSqliteReadOnlyLocationSync(...args)),
    prepareSqliteReadOnlyLocation: async (
      ...args: Parameters<typeof actual.prepareSqliteReadOnlyLocation>
    ) => settled(await actual.prepareSqliteReadOnlyLocation(...args)),
    prepareSqliteReadOnlyLocationAwaited: async (
      ...args: Parameters<typeof actual.prepareSqliteReadOnlyLocationAwaited>
    ) => settled(await actual.prepareSqliteReadOnlyLocationAwaited(...args)),
    startSqliteReadOnlyLocationAsync: (
      ...args: Parameters<typeof actual.startSqliteReadOnlyLocationAsync>
    ) => {
      const preparation = actual.startSqliteReadOnlyLocationAsync(...args);
      void preparation.result.then(settled, () => {});
      return preparation;
    },
  };
});
const runtime = vi.hoisted(() => ({
  log: vi.fn(),
  error: vi.fn(),
  writeJson: vi.fn(),
  exit: vi.fn(),
}));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: runtime,
}));
vi.mock("../../infra/update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-check.js")>()),
  checkUpdateStatus: async () => ({
    root: "/fixture/openclaw",
    installKind: "package",
    packageManager: "npm",
    registry: { latestVersion: "2026.9.8" },
  }),
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveUpdateRoot: async () => "/fixture/openclaw",
}));
vi.mock("../../commands/node-runtime-diagnostics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/node-runtime-diagnostics.js")>()),
  collectNodeRuntimeFindings: async () => [],
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: () => ({ readCommand: async () => null }),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let gatewayPort: TestPortClaim;
beforeAll(async () => {
  gatewayPort = await acquireTestPortBlock({ offsets: [0] });
});
afterAll(async () => {
  await gatewayPort?.release();
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

it("copies the state database once while a live writer commits between status sections", async () => {
  const stateDir = tempDirs.make("openclaw-update-status-snapshot-");
  const configPath = path.join(stateDir, "openclaw.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("XDG_CACHE_HOME", path.join(stateDir, "cache"));
  writeFixtureJsonSync(configPath, {
    gateway: { mode: "local", auth: { mode: "none" }, port: gatewayPort.port },
    plugins: { enabled: false },
  });
  const databasePath = openOpenClawStateDatabase().path;
  await closeOpenClawStateDatabaseAsync();
  // Stands in for the running Gateway: every completed copy is followed by a commit.
  const writer = new DatabaseSync(databasePath);
  const commit = writer.prepare(
    "INSERT OR REPLACE INTO plugin_state_entries(plugin_id,namespace,entry_key,value_json,created_at,expires_at) VALUES('status-test','writer','tick',?,?,NULL)",
  );
  copies.count = 0;
  copies.afterCopy = () => commit.run(JSON.stringify(copies.count), Date.now());
  try {
    await updateStatusCommand({ json: true });
  } finally {
    copies.afterCopy = () => {};
    writer.close();
  }

  const report = runtime.writeJson.mock.lastCall?.[0] as Record<string, unknown> | undefined;
  expect(report).toBeDefined();
  expect(report?.runStatusError).toBeUndefined();
  expect(copies.count).toBe(1);
});
