import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as gatewayLockProcessModule from "../infra/gateway-lock-process.js";
import {
  acquireGatewayLock,
  GatewayLockError,
  resolveGatewayLockPaths,
} from "../infra/gateway-lock.js";
import * as gatewayLockModule from "../infra/gateway-lock.js";
import { prepareGithubIssue } from "../infra/github-issue.js";
import { createSessionSqliteMigrationRun } from "../infra/session-sqlite-migration-manifest.js";
import {
  claimSessionSqliteMigrationGithubIssue,
  createSessionSqliteMigrationFailureIssue,
  writeSessionSqliteMigrationFailureReports,
} from "./doctor-session-sqlite-failure.js";
import {
  assertDoctorSqliteMaintenancePathsNotAliased,
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
  vi.spyOn(gatewayLockProcessModule, "readGatewayLockProcessCmdline").mockImplementation(() => [
    "openclaw-gateway",
  ]);
  vi.spyOn(gatewayLockModule, "acquireGatewayLock").mockImplementation((options) =>
    acquireLock(
      options?.role === "sqlite-maintenance"
        ? {
            ...options,
            lockDir,
            platform: "darwin",
            pollIntervalMs: 2,
            timeoutMs: 15,
          }
        : options,
    ),
  );
  return {
    env,
    lockDir,
    path: (...parts: string[]) => path.join(stateDir, ...parts),
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

  it.each([undefined, "1"])(
    "refuses maintenance under verified Gateway ownership (multi=%s)",
    async (multi) => {
      const fixture = await createLockFixture();
      const gatewayLock = await fixture.gateway({
        env: { ...fixture.env, OPENCLAW_ALLOW_MULTI_GATEWAY: multi },
      });
      const run = vi.fn();
      try {
        const result = fixture.maintain(run);
        await expect(result).rejects.toBeInstanceOf(DoctorSqliteMaintenanceLockUnavailableError);
        await expect(result).rejects.toThrow(/OpenClaw state database is busy/);
        expect(run).not.toHaveBeenCalled();
      } finally {
        await gatewayLock.release();
      }
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

    vi.spyOn(gatewayLockProcessModule, "readGatewayLockProcessCmdline").mockImplementation(() => [
      "openclaw",
      "doctor",
      "--session-sqlite",
      "compact",
    ]);
    await expect(
      fixture.gateway({
        pollIntervalMs: 2,
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
    const sessionsDir = fixture.path("agents", "main", "sessions");
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
    const sessionsDir = fixture.path("agents", "main", "sessions");
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
      const sessionsDir = fixture.path("agents", "main", "agent");
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
    "keeps mutation roots when observations include a narrower root",
    async () => {
      const root = tempDirs.make("openclaw-doctor-observation-root-");
      const physical = path.join(root, "physical");
      const alias = path.join(root, "alias");
      await fs.mkdir(physical);
      await fs.writeFile(path.join(physical, "selected.sqlite"), "selected");
      await fs.writeFile(path.join(physical, "held.sqlite"), "held");
      await fs.symlink(physical, alias, "dir");
      const selected = path.join(alias, "selected.sqlite");
      const held = path.join(alias, "held.sqlite");

      expect(() =>
        assertDoctorSqliteMaintenancePathsNotAliased("session SQLite import", [selected], [root], {
          paths: [held, selected],
          ownershipRoots: [alias, root],
        }),
      ).toThrow(`symbolic-link path component: ${alias}`);
      await expect(fs.readFile(selected, "utf8")).resolves.toBe("selected");
      await expect(fs.readFile(held, "utf8")).resolves.toBe("held");
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses symbolic links in owned path ancestors",
    async () => {
      const fixture = await createLockFixture();
      const agentsDir = fixture.path("agents");
      const realAgentDir = fixture.path("real-main");
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
