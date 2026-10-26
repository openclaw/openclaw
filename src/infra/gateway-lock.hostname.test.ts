import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import * as machineIdentity from "./current-machine-identity.js";
import { readGatewayLockProcessNamespace } from "./gateway-lock-payload.js";
import { resolveGatewayOwnerStatus } from "./gateway-lock.js";
import { defaultPayload } from "./gateway-state-owner-record.js";
import { acquireGatewayStateOwner, resolveGatewayStateOwnerPath } from "./gateway-state-owner.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { hasVerifiedLiveSqliteOwner } from "./sqlite-live-owner.js";
import { prepareSqliteReadOnlyLocationAwaited } from "./sqlite-snapshot-source.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.runIf(process.platform === "darwin" || process.platform === "linux").each([
  {
    kind: "same machine",
    machine: "a".repeat(64),
    localMachine: "a".repeat(64),
    reclaim: process.platform === "darwin",
  },
  {
    kind: "different machine",
    machine: "b".repeat(64),
    localMachine: "a".repeat(64),
    reclaim: false,
  },
  {
    kind: "different machine with same hostname",
    machine: "b".repeat(64),
    localMachine: "a".repeat(64),
    reclaim: process.platform === "linux",
  },
  {
    kind: "unavailable local machine",
    machine: "a".repeat(64),
    localMachine: null,
    reclaim: false,
  },
  {
    kind: "unavailable owner machine",
    machine: null,
    localMachine: "a".repeat(64),
    reclaim: false,
  },
  {
    kind: "malformed owner machine",
    machine: "invalid-digest",
    localMachine: "a".repeat(64),
    reclaim: false,
  },
  {
    kind: "unavailable local machine with same hostname",
    machine: "a".repeat(64),
    localMachine: null,
    reclaim: true,
  },
  {
    kind: "unavailable owner machine with same hostname",
    machine: null,
    localMachine: "a".repeat(64),
    reclaim: true,
  },
  { kind: "legacy owner", machine: undefined, localMachine: "a".repeat(64), reclaim: false },
])(
  "handles a previous-boot owner from a $kind",
  async ({ kind, machine, localMachine, reclaim }) => {
    vi.spyOn(machineIdentity, "readProcessMachineIdentity").mockReturnValue(localMachine);
    const namespace = readGatewayLockProcessNamespace();
    if (!namespace || !("identity" in namespace)) {
      throw new Error("The fixture requires native boot identity");
    }
    const root = roots.make("openclaw-rebooted-owner-");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    const ownerPath = resolveGatewayStateOwnerPath(databasePath);
    const payload = {
      ...defaultPayload(databasePath),
      // Deliberately reuse a currently live PID and start time: the old boot proves death.
      ownerId: "previous-boot-owner",
      role: "gateway" as const,
      machineIdentity: machine,
      processNamespace: {
        ...namespace,
        host: kind.endsWith("same hostname") ? namespace.host : "previous-hostname",
        identity: "87654321-abcd-0123-abcd-0123456789ab",
      },
    };
    const record = JSON.stringify(payload);
    fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
    fs.writeFileSync(ownerPath, record);
    expect(await resolveGatewayOwnerStatus(payload.pid, payload, process.platform)).toBe(
      reclaim ? "dead" : "unknown",
    );
    if (!reclaim) {
      if (kind === "malformed owner machine") {
        expect(hasVerifiedLiveSqliteOwner(databasePath)).toBe(false);
      } else {
        expect(() => hasVerifiedLiveSqliteOwner(databasePath)).toThrow(
          "openclaw gateway recover-lock",
        );
      }
      expect(() => acquireGatewayStateOwner({ databasePath })).toThrow(
        "openclaw gateway recover-lock",
      );
      expect(fs.readFileSync(ownerPath, "utf8")).toBe(record);
      return;
    }
    expect(hasVerifiedLiveSqliteOwner(databasePath)).toBe(false);
    const successor = acquireGatewayStateOwner({ databasePath });
    try {
      successor.assertCurrent();
      expect(JSON.parse(fs.readFileSync(ownerPath, "utf8")).ownerId).not.toBe(payload.ownerId);
    } finally {
      successor.release();
    }
  },
);

it.each(["live", "exited", "reused", "different boot"] as const)(
  "preserves process ownership across a hostname change (%s owner)",
  async (kind) => {
    const namespace = readGatewayLockProcessNamespace();
    const startTime = getFileLockProcessStartTime(process.pid);
    if (!namespace || startTime === null) {
      throw new Error("The fixture requires native kernel and process-start identity");
    }
    const root = roots.make("openclaw-renamed-owner-");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    const ownerPath = resolveGatewayStateOwnerPath(databasePath);
    const payload = {
      pid: kind === "exited" ? 2_147_483_647 : process.pid,
      ownerId: "previous-owner",
      role: "gateway" as const,
      createdAt: new Date().toISOString(),
      configPath: path.join(root, "openclaw.json"),
      startTime: kind === "reused" ? startTime + 1 : startTime,
      processNamespace: {
        ...namespace,
        host: "previous-hostname",
        ...(kind === "different boot" ? { identity: "87654321-abcd-0123-abcd-0123456789ab" } : {}),
      },
    };
    const expected =
      process.platform !== "darwin" || kind === "different boot"
        ? "unknown"
        : kind === "live"
          ? "alive"
          : "dead";
    expect(await resolveGatewayOwnerStatus(payload.pid, payload, process.platform)).toBe(expected);
    fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
    const recorded = JSON.stringify(payload);
    fs.writeFileSync(ownerPath, recorded);
    let successor: ReturnType<typeof acquireGatewayStateOwner> | undefined;
    try {
      if (expected !== "dead") {
        expect(() => {
          successor = acquireGatewayStateOwner({ databasePath });
        }).toThrow();
        expect(fs.readFileSync(ownerPath, "utf8")).toBe(recorded);
        return;
      }
      successor = acquireGatewayStateOwner({ databasePath });
      successor.assertCurrent();
      expect(JSON.parse(fs.readFileSync(ownerPath, "utf8")).ownerId).not.toBe(payload.ownerId);
    } finally {
      successor?.release();
    }
  },
);

it.runIf(process.platform === "darwin" || process.platform === "linux").each([
  { kind: "available", ownerAvailable: true, localAvailable: true },
  { kind: "owner unavailable", ownerAvailable: false, localAvailable: true },
  { kind: "local unavailable", ownerAvailable: true, localAvailable: false },
  { kind: "both unavailable", ownerAvailable: false, localAvailable: false },
])(
  "reads a same-boot live owner's SQLite metadata with $kind machine evidence",
  async ({ ownerAvailable, localAvailable }) => {
    // The real snapshot child observes the same machine, outside this process's mocks.
    const nativeMachine = machineIdentity.readProcessMachineIdentity();
    vi.spyOn(machineIdentity, "readProcessMachineIdentity").mockReturnValue(
      localAvailable ? nativeMachine : null,
    );
    const root = roots.make("openclaw-renamed-reader-");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath));
    {
      using db = new (requireNodeSqlite().DatabaseSync)(databasePath);
      db.exec("CREATE TABLE probe(value); INSERT INTO probe VALUES('preserved');");
    }
    const payload = defaultPayload(databasePath);
    if (!payload.processNamespace) {
      throw new Error("The fixture requires the native kernel identity");
    }
    const owner = acquireGatewayStateOwner({
      databasePath,
      payload: {
        ...payload,
        role: "gateway",
        machineIdentity: ownerAvailable ? nativeMachine : null,
        processNamespace: {
          ...payload.processNamespace,
          ...(process.platform === "darwin" ? { host: "previous-hostname" } : {}),
        },
      },
    });
    const recorded = fs.readFileSync(owner.path);
    try {
      expect(hasVerifiedLiveSqliteOwner(databasePath)).toBe(true);
      const snapshot = await prepareSqliteReadOnlyLocationAwaited(databasePath, {
        signal: new AbortController().signal,
        expectedSourceIdentity: readDatabasePathIdentitySync(databasePath),
        allowLiveOwner: true,
      });
      try {
        using db = new (requireNodeSqlite().DatabaseSync)(snapshot.location, { readOnly: true });
        expect(db.prepare("SELECT value FROM probe").all()).toEqual([{ value: "preserved" }]);
      } finally {
        expect(await snapshot.cleanupAsync()).toBe(true);
      }
      owner.assertCurrent();
      expect(fs.readFileSync(owner.path)).toEqual(recorded);
    } finally {
      owner.release();
    }
  },
);
