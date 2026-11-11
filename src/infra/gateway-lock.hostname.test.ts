import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import * as machineIdentity from "./current-machine-identity.js";
import { readGatewayLockProcessNamespace } from "./gateway-lock-payload.js";
import { defaultPayload } from "./gateway-state-owner-record.js";
import { acquireGatewayStateOwner, resolveGatewayStateOwnerPath } from "./gateway-state-owner.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { hasVerifiedLiveSqliteOwner } from "./sqlite-live-owner.js";
import { prepareSqliteReadOnlyLocationAwaited } from "./sqlite-snapshot-source.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const localMachine = "a".repeat(64),
  otherMachine = "b".repeat(64);
const darwin = process.platform === "darwin";

function ownerLocation() {
  const root = roots.make("openclaw-hostname-owner-");
  const databasePath = path.join(root, "state", "openclaw.sqlite");
  fs.mkdirSync(path.dirname(databasePath));
  const ownerPath = resolveGatewayStateOwnerPath(databasePath);
  fs.mkdirSync(path.dirname(ownerPath), { recursive: true });
  return { databasePath, ownerPath };
}

function previousBoot(
  kind: string,
  machine: string | null | undefined,
  local: string | null,
  dead: boolean,
) {
  return { kind, machine, local, dead, oldBoot: true, legacy: false };
}
function renamedHost(kind: string) {
  return {
    kind,
    machine: undefined,
    local: localMachine,
    oldBoot: kind === "different boot",
    legacy: true,
    dead: darwin && (kind === "exited" || kind === "reused"),
  };
}

it.each(
  [
    previousBoot("same machine", localMachine, localMachine, darwin),
    previousBoot("different machine", otherMachine, localMachine, false),
    previousBoot("different machine with same hostname", otherMachine, localMachine, !darwin),
    previousBoot("unavailable local machine", localMachine, null, false),
    previousBoot("unavailable owner machine", null, localMachine, false),
    previousBoot("malformed owner machine", "invalid-digest", localMachine, false),
    previousBoot("unavailable local machine with same hostname", localMachine, null, true),
    previousBoot("unavailable owner machine with same hostname", null, localMachine, true),
    previousBoot("legacy owner", undefined, localMachine, false),
    ...["live", "exited", "reused", "different boot"].map(renamedHost),
  ].filter((row) => row.legacy || darwin || process.platform === "linux"),
)("preserves ownership for $kind", async (row) => {
  vi.spyOn(machineIdentity, "readProcessMachineIdentity").mockReturnValue(row.local);
  const namespace = readGatewayLockProcessNamespace();
  const startTime = getFileLockProcessStartTime(process.pid);
  if (!namespace || (!row.legacy && !("identity" in namespace)) || startTime === null) {
    throw new Error("The fixture requires native boot and process-start identity");
  }
  const { databasePath, ownerPath } = ownerLocation();
  const payload = {
    ...defaultPayload(databasePath),
    ownerId: "previous-owner",
    role: "gateway" as const,
    machineIdentity: row.machine,
    pid: row.kind === "exited" ? 2_147_483_647 : process.pid,
    startTime: row.kind === "reused" ? startTime + 1 : startTime,
    processNamespace: {
      ...namespace,
      host: row.kind.endsWith("same hostname") ? namespace.host : "previous-hostname",
      ...(row.oldBoot ? { identity: "87654321-abcd-0123-abcd-0123456789ab" } : {}),
    },
  };
  const recorded = JSON.stringify(payload);
  fs.writeFileSync(ownerPath, recorded);
  if (!row.legacy) {
    if (row.dead || row.kind === "malformed owner machine") {
      expect(hasVerifiedLiveSqliteOwner(databasePath)).toBe(false);
    } else {
      expect(() => hasVerifiedLiveSqliteOwner(databasePath)).toThrow(
        "openclaw gateway recover-lock",
      );
    }
  }
  let successor: ReturnType<typeof acquireGatewayStateOwner> | undefined;
  try {
    if (!row.dead) {
      const acquire = () => {
        successor = acquireGatewayStateOwner({ databasePath });
      };
      if (row.legacy) {
        expect(acquire).toThrow();
      } else {
        expect(acquire).toThrow("openclaw gateway recover-lock");
      }
      expect(fs.readFileSync(ownerPath, "utf8")).toBe(recorded);
    } else {
      successor = acquireGatewayStateOwner({ databasePath });
      successor.assertCurrent();
      expect(JSON.parse(fs.readFileSync(ownerPath, "utf8")).ownerId).not.toBe(payload.ownerId);
    }
  } finally {
    successor?.release();
  }
});

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
