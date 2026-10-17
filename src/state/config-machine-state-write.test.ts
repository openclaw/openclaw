import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readSharedAuthProfileRows } from "../agents/auth-profiles/sqlite-read.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { writeConfigMachineStateAsync } from "./config-machine-state-async.js";
import {
  deleteConfigMachineState,
  importConfigMachineState,
  updateConfigMachineState,
  writeConfigMachineState,
} from "./config-machine-state-write.js";
import { readConfigMachineState } from "./config-machine-state.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import {
  authProfileCredentialPublication,
  captureAuthProfileCredentialAuthority,
} from "./user-model-account-authority.js";

const leases: Array<ReturnType<typeof acquireGatewayStateOwner>> = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeStateDatabaseForTest();
    for (const lease of leases.splice(0)) {
      lease.release();
    }
    vi.restoreAllMocks();
    cleanup();
  });
});

it("publishes newly imported paths and keeps the first canonical value", () => {
  const options = {
    env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("machine-state-") },
  };
  writeConfigMachineState("config.lastTouchedAt", "canonical", options);
  expect(readConfigMachineState("tts.prefsPath", options)).toBeUndefined();

  expect(
    importConfigMachineState(
      [
        ["tts.prefsPath", "/tmp/first-tts.json"],
        ["tts.prefsPath", "/tmp/ignored-tts.json"],
        ["config.lastTouchedAt", "legacy"],
      ],
      options,
    ),
  ).toEqual({
    imported: ["tts.prefsPath"],
    kept: ["tts.prefsPath", "config.lastTouchedAt"],
  });

  expect(readConfigMachineState("tts.prefsPath", options)).toBe("/tmp/first-tts.json");
  expect(readConfigMachineState("config.lastTouchedAt", options)).toBe("canonical");
});

const authKey = "authProfiles.store";
const profileId = "fixture:credential";
const credential = (key: string) => ({ type: "api_key" as const, provider: "fixture", key });
const store = (key: string) => ({ version: 1, profiles: { [profileId]: credential(key) } });

function credentialFixture() {
  const options = { env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("machine-auth-") } };
  const database = openOpenClawStateDatabase(options);
  leases.push(
    acquireGatewayStateOwner({
      databasePath: database.path,
      payload: {
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath: `${options.env.OPENCLAW_STATE_DIR}/openclaw.json`,
        role: "gateway",
      },
    }),
  );
  writeConfigMachineState(authKey, store("original"), options);
  const context = captureOpenClawStateWorkerContext(options);
  const capture = () =>
    captureAuthProfileCredentialAuthority(
      context,
      {
        identity: `${context.admission.identity.key}:${context.admission.identity.birthtime ?? ""}`,
        databasePath: database.path,
      },
      profileId,
    );
  const authority = capture();
  authority.observe(credential("original"));
  const read = () =>
    readConfigMachineState<ReturnType<typeof store>>(authKey, options)?.profiles[profileId];
  return { options, database, capture, read, readAuthority: authority.readCurrentCredential };
}

function watchCommits(database: ReturnType<typeof openOpenClawStateDatabase>, check: () => void) {
  const exec = database.db.exec.bind(database.db);
  vi.spyOn(database.db, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT") {
      check();
    }
    return exec(sql);
  });
}

describe("generic machine-state credential writes", () => {
  it.each(["write", "update", "delete", "update-delete"] as const)(
    "%s denies before commit and publishes the committed credential before release",
    (operation) => {
      const { options, database, read, readAuthority } = credentialFixture();
      let commits = 0;
      watchCommits(database, () => {
        commits += 1;
        expect(readAuthority).toThrow("authority is unavailable");
      });
      const expected = operation.includes("delete") ? undefined : credential("updated");
      let observed: ReturnType<typeof credential> | undefined;
      runOpenClawStateWriteTransaction(({ db }) => {
        if (operation === "write") {
          writeConfigMachineState(authKey, store("updated"), options);
        } else if (operation === "update") {
          updateConfigMachineState(authKey, () => store("updated"), options);
        } else if (operation === "delete") {
          expect(deleteConfigMachineState(authKey, options)).toBe(true);
        } else {
          updateConfigMachineState(authKey, () => undefined, options);
        }
        deferSqlitePostCommitPublication(db, () => {
          expect(readAuthority()).toEqual(expected);
          observed = read();
        });
      }, options);
      expect(commits).toBe(1);
      expect(readAuthority()).toEqual(expected);
      expect(observed).toEqual(expected);
    },
  );

  it("imports only the first value and preserves facts when a later import is ignored", () => {
    const { options, database, read, readAuthority } = credentialFixture();
    deleteConfigMachineState(authKey, options);
    watchCommits(database, () => expect(readAuthority).toThrow("authority is unavailable"));
    expect(
      importConfigMachineState(
        [
          [authKey, store("imported")],
          [authKey, store("ignored")],
        ],
        options,
      ),
    ).toEqual({ imported: [authKey], kept: [authKey] });
    expect(readAuthority()).toEqual(credential("imported"));
    expect(importConfigMachineState([[authKey, store("also-ignored")]], options)).toEqual({
      imported: [],
      kept: [authKey],
    });
    expect(readAuthority()).toEqual(read());
    expect(read()).toEqual(credential("imported"));
  });

  it("publishes the serialized durable value and preserves it against an overtaken cold read", () => {
    const { options, capture, read, readAuthority } = credentialFixture();
    const cold = capture();
    writeConfigMachineState(
      authKey,
      {
        ...store("unserialized"),
        toJSON: () => store("serialized"),
      },
      options,
    );
    cold.observe(credential("original"));
    expect(cold.readCurrentCredential()).toEqual(credential("serialized"));
    expect(readAuthority()).toEqual(read());
  });

  it("keeps the original facts after rollback and unrelated writes leave authority available", () => {
    const { options, database, read, readAuthority } = credentialFixture();
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        writeConfigMachineState(authKey, store("rolled-back"), options);
        expect(readAuthority).toThrow("authority is unavailable");
        throw new Error("cancel mutation");
      }, options),
    ).toThrow("cancel mutation");
    watchCommits(database, () => expect(readAuthority()).toEqual(credential("original")));
    writeConfigMachineState("config.lastTouchedAt", "updated", options);
    expect(readAuthority()).toEqual(read());
  });

  it("keeps host authority denied until an async worker's committed facts are installed", async () => {
    const { options, read, readAuthority } = credentialFixture();
    const events: string[] = [];
    const unsubscribe = authProfileCredentialPublication.subscribeFacts((change) => {
      events.push(change.kind);
      if (change.kind === "settled") {
        expect(readAuthority()).toEqual(credential("worker"));
      } else {
        expect(readAuthority).toThrow("authority is unavailable");
      }
    });
    try {
      await writeConfigMachineStateAsync(authKey, store("worker"), options);
    } finally {
      unsubscribe();
    }
    expect(events).toEqual(["pending", "committed", "settled"]);
    expect(readAuthority()).toEqual(read());
  });

  it("keeps an unknown worker publication denied even after a later successful write", async () => {
    const { options, read, readAuthority } = credentialFixture();
    const unsubscribe = authProfileCredentialPublication.subscribeFacts((change) => {
      if (change.kind === "committed") {
        throw new Error("synthetic fact installation failure");
      }
    });
    try {
      await writeConfigMachineStateAsync(authKey, store("unknown"), options);
    } finally {
      unsubscribe();
    }
    expect(readAuthority).toThrow("authority is unavailable");
    await writeConfigMachineStateAsync(authKey, store("later"), options);
    expect(read()).toEqual(credential("later"));
    expect(readAuthority).toThrow("authority is unavailable");
  });
});

it("keeps shared auth discovery warm and observes machine-state worker writes", async () => {
  const { options, read, readAuthority } = credentialFixture();
  const context = captureOpenClawStateWorkerContext(options);
  const rows = () => readSharedAuthProfileRows(context);
  const first = await rows();
  expect(first.store).toMatchObject({ status: "readable", raw: store("original") });

  await writeConfigMachineStateAsync("fixture.unrelated", 1, options);
  expect(await rows()).toBe(first);
  expect(read()).toEqual(credential("original"));
  expect(await rows()).toBe(first);

  await writeConfigMachineStateAsync(
    "authProfiles.state",
    { order: { fixture: [profileId] } },
    options,
  );
  expect((await rows()).state).toEqual({
    status: "readable",
    raw: { order: { fixture: [profileId] } },
  });

  await writeConfigMachineStateAsync(authKey, store("changed"), options);
  const changed = await rows();
  expect(changed.store).toMatchObject({ status: "readable", raw: store("changed") });
  expect(readAuthority()).toEqual(credential("changed"));

  expect(() =>
    runOpenClawStateWriteTransaction(() => {
      deleteConfigMachineState(authKey, options);
      throw new Error("rollback");
    }, options),
  ).toThrow("rollback");
  const afterRollback = await rows();
  expect(afterRollback).toEqual(changed);
  expect(await rows()).toBe(afterRollback);

  updateConfigMachineState("authProfiles.state", () => undefined, options);
  deleteConfigMachineState(authKey, options);
  expect(await rows()).toMatchObject({
    store: { status: "missing", reason: "row" },
    state: { status: "missing", reason: "row" },
  });
  expect(readAuthority()).toBeUndefined();

  importConfigMachineState([[authKey, store("reconnected")]], options);
  expect((await rows()).store).toMatchObject({
    status: "readable",
    raw: store("reconnected"),
  });
});
