import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  readPreparedPoolPresenceDemandInDatabase as readStored,
  writePreparedPoolPresenceDemandInDatabase as writeStored,
} from "./prepared-pool-presence-store.worker.js";
import {
  readPreparedPoolPresenceDemand as readDemand,
  writePreparedPoolPresenceDemand as writeDemand,
} from "./prepared-pool-presence-worker.js";
import type { PreparedPoolPresenceDemand } from "./prepared-pool-presence.types.js";

const PRESENCE_KEY = "cloudWorkers.preparedPool.humanPresenceDemand";
const INVALID = "Prepared-pool presence demand is invalid";
const selectHost = (host: string) => setRuntimeConfigSnapshot({ gateway: { github: { host } } });

const demand = (): PreparedPoolPresenceDemand => ({
  revision: 1,
  profileId: "example-azure",
  requestedRef: "main",
  preparationKey: "b".repeat(64),
  lastPresentAtMs: 1_000,
  retireAtMs: null,
  project: {
    key: "a".repeat(64),
    baseCommit: "c".repeat(40),
    source: {
      kind: "repository",
      url: "https://github.com/acme/private-repo.git",
      repositoryId: "R_acme_private_repo",
      owner: {
        agent: { agentId: "main", provenance: null },
        identity: { source: "system-detected", accountId: 123 },
      },
    },
  },
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let database: OpenClawStateDatabase;
let root: string;
const open = () => openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
const insert = (key: string, value: unknown) =>
  database.db
    .prepare(
      "INSERT INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
    )
    .run(key, JSON.stringify(value), 1);

beforeEach(async () => {
  root = tempDirs.make("prepared-presence-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  database = open();
});

afterEach(async () => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
});

it("rolls back demand when the Gateway host changes before commit admission", async () => {
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission").mockImplementation((admit) =>
    createAdmission((request, grant) => {
      if (request.stage === "commit") {
        selectHost("ghe.example.test");
      }
      admit(request, grant);
    }),
  );
  await expect(writeDemand(demand(), () => {})).rejects.toThrow(INVALID);
  expect(readStored(database.db)).toBeUndefined();
});

it.each(["github.com", "ghe.example.test"])(
  "persists validated %s demand and deletes only its owned key",
  async (host) => {
    selectHost(host);
    const selected = demand();
    selected.project.source.url = `https://${host}/acme/private-repo.git`;
    expect(await writeDemand(selected, () => {})).toEqual(selected);
    expect(readStored(database.db)).toEqual(selected);
    expect(await readDemand()).toEqual(selected);

    await closeOpenClawStateDatabaseAsync();
    database = open();
    expect(readStored(database.db)).toEqual(selected);

    insert("unrelated", {});
    expect(await writeDemand(null, () => {})).toBeUndefined();
    expect(readStored(database.db)).toBeUndefined();
    expect(await readDemand()).toBeUndefined();
    expect(
      database.db
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
        .get("unrelated"),
    ).toEqual({ value_json: "{}" });
  },
);

it("refuses malformed retained timing instead of resetting it", () => {
  insert(PRESENCE_KEY, { ...demand(), retireAtMs: 999 });
  expect(() => readStored(database.db)).toThrow(INVALID);
});

it("reads an existing demand after the configured GitHub host changes", async () => {
  writeStored(database.db, demand());
  setRuntimeConfigSnapshot({
    gateway: {
      github: { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
    },
  });

  expect(readStored(database.db)).toEqual(demand());
  await expect(writeDemand(demand(), () => {})).rejects.toThrow(INVALID);
});
