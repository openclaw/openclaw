import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.js";
import { installGatewayDatabaseEngine } from "../../gateway/server-database-engine.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { retireSqliteDatabaseAdmissionForPath } from "../sqlite-database-admission.js";
import { admitSqliteSchema } from "../sqlite-schema-facts.js";
import { conformanceWorkerResult, spawnConformanceWorker } from "./conformance.test-support.js";
import { getDatabaseEngineSelection } from "./context.js";
import { resetDatabaseEngineSelectionForTest } from "./context.test-support.js";
import type {
  MixedModeWorkerInput,
  MixedModeWorkerResult,
} from "./mixed-mode.conformance.test-support.js";
import { withDatabasePortConnection } from "./port-provider.js";

type WorkboardStore = {
  ready(): Promise<void>;
  listBoards(): Promise<{ boards: Array<{ id: string; name: string }> }>;
  upsertBoard(input: { id: string; name: string }): Promise<unknown>;
  close(): Promise<void>;
};
type ProofMode = "sqlite" | "state-postgres" | "workboard-postgres";

// Exercise the public plugin API without importing its implementation into core type graphs.
const { WorkboardStore } = await vi.importActual<{
  WorkboardStore: { openSqlite(workerModuleUrl: URL): WorkboardStore };
}>("../../../extensions/workboard/runtime-api.js");
const workerExtension = path.extname(new URL(import.meta.url).pathname);
const workboardWorker = new URL(
  `../../../extensions/workboard/src/sqlite-store.worker${workerExtension}`,
  import.meta.url,
);

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  resetDatabaseEngineSelectionForTest();
  vi.unstubAllEnvs();
});

async function inspectOwners(input: Omit<MixedModeWorkerInput, "admissions">) {
  const pathname = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: input.stateDir });
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const { anchor, worker } = spawnConformanceWorker(
    {
      currentModuleUrl: import.meta.url,
      sourceWorkerName: "mixed-mode.conformance.test-support",
      distWorkerPath: "infra/database-engine/mixed-mode.conformance.test-support.js",
    },
    pathname,
    input,
    admitSqliteSchema,
  );
  try {
    return await conformanceWorkerResult<MixedModeWorkerResult>(worker, "Mixed-mode");
  } finally {
    await worker.terminate();
    anchor.close();
    retireSqliteDatabaseAdmissionForPath(pathname);
  }
}

async function runProof(stateDir: string, mode: ProofMode) {
  resetDatabaseEngineSelectionForTest();
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  const secretFile = path.join(stateDir, "connection.json");
  if (mode === "workboard-postgres") {
    fs.writeFileSync(secretFile, JSON.stringify({ dsn: connection }), { mode: 0o600 });
  }
  const config: OpenClawConfig = { database: { engine: "sqlite" } };
  if (mode !== "sqlite") {
    config.database = {
      engine: "sqlite",
      families: { [mode === "state-postgres" ? "state" : "workboard"]: { engine: "postgres" } },
      postgres: { connection, schemaPrefix: "mixed_proof" },
    };
  }
  if (mode === "workboard-postgres") {
    config.database!.postgres!.connection = { source: "file", provider: "database", id: "/dsn" };
    config.secrets = { providers: { database: { source: "file", path: secretFile } } };
  }
  fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
  await installGatewayDatabaseEngine();
  if (mode === "workboard-postgres") {
    // Later plugin opens must use the boot fact after the SecretRef is unavailable.
    fs.unlinkSync(secretFile);
  }
  const selection = getDatabaseEngineSelection();
  expect(selection).toBeDefined();
  const requestEngines = new Set<string>();
  const observer = (message: unknown) => {
    requestEngines.add((message as { engine: string }).engine);
  };
  channel("openclaw.database.request").subscribe(observer);
  const boardName = async (store: WorkboardStore) =>
    (await store.listBoards()).boards.find((board) => board.id === "mixed-proof")?.name;
  let workboard: WorkboardStore | undefined;
  try {
    workboard = WorkboardStore.openSqlite(workboardWorker);
    await workboard.ready();
    const initialBoardName = await boardName(workboard);
    await workboard.upsertBoard({ id: "mixed-proof", name: "Mixed proof" });
    const writtenBoardName = await boardName(workboard);
    await workboard.close();
    workboard = WorkboardStore.openSqlite(workboardWorker);
    await workboard.ready();
    const reopenedBoardName = await boardName(workboard);
    await workboard.close();
    workboard = undefined;
    const result = await inspectOwners({ stateDir, selection: selection! });
    expect(getDatabaseEngineSelection()).toBe(selection);
    return {
      ...result,
      initialBoardName,
      boardName: writtenBoardName,
      reopenedBoardName,
      requestEngines: [...requestEngines].toSorted(),
    };
  } finally {
    await workboard?.close();
    channel("openclaw.database.request").unsubscribe(observer);
  }
}

async function assertBoot(mode: ProofMode) {
  const result = await runProof(tempDirs.make(`mixed-mode-${mode}-`), mode);
  expect(result).toMatchObject({
    stateEngine: mode === "state-postgres" ? "postgres" : "sqlite",
    agentEngine: "sqlite",
    workboardEngine: mode === "workboard-postgres" ? "postgres" : "sqlite",
    boardName: "Mixed proof",
    reopenedBoardName: "Mixed proof",
    stateValue: "retained",
    requestEngines: [mode === "workboard-postgres" ? "postgres" : "sqlite"],
  });
  if (mode !== "workboard-postgres") {
    expect(result.statementEngines).toEqual(
      mode === "sqlite" ? ["sqlite"] : ["postgres", "sqlite"],
    );
  }
  expect(result.statementCount).toBeGreaterThan(0);
  expect(result.statementThreadIds.every((id) => id !== 0)).toBe(true);
}

it("boots SQLite owners and reopens persisted data", () => assertBoot("sqlite"));

describe.skipIf(!connection)("mixed-mode boot conformance", () => {
  it("uses homogeneous overrides for lifecycle connections", async () => {
    const result = await withDatabasePortConnection(
      {
        database: {
          engine: "sqlite",
          families: {
            state: { engine: "postgres" },
            agent: { engine: "postgres" },
            workboard: { engine: "postgres" },
            logbook: { engine: "postgres" },
            "team-reports": { engine: "postgres" },
          },
          postgres: { connection },
        },
      },
      async (client) => await client.query<{ value: number }>("SELECT 42 AS value"),
    );
    expect(result.rows).toEqual([{ value: 42 }]);
  });

  it.each(["state-postgres", "workboard-postgres"] as const)(
    "boots %s owners and reopens persisted data",
    assertBoot,
  );

  it("refuses an existing SQLite Workboard override with the port remedy and retains its data", async () => {
    const stateDir = tempDirs.make("mixed-mode-mismatch-");
    await runProof(stateDir, "sqlite");
    await expect(runProof(stateDir, "workboard-postgres")).rejects.toThrow(
      /Existing SQLite workboard data cannot switch engines.*openclaw database port/,
    );
    await expect(runProof(stateDir, "sqlite")).resolves.toMatchObject({
      initialBoardName: "Mixed proof",
      workboardEngine: "sqlite",
      reopenedBoardName: "Mixed proof",
    });
  });
});
