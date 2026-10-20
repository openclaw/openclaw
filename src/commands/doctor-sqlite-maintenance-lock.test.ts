import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  GATEWAY_OWNER_HEARTBEAT_STALE_MS,
  readGatewayLockProcessNamespace,
  type LockPayload,
} from "../infra/gateway-lock-payload.js";
import {
  acquireGatewayLock,
  GatewayLockError,
  resolveGatewayLockPaths,
} from "../infra/gateway-lock.js";
import * as gatewayLockModule from "../infra/gateway-lock.js";
import { assertStateDatabaseAccessAllowed } from "../infra/gateway-state-owner.js";
import { prepareGithubIssue } from "../infra/github-issue.js";
import { createSessionSqliteMigrationRun } from "../infra/session-sqlite-migration-manifest.js";
import * as bootReader from "../infra/update-managed-service-handoff-boot.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import {
  claimSessionSqliteMigrationGithubIssue,
  createSessionSqliteMigrationFailureIssue,
  writeSessionSqliteMigrationFailureReports,
} from "./doctor-session-sqlite-failure.js";
import {
  DoctorSqliteMaintenanceLockUnavailableError,
  isDestructiveDoctorSessionSqliteMode,
  withDoctorSqliteMaintenanceLock,
} from "./doctor-sqlite-maintenance-lock.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(cleanup);
});

async function createLockFixture() {
  const root = tempDirs.make("openclaw-doctor-sqlite-lock-");
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const lockDir = path.join(root, "locks");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(configPath, "{}\n", "utf8");
  const env = {
    ...process.env,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    VITEST: "1",
  };
  const acquireLock = gatewayLockModule.acquireGatewayLock;
  vi.spyOn(gatewayLockModule, "acquireGatewayLock").mockImplementation((options) =>
    acquireLock(
      options?.role === "sqlite-maintenance"
        ? {
            ...options,
            lockDir,
            platform: "darwin",
            pollIntervalMs: 2,
            readProcessCmdline: () => ["openclaw-gateway"],
            timeoutMs: 15,
          }
        : options,
    ),
  );
  return {
    env,
    lockDir,
    maintain<T>(
      run: Parameters<typeof withDoctorSqliteMaintenanceLock<T>>[0]["run"],
      protectedPaths?: string[],
    ) {
      return withDoctorSqliteMaintenanceLock({
        env,
        operation: "state SQLite compaction",
        protectedPaths,
        run,
      });
    },
    async gateway(options: Parameters<typeof acquireGatewayLock>[0] = {}) {
      const lock = await acquireGatewayLock({
        allowInTests: true,
        env,
        lockDir,
        platform: "darwin",
        port: 18789,
        timeoutMs: 15,
        ...options,
      });
      if (!lock) {
        throw new Error("expected Gateway lock");
      }
      return lock;
    },
  };
}

async function expectPathRefused(
  fixture: Awaited<ReturnType<typeof createLockFixture>>,
  target: string,
  reason = /outside the active OpenClaw state directory/,
) {
  const run = vi.fn();
  await expect(fixture.maintain(run, [target])).rejects.toThrow(reason);
  expect(run).not.toHaveBeenCalled();
}

async function seedGatewayOwner(
  fixture: Awaited<ReturnType<typeof createLockFixture>>,
  identity: Pick<LockPayload, "pid" | "startTime" | "processNamespace">,
) {
  const { ownerLockPath } = resolveGatewayLockPaths(fixture.env, fixture.lockDir);
  const databasePath = path.join(fixture.env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
  const raw = JSON.stringify({
    ...identity,
    ownerId: "synthetic-gateway-owner",
    createdAt: new Date().toISOString(),
    configPath: fixture.env.OPENCLAW_CONFIG_PATH,
    stateDir: fixture.env.OPENCLAW_STATE_DIR,
    role: "gateway",
  });
  await fs.mkdir(path.dirname(ownerLockPath), { recursive: true });
  await fs.writeFile(ownerLockPath, raw);
  const now = new Date();
  await fs.utimes(ownerLockPath, now, now);
  return { ownerLockPath, databasePath, raw };
}

function mockLinuxNamespace(root: string) {
  if (process.platform !== "linux") {
    vi.spyOn(bootReader, "createManagedHandoffBootIdentityReader").mockReturnValue(() => ({
      platform: "linux",
      identity: "01234567-89ab-cdef-0123-456789abcdef",
    }));
    const namespaceLink = `pid:[${fsSync.statSync(root, { bigint: true }).ino}]`;
    const readlink = fsSync.readlinkSync.bind(fsSync);
    vi.spyOn(fsSync, "readlinkSync").mockImplementation((file, options) =>
      file === "/proc/self/ns/pid" ? namespaceLink : readlink(file, options),
    );
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    readGatewayLockProcessNamespace();
    platform.mockRestore();
  }
  const namespace = readGatewayLockProcessNamespace();
  if (!namespace || !("pidNsInode" in namespace)) {
    throw new Error("Expected Linux process namespace identity");
  }
  return namespace;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("doctor SQLite maintenance lock", () => {
  it.each([
    ["inspect", false],
    ["dry-run", false],
    ["validate", false],
    ["import", true],
    ["compact", true],
    ["restore", true],
    ["recover", true],
  ] as const)("classifies %s mode as destructive=%s", (mode, expected) => {
    expect(isDestructiveDoctorSessionSqliteMode(mode)).toBe(expected);
  });

  it("refuses maintenance while a verified Gateway owns the state lock", async () => {
    const fixture = await createLockFixture();
    const gatewayLock = await fixture.gateway();
    const run = vi.fn();

    try {
      const result = fixture.maintain(run);
      await expect(result).rejects.toBeInstanceOf(DoctorSqliteMaintenanceLockUnavailableError);
      await expect(result).rejects.toThrow(/OpenClaw state database is busy/);
      expect(run).not.toHaveBeenCalled();
    } finally {
      await gatewayLock.release();
    }
  });

  it.each(["absent PID", "different process at the same PID"] as const)(
    "preserves foreign-namespace ownership with %s before destructive maintenance",
    async (observation) => {
      const fixture = await createLockFixture();
      const startedAt = getFileLockProcessStartTime(process.pid);
      if (startedAt === null) {
        throw new Error("expected the local process namespace and start identity");
      }
      const namespace = mockLinuxNamespace(fixture.env.OPENCLAW_STATE_DIR);
      const owner = await seedGatewayOwner(fixture, {
        pid: observation === "absent PID" ? 2_147_483_647 : process.pid,
        startTime: startedAt + 1,
        processNamespace: { ...namespace, pidNsInode: `${namespace.pidNsInode}-foreign` },
      });
      const marker = path.join(fixture.env.OPENCLAW_STATE_DIR, "maintenance-marker");
      await fs.writeFile(marker, "Gateway data\n");
      const run = vi.fn(async () => fs.writeFile(marker, "reclaimed\n"));

      await expect(fixture.maintain(run, [marker])).rejects.toThrow(
        /cannot verify Gateway ownership.*heartbeat age does not prove.*inside the Gateway container/,
      );

      expect(run).not.toHaveBeenCalled();
      await expect(fs.readFile(marker, "utf8")).resolves.toBe("Gateway data\n");
      await expect(fs.readFile(owner.ownerLockPath, "utf8")).resolves.toBe(owner.raw);
      // Ordinary SQLite access does not grant the maintenance custody refused above.
      expect(() => assertStateDatabaseAccessAllowed(owner.databasePath)).not.toThrow();
    },
  );

  it.each(["same namespace", "previous boot"] as const)(
    "recovers a stopped Gateway's %s ownership through maintenance",
    async (kind) => {
      const fixture = await createLockFixture();
      const namespace = mockLinuxNamespace(fixture.env.OPENCLAW_STATE_DIR);
      const processNamespace =
        kind === "previous boot"
          ? {
              ...namespace,
              identity: namespace.identity.replace(/[0-9a-f]/i, (digit) =>
                digit === "1" ? "2" : "1",
              ),
            }
          : namespace;
      const owner = await seedGatewayOwner(fixture, {
        pid: kind === "previous boot" ? process.pid : 2_147_483_647,
        ...(kind === "previous boot"
          ? { startTime: getFileLockProcessStartTime(process.pid) ?? undefined }
          : {}),
        processNamespace,
      });
      const run = vi.fn(() => "done");

      await expect(fixture.maintain(run)).resolves.toBe("done");

      expect(run).toHaveBeenCalledOnce();
      await expect(fs.stat(owner.ownerLockPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["legacy record", "expired foreign heartbeat"] as const)(
    "preserves unverifiable %s ownership before maintenance",
    async (kind) => {
      const fixture = await createLockFixture();
      const namespace = mockLinuxNamespace(fixture.env.OPENCLAW_STATE_DIR);
      const owner = await seedGatewayOwner(fixture, {
        pid: 2_147_483_647,
        ...(kind === "legacy record"
          ? {}
          : { processNamespace: { ...namespace, pidNsInode: `${namespace.pidNsInode}-foreign` } }),
      });
      const expired = new Date(Date.now() - GATEWAY_OWNER_HEARTBEAT_STALE_MS - 1000);
      await fs.utimes(owner.ownerLockPath, expired, expired);
      const run = vi.fn();

      expect(() => assertStateDatabaseAccessAllowed(owner.databasePath)).not.toThrow();
      await expect(fixture.maintain(run)).rejects.toThrow(
        /cannot verify Gateway ownership.*openclaw gateway recover-lock/,
      );

      expect(run).not.toHaveBeenCalled();
      await expect(fs.readFile(owner.ownerLockPath, "utf8")).resolves.toBe(owner.raw);
    },
  );

  it("preserves a failed lock operation and its recovery action without running maintenance", async () => {
    const run = vi.fn();
    vi.spyOn(gatewayLockModule, "acquireGatewayLock").mockRejectedValue(
      new GatewayLockError(
        "failed to acquire gateway state ownership",
        Object.assign(new Error("permission denied"), { code: "EACCES" }),
      ),
    );
    await expect(
      withDoctorSqliteMaintenanceLock({ operation: "state SQLite compaction", run }),
    ).rejects.toThrow(/permission denied.*EACCES.*permissions/);
    expect(run).not.toHaveBeenCalled();
  });

  it("prevents Gateway startup until maintenance releases ownership", async () => {
    const fixture = await createLockFixture();
    const maintenanceMayFinish = createDeferred();
    const maintenanceStarted = createDeferred();
    const maintenance = fixture.maintain(async () => {
      maintenanceStarted.resolve();
      await maintenanceMayFinish.promise;
      return "done";
    });
    await maintenanceStarted.promise;

    await expect(
      fixture.gateway({
        pollIntervalMs: 2,
        readProcessCmdline: () => ["openclaw", "doctor", "--session-sqlite", "compact"],
        timeoutMs: 15,
      }),
    ).rejects.toBeInstanceOf(GatewayLockError);

    maintenanceMayFinish.resolve();
    await expect(maintenance).resolves.toBe("done");

    const gatewayLock = await fixture.gateway();
    await gatewayLock.release();
  });

  it("releases ownership after maintenance fails", async () => {
    const fixture = await createLockFixture();

    await expect(
      fixture.maintain(() => {
        throw new Error("restore failed");
      }),
    ).rejects.toThrow("restore failed");

    const gatewayLock = await fixture.gateway();
    await gatewayLock.release();
  });

  it("revokes retained maintenance authority before releasing the state lock", async () => {
    const fixture = await createLockFixture();
    let retained: { assertCurrent(): void } | undefined;

    await fixture.maintain((authority) => {
      retained = authority;
      expect(() => authority.assertCurrent()).not.toThrow();
    });

    expect(retained).toBeDefined();
    expect(() => retained?.assertCurrent()).toThrow(/maintenance authority has expired/);
  });

  it.each(["owner", "projection"] as const)(
    "refuses recovery receipt writes after %s custody is replaced",
    async (kind) => {
      const fixture = await createLockFixture();
      const { manifestPath } = createSessionSqliteMigrationRun(fixture.env, []);
      writeSessionSqliteMigrationFailureReports(manifestPath, {
        reason: "synthetic recovery failure",
      });
      const issue = createSessionSqliteMigrationFailureIssue(manifestPath);
      if (!issue) {
        throw new Error("expected recovery issue");
      }
      const prepared = prepareGithubIssue(issue);
      const originalManifest = await fs.readFile(manifestPath, "utf8");
      const paths = resolveGatewayLockPaths(fixture.env, fixture.lockDir);
      const replacedPath = kind === "owner" ? paths.ownerLockPath : paths.stateLockPath;

      await expect(
        fixture.maintain(
          async (authority) => {
            authority.assertCurrent();
            await fs.writeFile(replacedPath, "replacement", "utf8");
            return claimSessionSqliteMigrationGithubIssue(manifestPath, prepared, authority);
          },
          [manifestPath],
        ),
      ).rejects.toThrow(/ownership.*no longer current/);

      await expect(fs.readFile(manifestPath, "utf8")).resolves.toBe(originalManifest);
      await expect(fs.readFile(replacedPath, "utf8")).resolves.toBe("replacement");
    },
  );

  it("blocks maintenance when the Gateway used the multi-Gateway override", async () => {
    const fixture = await createLockFixture();
    const run = vi.fn();
    const gatewayLock = await fixture.gateway({
      env: { ...fixture.env, OPENCLAW_ALLOW_MULTI_GATEWAY: "1" },
    });

    try {
      await expect(fixture.maintain(run)).rejects.toThrow(/OpenClaw state database is busy/);
      expect(run).not.toHaveBeenCalled();
    } finally {
      await gatewayLock.release();
    }
  });

  it("uses the state ownership lock when maintenance inherits the multi-Gateway override", async () => {
    const fixture = await createLockFixture();

    await expect(
      withDoctorSqliteMaintenanceLock({
        env: { ...fixture.env, OPENCLAW_ALLOW_MULTI_GATEWAY: "1" },
        operation: "state SQLite compaction",
        run: () => "done",
      }),
    ).resolves.toBe("done");
  });

  it("refuses explicit destructive targets outside the locked state directory", async () => {
    const fixture = await createLockFixture();
    const externalPath = path.join(
      tempDirs.make("openclaw-external-session-store-"),
      "sessions.json",
    );
    await expectPathRefused(fixture, externalPath);

    const gatewayLock = await fixture.gateway();
    await gatewayLock.release();
  });

  it("refuses dangling in-state symlinks that resolve outside ownership", async () => {
    if (process.platform === "win32") {
      return;
    }
    const fixture = await createLockFixture();
    const sessionsDir = path.join(fixture.env.OPENCLAW_STATE_DIR, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    const outsideTarget = path.join(
      tempDirs.make("openclaw-dangling-session-target-"),
      "missing.json",
    );
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.symlink(outsideTarget, storePath);
    await expectPathRefused(fixture, storePath);
  });

  it("refuses outside path aliases that resolve into the locked state directory", async () => {
    if (process.platform === "win32") {
      return;
    }
    const fixture = await createLockFixture();
    const externalAlias = path.join(
      path.dirname(fixture.env.OPENCLAW_STATE_DIR),
      "external-state-alias",
    );
    await fs.symlink(fixture.env.OPENCLAW_STATE_DIR, externalAlias, "dir");
    const storePath = path.join(externalAlias, "agents", "main", "sessions", "sessions.json");
    await expectPathRefused(fixture, storePath);
  });

  it("refuses in-state hard links that can alias storage outside ownership", async () => {
    const fixture = await createLockFixture();
    const sessionsDir = path.join(fixture.env.OPENCLAW_STATE_DIR, "agents", "main", "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    const externalDir = path.join(path.dirname(fixture.env.OPENCLAW_STATE_DIR), "external-state");
    const externalPath = path.join(externalDir, "sessions.json");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.mkdir(externalDir, { recursive: true });
    await fs.writeFile(externalPath, "{}\n", "utf8");
    await fs.link(externalPath, storePath);
    await expectPathRefused(fixture, storePath, /hard-linked path/);
    await expect(fs.readFile(externalPath, "utf8")).resolves.toBe("{}\n");
  });

  it.skipIf(process.platform === "win32")(
    "refuses in-state symbolic links before destructive maintenance",
    async () => {
      const fixture = await createLockFixture();
      const sessionsDir = path.join(fixture.env.OPENCLAW_STATE_DIR, "agents", "main", "agent");
      const targetPath = path.join(sessionsDir, "sidecar-target");
      const sidecarPath = path.join(sessionsDir, "openclaw-agent.sqlite-wal");
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(targetPath, "owned target\n", "utf8");
      await fs.symlink(targetPath, sidecarPath);
      await expectPathRefused(fixture, sidecarPath, /symbolic-link path/);
      await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("owned target\n");
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses symbolic links in owned path ancestors",
    async () => {
      const fixture = await createLockFixture();
      const agentsDir = path.join(fixture.env.OPENCLAW_STATE_DIR, "agents");
      const realAgentDir = path.join(fixture.env.OPENCLAW_STATE_DIR, "real-main");
      const aliasedAgentDir = path.join(agentsDir, "main");
      const databasePath = path.join(aliasedAgentDir, "agent", "openclaw-agent.sqlite");
      await fs.mkdir(path.dirname(path.join(realAgentDir, "agent", "placeholder")), {
        recursive: true,
      });
      await fs.mkdir(agentsDir, { recursive: true });
      await fs.writeFile(path.join(realAgentDir, "agent", "openclaw-agent.sqlite"), "owned\n");
      await fs.symlink(realAgentDir, aliasedAgentDir, "dir");
      await expectPathRefused(fixture, databasePath, /symbolic-link path component/);
      await expect(
        fs.readFile(path.join(realAgentDir, "agent", "openclaw-agent.sqlite"), "utf8"),
      ).resolves.toBe("owned\n");
    },
  );
});
