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
] as const)("shares the pass budget (state=$state, agent=$agent)", async (engines) => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const stateDir = dirs.make("gateway-page-cache-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const statePath = resolveOpenClawStateSqlitePath();
  const agentPaths = ["first.sqlite", "second.sqlite"].map((name) => path.join(stateDir, name));
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, "");
  const databases = agentPaths.map((agentPath, index) => {
    writeFileSync(agentPath, "");
    const identity = readDatabasePathIdentitySync(agentPath);
    return {
      database: { path: agentPath, agentId: `agent-${index}` },
      assertCurrent: () =>
        assertExistingDatabaseIdentity(agentPath, identity.key, identity.birthtime),
    };
  });
  const stateAdmission = vi.spyOn(stateContext, "captureOpenClawStateReadContext");
  const read = vi.mocked(runSqliteReadOnlyOperation);
  read.mockReset();
  read.mockImplementation(async (_pathname, command) => {
    if (command.type !== "pageCache.begin" || !command.input || !("maxBytes" in command.input)) {
      throw new Error("Expected a complete page-cache pass");
    }
    return { ...complete, readBytes: command.input.maxBytes };
  });
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
          databases,
          signal: new AbortController().signal,
          log,
        }),
    );
    const paths = { state: [statePath], agent: agentPaths };
    expect(read.mock.calls.map(([pathname]) => pathname)).toEqual(
      engines.warmed.flatMap((family) => paths[family]),
    );
    const budgets = read.mock.calls.map(([, command]) => {
      if (command.type !== "pageCache.begin" || !command.input || !("maxBytes" in command.input)) {
        throw new Error("Expected a page-cache budget");
      }
      return command.input.maxBytes;
    });
    if (budgets.length > 0) {
      expect(Math.min(...budgets)).toBeGreaterThan(0);
      expect(Math.max(...budgets) - Math.min(...budgets)).toBeLessThanOrEqual(1);
      expect(budgets.reduce((total, bytes) => total + bytes, 0)).toBe(2 * 1024 * 1024 * 1024);
    }
    expect(stateAdmission).toHaveBeenCalledTimes(engines.state === "sqlite" ? 1 : 0);
    expect(log.warn).not.toHaveBeenCalled();
  } finally {
    await closeOpenClawStateDatabaseByPathAsync(statePath);
  }
});
