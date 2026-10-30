import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import type { PageCacheProgress } from "../infra/sqlite-page-cache.worker.js";
import { runSqliteReadOnlyOperation } from "../infra/sqlite-readonly-worker.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as stateContext from "../state/openclaw-state-worker-context.js";
import { warmGatewayDatabasePageCache } from "./server-database-page-cache.js";

// mock-isolation: Test family routing without launching the native page-cache reader.
vi.mock("../infra/sqlite-readonly-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-readonly-worker.js")>()),
  runSqliteReadOnlyOperation: vi.fn(),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const complete: PageCacheProgress = {
  residency: undefined,
  readBytes: 0,
  diskBytes: 0,
  elapsedMs: 0,
  complete: true,
  limited: false,
  payloadBytes: 0,
  payloadMessages: 0,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  { state: "postgres", agent: "postgres", warmed: [] },
  { state: "postgres", agent: "sqlite", warmed: ["agent"] },
  { state: "sqlite", agent: "postgres", warmed: ["state"] },
  { state: "sqlite", agent: "sqlite", warmed: ["state", "agent"] },
] as const)("warms only SQLite families (state=$state, agent=$agent)", async (engines) => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const stateDir = dirs.make("gateway-page-cache-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const statePath = resolveOpenClawStateSqlitePath();
  const agentPath = path.join(stateDir, "agent.sqlite");
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, "");
  writeFileSync(agentPath, "");
  const identity = readDatabasePathIdentitySync(agentPath);
  const stateAdmission = vi.spyOn(stateContext, "captureOpenClawStateReadContext");
  const read = vi.mocked(runSqliteReadOnlyOperation);
  read.mockReset();
  read.mockResolvedValue(complete);
  const log = { info: vi.fn(), warn: vi.fn() };
  try {
    await withDatabaseEngineSelection(
      {
        effectiveEngines: resolveDatabaseFamilyEngines({
          database: {
            families: {
              state: { engine: engines.state },
              agent: { engine: engines.agent },
            },
          },
        }),
        postgres: {
          connection: "postgresql://localhost/page_cache_test",
          schemaPrefix: "page_cache_test",
        },
      },
      () =>
        warmGatewayDatabasePageCache({
          databases: [
            {
              database: { path: agentPath, agentId: "main" },
              assertCurrent: () =>
                assertExistingDatabaseIdentity(agentPath, identity.key, identity.birthtime),
            },
          ],
          signal: new AbortController().signal,
          log,
        }),
    );
    const paths = { state: statePath, agent: agentPath };
    expect(read.mock.calls.map(([pathname]) => pathname)).toEqual(
      engines.warmed.map((family) => paths[family]),
    );
    expect(stateAdmission).toHaveBeenCalledTimes(engines.state === "sqlite" ? 1 : 0);
    expect(log.warn).not.toHaveBeenCalled();
  } finally {
    await closeOpenClawStateDatabaseByPathAsync(statePath);
  }
});
