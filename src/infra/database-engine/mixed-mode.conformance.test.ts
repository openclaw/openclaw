import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { getEnvironmentData, Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { installGatewayDatabaseEngine } from "../../gateway/server-database-engine.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import {
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
} from "../runtime-worker-url.js";
import {
  captureSqliteDatabaseAdmissions,
  retireSqliteDatabaseAdmissionForPath,
} from "../sqlite-database-admission.js";
import { admitSqliteSchema } from "../sqlite-schema-facts.js";
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

// Exercise the public plugin API without importing its implementation into core type graphs.
const { WorkboardStore } = await vi.importActual<{
  WorkboardStore: { openSqlite(workerModuleUrl: URL): WorkboardStore };
}>("../../../extensions/workboard/runtime-api.js");

const configured: unknown = getEnvironmentData("openclaw.test.state.conformance.connection");
const connection = typeof configured === "string" ? configured : undefined;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  resetDatabaseEngineSelectionForTest();
  vi.unstubAllEnvs();
});

async function inspectOwners(
  input: Omit<MixedModeWorkerInput, "admissions">,
): Promise<MixedModeWorkerResult> {
  const pathname = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: input.stateDir });
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const anchor = openNodeSqliteDatabase(pathname);
  admitSqliteSchema(anchor);
  const url = resolveRuntimeWorkerUrl({
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "mixed-mode.conformance.test-support",
    distWorkerPath: "infra/database-engine/mixed-mode.conformance.test-support.js",
  });
  const worker = new Worker(url, {
    execArgv: resolveRuntimeWorkerThreadExecArgv(url),
    workerData: {
      ...input,
      admissions: captureSqliteDatabaseAdmissions(undefined, { location: pathname }),
    } satisfies MixedModeWorkerInput,
  });
  try {
    return await new Promise<MixedModeWorkerResult>((resolve, reject) => {
      let result: MixedModeWorkerResult | { error: string } | undefined;
      worker.on("message", (message: typeof result) => {
        result = message;
      });
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code !== 0 || !result) {
          reject(new Error(`Mixed-mode worker exited ${code} without a result`));
        } else if ("error" in result) {
          reject(new Error(result.error));
        } else {
          resolve(result);
        }
      });
    });
  } finally {
    await worker.terminate();
    anchor.close();
    retireSqliteDatabaseAdmissionForPath(pathname);
  }
}

async function runProof(
  stateDir: string,
  mode: "sqlite" | "state-postgres" | "workboard-postgres",
) {
  resetDatabaseEngineSelectionForTest();
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
  const secretFile = path.join(stateDir, "connection.json");
  if (mode === "workboard-postgres") {
    fs.writeFileSync(secretFile, JSON.stringify({ dsn: connection }), { mode: 0o600 });
  }
  fs.writeFileSync(
    process.env.OPENCLAW_CONFIG_PATH!,
    JSON.stringify({
      database: {
        engine: "sqlite",
        ...(mode === "sqlite"
          ? {}
          : {
              families: {
                [mode === "state-postgres" ? "state" : "workboard"]: { engine: "postgres" },
              },
              postgres: {
                connection:
                  mode === "workboard-postgres"
                    ? { source: "file", provider: "database", id: "/dsn" }
                    : connection,
                schemaPrefix: "mixed_proof",
              },
            }),
      },
      ...(mode === "workboard-postgres"
        ? { secrets: { providers: { database: { source: "file", path: secretFile } } } }
        : {}),
    }),
  );
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
  const openWorkboard = () =>
    WorkboardStore.openSqlite(
      new URL(
        `../../../extensions/workboard/src/sqlite-store.worker${path.extname(new URL(import.meta.url).pathname)}`,
        import.meta.url,
      ),
    );
  let workboard: WorkboardStore | undefined;
  try {
    workboard = openWorkboard();
    await workboard.ready();
    const initialBoardName = (await workboard.listBoards()).boards.find(
      (board) => board.id === "mixed-proof",
    )?.name;
    await workboard.upsertBoard({ id: "mixed-proof", name: "Mixed proof" });
    const boardName = (await workboard.listBoards()).boards.find(
      (board) => board.id === "mixed-proof",
    )?.name;
    await workboard.close();
    workboard = openWorkboard();
    await workboard.ready();
    const reopenedBoardName = (await workboard.listBoards()).boards.find(
      (board) => board.id === "mixed-proof",
    )?.name;
    await workboard.close();
    workboard = undefined;
    const result = await inspectOwners({ stateDir, selection: selection! });
    expect(getDatabaseEngineSelection()).toBe(selection);
    return {
      ...result,
      initialBoardName,
      boardName,
      reopenedBoardName,
      requestEngines: [...requestEngines].toSorted(),
    };
  } finally {
    await workboard?.close();
    channel("openclaw.database.request").unsubscribe(observer);
  }
}

it("boots the unchanged SQLite owners, captures only SQLite statements, and reopens persisted data", async () => {
  const result = await runProof(tempDirs.make("mixed-mode-sqlite-"), "sqlite");
  expect(result).toMatchObject({
    stateEngine: "sqlite",
    agentEngine: "sqlite",
    workboardEngine: "sqlite",
    boardName: "Mixed proof",
    reopenedBoardName: "Mixed proof",
    stateValue: "retained",
  });
  expect(result.statementEngines).toEqual(["sqlite"]);
  expect(result.statementCount).toBeGreaterThan(0);
  expect(result.statementThreadIds.every((id) => id !== 0)).toBe(true);
  expect(result.requestEngines).toEqual(["sqlite"]);
});

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

  it("boots fresh PostgreSQL state with real SQLite agent and Workboard owners", async () => {
    const result = await runProof(tempDirs.make("mixed-mode-state-"), "state-postgres");
    expect(result).toMatchObject({
      stateEngine: "postgres",
      agentEngine: "sqlite",
      workboardEngine: "sqlite",
      stateValue: "retained",
      reopenedBoardName: "Mixed proof",
    });
    expect(result.statementEngines).toEqual(["postgres", "sqlite"]);
    expect(result.statementThreadIds.every((id) => id !== 0)).toBe(true);
    expect(result.requestEngines).toEqual(["sqlite"]);
  });

  it("boots fresh SQLite state with the PostgreSQL Workboard opener and preserves selection on reopen", async () => {
    const result = await runProof(tempDirs.make("mixed-mode-workboard-"), "workboard-postgres");
    expect(result).toMatchObject({
      stateEngine: "sqlite",
      agentEngine: "sqlite",
      workboardEngine: "postgres",
      stateValue: "retained",
      reopenedBoardName: "Mixed proof",
    });
    expect(result.requestEngines).toEqual(["postgres"]);
    expect(result.statementThreadIds.every((id) => id !== 0)).toBe(true);
  });

  it("refuses an existing SQLite Workboard override with the port remedy and retains its data", async () => {
    const stateDir = tempDirs.make("mixed-mode-mismatch-");
    await runProof(stateDir, "sqlite");
    await expect(runProof(stateDir, "workboard-postgres")).rejects.toThrow(
      /Existing SQLite workboard data cannot switch engines.*openclaw database port/,
    );
    const retained = await runProof(stateDir, "sqlite");
    expect(retained.initialBoardName).toBe("Mixed proof");
    expect(retained.workboardEngine).toBe("sqlite");
    expect(retained.reopenedBoardName).toBe("Mixed proof");
  });
});
