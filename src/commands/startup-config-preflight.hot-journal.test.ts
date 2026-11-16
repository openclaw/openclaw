import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createHotSqliteRollbackJournal } from "../../test/helpers/sqlite-hot-journal.js";
import { prepareGatewayRunBootstrap } from "../cli/gateway-cli/pre-bootstrap.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { ExitError } from "../runtime.js";
import { withLiveStateReads } from "../state/artifact-preserving-state-reads.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import {
  getActiveOpenClawStateDatabaseReadSnapshot,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runStartupConfigPreflight } from "./startup-config-preflight.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  "recover",
  "external-owner",
  "changed-source",
  "guard-rejected",
  "healthy-delete",
  "healthy-wal",
] as const)("selects the startup state source safely: %s", async (scenario) => {
  await withOpenClawTestState({ label: "gateway-hot-journal" }, async (state) => {
    await state.writeConfig({ gateway: { mode: "local" }, plugins: { enabled: false } });
    const ownership = JSON.stringify({
      version: 1,
      mode: "external",
      managerId: "fixture-supervisor",
      claimedAt: 1,
    });
    const database = openOpenClawStateDatabase({ env: state.env });
    const insert = database.db.prepare(
      "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
    );
    insert.run("hot-journal.fixture", '"committed"', 1);
    if (scenario === "external-owner") {
      insert.run("gateway.supervision", ownership, 1);
    }
    const databasePath = database.path;
    const hot = scenario !== "healthy-delete" && scenario !== "healthy-wal";
    if (scenario === "healthy-delete") {
      database.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;");
    }
    await closeOpenClawStateDatabaseAsync();
    if (hot) {
      createHotSqliteRollbackJournal({
        path: databasePath,
        mutationSql:
          "UPDATE config_machine_state SET value_json = '\"uncommitted\"' WHERE state_key = 'hot-journal.fixture'",
      });
    }
    if (scenario === "healthy-delete") {
      fs.writeFileSync(`${databasePath}-journal`, Buffer.alloc(512));
    }
    const before = fs.readFileSync(databasePath);
    const journal = hot ? fs.readFileSync(`${databasePath}-journal`) : undefined;
    const runtime = {
      log() {},
      error() {},
      exit(code: number): never {
        throw new ExitError(code);
      },
    };
    const copies = vi.spyOn(snapshots, "startSqliteReadOnlyLocationAsync");
    if (scenario === "recover") {
      await expect(
        withLiveStateReads(() =>
          withOpenClawStateDatabaseReadSnapshot(
            async () => readConfigMachineState("hot-journal.fixture", { env: state.env }),
            { env: state.env },
          ),
        ),
      ).rejects.toThrow(/readonly database/);
      expect(copies).not.toHaveBeenCalled();
      expect(fs.readFileSync(databasePath)).toEqual(before);
      expect(fs.readFileSync(`${databasePath}-journal`)).toEqual(journal);
    }
    expect(await prepareGatewayRunBootstrap({ opts: {}, runtime })).toBe(true);
    expect(fs.readFileSync(databasePath)).toEqual(before);
    if (hot) {
      expect(fs.readFileSync(`${databasePath}-journal`)).toEqual(journal);
    }
    const selectedSources = new Set<string>();
    let changedSource: Buffer | undefined;
    const ready = runStartupConfigPreflight({
      gateway: true,
      observe: false,
      validateStartupConfig: () => {
        const selected = getActiveOpenClawStateDatabaseReadSnapshot({ env: state.env });
        expect(selected?.location).toBeDefined();
        selectedSources.add(selected!.location);
      },
      beforeStatePreparation: async () => {
        if (scenario === "changed-source") {
          const changed = new (requireNodeSqlite().DatabaseSync)(databasePath);
          try {
            changed
              .prepare(
                "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
              )
              .run("gateway.supervision", ownership, 1);
          } finally {
            changed.close();
          }
          changedSource = fs.readFileSync(databasePath);
        }
        return scenario !== "guard-rejected";
      },
    });
    if (scenario === "recover" || !hot) {
      expect((await ready).snapshot.valid).toBe(true);
      expect(readConfigMachineState("hot-journal.fixture", { env: state.env })).toBe("committed");
      if (scenario === "recover") {
        expect(fs.existsSync(`${databasePath}-journal`)).toBe(false);
      }
    } else if (scenario === "external-owner" || scenario === "guard-rejected") {
      await expect(ready).rejects.toThrow(
        scenario === "external-owner" ? /externally supervised/ : /selected config changed/,
      );
      expect(fs.readFileSync(databasePath)).toEqual(before);
      expect(fs.readFileSync(`${databasePath}-journal`)).toEqual(journal);
    } else {
      await expect(ready).rejects.toThrow(/source changed during startup admission/);
      expect(fs.readFileSync(databasePath)).toEqual(changedSource);
    }
    expect(copies.mock.calls.filter(([pathname]) => pathname === databasePath)).toHaveLength(
      hot ? 1 : 0,
    );
    expect(selectedSources.size).toBe(1);
    for (const source of selectedSources) {
      if (hot) {
        expect(source).not.toBe(databasePath);
        expect(fs.existsSync(source)).toBe(false);
      } else {
        expect(source).toBe(databasePath);
      }
    }
    await closeOpenClawStateDatabaseAsync();
  });
});
