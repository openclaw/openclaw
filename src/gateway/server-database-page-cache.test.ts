import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

beforeEach(() => {
  vi.spyOn(os, "freemem").mockReturnValue(1024 ** 3);
  vi.spyOn(os, "totalmem").mockReturnValue(1024 ** 3);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  { state: "postgres", agent: "postgres", warmed: [] },
  { state: "postgres", agent: "sqlite", warmed: ["agent"] },
  { state: "sqlite", agent: "postgres", warmed: ["state"] },
  { state: "sqlite", agent: "sqlite", warmed: ["state", "agent"] },
  { state: "sqlite", agent: "sqlite", warmed: [], pressure: "before" },
  { state: "sqlite", agent: "sqlite", warmed: ["state"], pressure: "during" },
  ...(process.versions.bun
    ? []
    : ([
        { state: "sqlite", agent: "sqlite", warmed: [], pressure: "before", host: true },
        { state: "sqlite", agent: "sqlite", warmed: ["state"], pressure: "during", host: true },
      ] as const)),
] as const)(
  "warms eligible databases ($state/$agent, pressure=$pressure, host=$host)",
  async (engines) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    let pressure = "pressure" in engines ? engines.pressure : undefined;
    const hostPressure = "host" in engines;
    vi.spyOn(process, "constrainedMemory").mockReturnValue(hostPressure ? 0 : 1024 * 1024 * 1024);
    if (hostPressure && pressure === "before") {
      vi.mocked(os.freemem).mockReturnValue(128 * 1024 ** 2);
    }
    const availableMemory = vi
      .spyOn(process, "availableMemory")
      .mockReturnValue(pressure === "before" ? 128 * 1024 * 1024 : 1024 * 1024 * 1024);
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
      if (command.type === "pageCache.step") {
        return complete;
      }
      if (command.type !== "pageCache.begin" || !command.input || !("maxBytes" in command.input)) {
        throw new Error("Expected a complete page-cache pass");
      }
      if (pressure === "during") {
        availableMemory.mockReturnValue(128 * 1024 * 1024);
        if (hostPressure) {
          vi.mocked(os.freemem).mockReturnValue(128 * 1024 ** 2);
        }
      }
      return {
        ...complete,
        complete: pressure !== "during",
        readBytes: pressure === "during" ? 0 : command.input.maxBytes,
      };
    });
    const log = { info: vi.fn(), warn: vi.fn() };
    const warm = () =>
      withDatabaseEngineSelection(
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
    try {
      await warm();
      const paths = { state: [statePath], agent: agentPaths };
      expect(read.mock.calls.map(([pathname]) => pathname)).toEqual(
        engines.warmed.flatMap((family) => paths[family]),
      );
      const budgets = read.mock.calls.map(([, command]) => {
        if (
          command.type !== "pageCache.begin" ||
          !command.input ||
          !("maxBytes" in command.input)
        ) {
          throw new Error("Expected a page-cache budget");
        }
        return command.input.maxBytes;
      });
      if (budgets.length > 0) {
        expect(Math.min(...budgets)).toBeGreaterThan(0);
        expect(Math.max(...budgets) - Math.min(...budgets)).toBeLessThanOrEqual(1);
        if (!pressure) {
          expect(budgets.reduce((total, bytes) => total + bytes, 0)).toBe(2 * 1024 * 1024 * 1024);
        }
      }
      expect(stateAdmission).toHaveBeenCalledTimes(
        engines.state === "sqlite" && pressure !== "before" ? 1 : 0,
      );
      expect(log.warn).not.toHaveBeenCalled();
      if (hostPressure) {
        pressure = undefined;
        availableMemory.mockReturnValue(1024 ** 3);
        vi.mocked(os.freemem).mockReturnValue(1024 ** 3);
        read.mockClear();
        await warm();
        expect(read.mock.calls.map(([pathname]) => pathname)).toEqual([statePath, ...agentPaths]);
      }
    } finally {
      await closeOpenClawStateDatabaseByPathAsync(statePath);
    }
  },
);
