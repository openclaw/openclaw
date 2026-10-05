import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  readPreparedPoolPresenceDemandInDatabase,
  writePreparedPoolPresenceDemandInDatabase,
} from "./prepared-pool-presence-store.worker.js";
import {
  readPreparedPoolPresenceDemand,
  writePreparedPoolPresenceDemand,
} from "./prepared-pool-presence-worker.js";
import type { PreparedPoolPresenceDemand } from "./prepared-pool-presence.types.js";

const PRESENCE_KEY = "cloudWorkers.preparedPool.humanPresenceDemand";

const demand = () =>
  ({
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
  }) satisfies PreparedPoolPresenceDemand;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("prepared-pool human-presence demand storage", () => {
  let database: OpenClawStateDatabase;
  let root: string;

  beforeEach(async () => {
    root = tempDirs.make("prepared-presence-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
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
          setRuntimeConfigSnapshot({ gateway: { github: { host: "ghe.example.test" } } });
        }
        admit(request, grant);
      }),
    );
    await expect(writePreparedPoolPresenceDemand(demand(), () => {})).rejects.toThrow(
      "Prepared-pool presence demand is invalid",
    );
    expect(readPreparedPoolPresenceDemandInDatabase(database.db)).toBeUndefined();
  });

  it.each(["github.com", "ghe.example.test"])(
    "persists validated %s demand and deletes only its owned key",
    async (host) => {
      setRuntimeConfigSnapshot({ gateway: { github: { host } } });
      const selected = demand();
      selected.project.source.url = `https://${host}/acme/private-repo.git`;
      expect(await writePreparedPoolPresenceDemand(selected, () => {})).toEqual(selected);
      expect(readPreparedPoolPresenceDemandInDatabase(database.db)).toEqual(selected);
      expect(await readPreparedPoolPresenceDemand()).toEqual(selected);

      await closeOpenClawStateDatabaseAsync();
      database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
      expect(readPreparedPoolPresenceDemandInDatabase(database.db)).toEqual(selected);

      database.db
        .prepare(
          "INSERT INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
        )
        .run("unrelated", "{}", 1);
      expect(await writePreparedPoolPresenceDemand(null, () => {})).toBeUndefined();
      expect(readPreparedPoolPresenceDemandInDatabase(database.db)).toBeUndefined();
      expect(await readPreparedPoolPresenceDemand()).toBeUndefined();
      expect(
        database.db
          .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
          .get("unrelated"),
      ).toEqual({ value_json: "{}" });
    },
  );

  it("reads old-host demand for retirement while refusing current-owner renewal", async () => {
    const retained = demand();
    await writePreparedPoolPresenceDemand(retained, () => {});
    setRuntimeConfigSnapshot({
      gateway: {
        github: {
          host: "replaced.ghe.example.test",
          apiBaseUrl: "https://replaced.ghe.example.test/api/v3",
        },
      },
    });
    expect(await readPreparedPoolPresenceDemand()).toEqual(retained);
    await expect(writePreparedPoolPresenceDemand(retained, () => {})).rejects.toThrow(
      "Prepared-pool presence demand is invalid",
    );
    expect(await writePreparedPoolPresenceDemand(null, () => {})).toBeUndefined();
    expect(await readPreparedPoolPresenceDemand()).toBeUndefined();
  });

  it("refuses malformed retained timing instead of resetting it", () => {
    database.db
      .prepare(
        "INSERT INTO config_machine_state(state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
      )
      .run(PRESENCE_KEY, JSON.stringify({ ...demand(), retireAtMs: 999 }), 1);
    expect(() => readPreparedPoolPresenceDemandInDatabase(database.db)).toThrow(
      "Prepared-pool presence demand is invalid",
    );
  });

  it("reads an existing demand after the configured GitHub host changes", async () => {
    writePreparedPoolPresenceDemandInDatabase(database.db, demand());
    setRuntimeConfigSnapshot({
      gateway: {
        github: { host: "ghe.example.test", apiBaseUrl: "https://ghe.example.test/api/v3" },
      },
    });

    expect(readPreparedPoolPresenceDemandInDatabase(database.db)).toEqual(demand());
    await expect(writePreparedPoolPresenceDemand(demand(), () => {})).rejects.toThrow(
      "Prepared-pool presence demand is invalid",
    );
  });
});
