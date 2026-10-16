import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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

describe("machine-state import", () => {
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
  return { options, database, authority, capture, read };
}

describe("generic machine-state credential writes", () => {
  it.each(["write", "update", "delete", "update-delete"] as const)(
    "%s denies before commit and publishes the committed credential before release",
    (operation) => {
      const current = credentialFixture();
      const exec = current.database.db.exec.bind(current.database.db);
      let commits = 0;
      vi.spyOn(current.database.db, "exec").mockImplementation((sql) => {
        if (sql === "COMMIT") {
          commits += 1;
          expect(() => current.authority.readCurrentCredential()).toThrow(
            "authority is unavailable",
          );
        }
        return exec(sql);
      });
      const expected = operation.includes("delete") ? undefined : credential("updated");
      let observed: ReturnType<typeof credential> | undefined;
      runOpenClawStateWriteTransaction(({ db }) => {
        if (operation === "write") {
          writeConfigMachineState(authKey, store("updated"), current.options);
        } else if (operation === "update") {
          updateConfigMachineState(authKey, () => store("updated"), current.options);
        } else if (operation === "delete") {
          expect(deleteConfigMachineState(authKey, current.options)).toBe(true);
        } else {
          updateConfigMachineState(authKey, () => undefined, current.options);
        }
        deferSqlitePostCommitPublication(db, () => {
          expect(current.authority.readCurrentCredential()).toEqual(expected);
          observed = current.read();
        });
      }, current.options);
      expect(commits).toBe(1);
      expect(current.authority.readCurrentCredential()).toEqual(expected);
      expect(observed).toEqual(expected);
    },
  );

  it("imports only the first value and preserves facts when a later import is ignored", () => {
    const current = credentialFixture();
    deleteConfigMachineState(authKey, current.options);
    const exec = current.database.db.exec.bind(current.database.db);
    vi.spyOn(current.database.db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT") {
        expect(() => current.authority.readCurrentCredential()).toThrow("authority is unavailable");
      }
      return exec(sql);
    });
    expect(
      importConfigMachineState(
        [
          [authKey, store("imported")],
          [authKey, store("ignored")],
        ],
        current.options,
      ),
    ).toEqual({ imported: [authKey], kept: [authKey] });
    expect(current.authority.readCurrentCredential()).toEqual(credential("imported"));
    expect(importConfigMachineState([[authKey, store("also-ignored")]], current.options)).toEqual({
      imported: [],
      kept: [authKey],
    });
    expect(current.authority.readCurrentCredential()).toEqual(current.read());
    expect(current.read()).toEqual(credential("imported"));
  });

  it("publishes the serialized durable value and preserves it against an overtaken cold read", () => {
    const current = credentialFixture();
    const cold = current.capture();
    writeConfigMachineState(
      authKey,
      {
        ...store("unserialized"),
        toJSON: () => store("serialized"),
      },
      current.options,
    );
    cold.observe(credential("original"));
    expect(cold.readCurrentCredential()).toEqual(credential("serialized"));
    expect(current.authority.readCurrentCredential()).toEqual(current.read());
  });

  it("keeps the original facts after rollback and unrelated writes leave authority available", () => {
    const current = credentialFixture();
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        writeConfigMachineState(authKey, store("rolled-back"), current.options);
        expect(() => current.authority.readCurrentCredential()).toThrow("authority is unavailable");
        throw new Error("cancel mutation");
      }, current.options),
    ).toThrow("cancel mutation");
    const exec = current.database.db.exec.bind(current.database.db);
    vi.spyOn(current.database.db, "exec").mockImplementation((sql) => {
      if (sql === "COMMIT") {
        expect(current.authority.readCurrentCredential()).toEqual(credential("original"));
      }
      return exec(sql);
    });
    writeConfigMachineState("config.lastTouchedAt", "updated", current.options);
    expect(current.authority.readCurrentCredential()).toEqual(current.read());
  });

  it("keeps host authority denied until an async worker's committed facts are installed", async () => {
    const current = credentialFixture();
    const events: string[] = [];
    const unsubscribe = authProfileCredentialPublication.subscribeFacts((change) => {
      events.push(change.kind);
      if (change.kind === "settled") {
        expect(current.authority.readCurrentCredential()).toEqual(credential("worker"));
      } else {
        expect(() => current.authority.readCurrentCredential()).toThrow("authority is unavailable");
      }
    });
    try {
      await writeConfigMachineStateAsync(authKey, store("worker"), current.options);
    } finally {
      unsubscribe();
    }
    expect(events).toEqual(["pending", "committed", "settled"]);
    expect(current.authority.readCurrentCredential()).toEqual(current.read());
  });

  it("keeps an unknown worker publication denied even after a later successful write", async () => {
    const current = credentialFixture();
    const unsubscribe = authProfileCredentialPublication.subscribeFacts((change) => {
      if (change.kind === "committed") {
        throw new Error("synthetic fact installation failure");
      }
    });
    try {
      await writeConfigMachineStateAsync(authKey, store("unknown"), current.options);
    } finally {
      unsubscribe();
    }
    expect(() => current.authority.readCurrentCredential()).toThrow("authority is unavailable");
    await writeConfigMachineStateAsync(authKey, store("later"), current.options);
    expect(current.read()).toEqual(credential("later"));
    expect(() => current.authority.readCurrentCredential()).toThrow("authority is unavailable");
  });
});
