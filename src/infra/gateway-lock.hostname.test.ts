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

function ownerLocation() {
  const root = roots.make("openclaw-hostname-owner-");
  const databasePath = path.join(root, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(databasePath));
  return { root, databasePath, ownerPath: resolveGatewayStateOwnerPath(databasePath) };
}

function expectSuccessor(databasePath: string, ownerId: string) {
  const successor = acquireGatewayStateOwner({ databasePath });
  try {
    successor.assertCurrent();
    expect(JSON.parse(fs.readFileSync(successor.path, "utf8")).ownerId).not.toBe(ownerId);
  } finally {
    successor.release();
  }
}

const localMachine = "a".repeat(64);
const otherMachine = "b".repeat(64);
it.runIf(process.platform === "darwin" || process.platform === "linux").each([
  ["same machine", localMachine, localMachine, process.platform === "darwin"],
  ["different machine", otherMachine, localMachine, false],
  [
    "different machine with same hostname",
    otherMachine,
    localMachine,
    process.platform === "linux",
  ],
  ["unavailable local machine", localMachine, null, false],
  ["unavailable owner machine", null, localMachine, false],
  ["malformed owner machine", "invalid-digest", localMachine, false],
  ["unavailable local machine with same hostname", localMachine, null, true],
  ["unavailable owner machine with same hostname", null, localMachine, true],
  ["legacy owner", undefined, localMachine, false],
] as const)("handles a previous-boot owner from a %s", async (kind, machine, local, reclaim) => {
  vi.spyOn(machineIdentity, "readProcessMachineIdentity").mockReturnValue(local);
  const namespace = readGatewayLockProcessNamespace();
  if (!namespace || !("identity" in namespace)) {
    throw new Error("The fixture requires native boot identity");
  }
  const { databasePath, ownerPath } = ownerLocation();
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
  expectSuccessor(databasePath, payload.ownerId);
});

it.each(["live", "exited", "reused", "different boot"] as const)(
  "preserves process ownership across a hostname change (%s owner)",
  async (kind) => {
    const namespace = readGatewayLockProcessNamespace();
    const startTime = getFileLockProcessStartTime(process.pid);
    if (!namespace || startTime === null) {
      throw new Error("The fixture requires native kernel and process-start identity");
    }
    const { root, databasePath, ownerPath } = ownerLocation();
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
    const recorded = JSON.stringify(payload);
    fs.writeFileSync(ownerPath, recorded);
    if (expected !== "dead") {
      let unexpected: ReturnType<typeof acquireGatewayStateOwner> | undefined;
      try {
        expect(() => {
          unexpected = acquireGatewayStateOwner({ databasePath });
        }).toThrow();
        expect(fs.readFileSync(ownerPath, "utf8")).toBe(recorded);
      } finally {
        unexpected?.release();
      }
    } else {
      expectSuccessor(databasePath, payload.ownerId);
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
    const { databasePath } = ownerLocation();
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
