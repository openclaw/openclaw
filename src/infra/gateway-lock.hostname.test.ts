import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { readGatewayLockProcessNamespace } from "./gateway-lock-payload.js";
import { resolveGatewayOwnerStatus } from "./gateway-lock.js";
import { defaultPayload } from "./gateway-state-owner-record.js";
import { acquireGatewayStateOwner, resolveGatewayStateOwnerPath } from "./gateway-state-owner.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { prepareSqliteReadOnlyLocationAwaited } from "./sqlite-snapshot-source.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

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

it.runIf(process.platform === "darwin")(
  "reads a live owner's SQLite metadata after a hostname change without reclaiming it",
  async () => {
    const root = roots.make("openclaw-renamed-reader-");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    fs.mkdirSync(path.dirname(databasePath));
    {
      using db = new (requireNodeSqlite().DatabaseSync)(databasePath);
      db.exec("CREATE TABLE probe(value); INSERT INTO probe VALUES('preserved');");
    }
    const payload = defaultPayload(databasePath);
    if (!payload.processNamespace || payload.processNamespace.platform !== "darwin") {
      throw new Error("The fixture requires the native Darwin kernel identity");
    }
    const owner = acquireGatewayStateOwner({
      databasePath,
      payload: {
        ...payload,
        role: "gateway",
        processNamespace: { ...payload.processNamespace, host: "previous-hostname" },
      },
    });
    const recorded = fs.readFileSync(owner.path);
    try {
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
