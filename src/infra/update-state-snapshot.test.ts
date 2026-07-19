import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "./update-global.js";
import { createUpdateStateSnapshot, restoreUpdateStateSnapshot } from "./update-state-snapshot.js";

const roots: string[] = [];
const SQLITE_HEADER = "SQLite format 3\0";

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-snapshot-test-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const retainedPackageRoot = path.join(root, "retained", "package");
  const currentPackageRoot = path.join(root, "live", "package");
  await fs.mkdir(path.join(stateDir, "agents", "main"), { recursive: true });
  await fs.mkdir(retainedPackageRoot, { recursive: true });
  await fs.mkdir(currentPackageRoot, { recursive: true });
  await fs.writeFile(configPath, '{"before":true}\n');
  await fs.writeFile(path.join(stateDir, "openclaw.sqlite"), `${SQLITE_HEADER}state-db`);
  await fs.writeFile(
    path.join(stateDir, "agents", "main", "agent.sqlite"),
    `${SQLITE_HEADER}agent-db`,
  );
  return { root, stateDir, configPath, retainedPackageRoot, currentPackageRoot };
}

function cloneRunner(): CommandRunner {
  return async (argv) => {
    await fs.cp(argv.at(-2)!, argv.at(-1)!, { recursive: true });
    return { stdout: "", stderr: "", code: 0 };
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("update state snapshot", () => {
  it("fails closed when config existence cannot be inspected", async () => {
    const fixture = await setup();
    const denied = Object.assign(new Error("config stat denied"), { code: "EACCES" });
    vi.spyOn(fs, "stat").mockRejectedValueOnce(denied);

    await expect(
      createUpdateStateSnapshot({
        ...fixture,
        timeoutMs: 1_000,
        platform: "linux",
        runCommand: cloneRunner(),
      }),
    ).rejects.toBe(denied);
  });

  it("uses APFS clone strategy on Darwin when cp -c succeeds", async () => {
    const fixture = await setup();
    const runCommand = vi.fn(cloneRunner());
    const snapshot = await createUpdateStateSnapshot({
      ...fixture,
      timeoutMs: 1_000,
      platform: "darwin",
      runCommand,
    });
    expect(snapshot.strategy).toBe("apfs-clone");
    expect(runCommand.mock.calls[0]?.[0].slice(0, 2)).toEqual(["/bin/cp", "-cR"]);
  });

  it("uses required reflink strategy on non-Darwin when supported", async () => {
    const fixture = await setup();
    let stagedDatabaseInode: bigint | undefined;
    const runCommand = vi.fn<CommandRunner>(async (argv) => {
      await fs.cp(argv.at(-2)!, argv.at(-1)!, { recursive: true });
      stagedDatabaseInode = (
        await fs.stat(path.join(argv.at(-1)!, "openclaw.sqlite"), {
          bigint: true,
        })
      ).ino;
      return { stdout: "", stderr: "", code: 0 };
    });
    const snapshot = await createUpdateStateSnapshot({
      ...fixture,
      timeoutMs: 1_000,
      platform: "linux",
      runCommand,
    });
    expect(snapshot.strategy).toBe("reflink");
    expect(runCommand.mock.calls[0]?.[0].slice(0, 3)).toEqual(["cp", "--reflink=always", "-a"]);
    expect(
      (await fs.stat(path.join(snapshot.root, "state", "openclaw.sqlite"), { bigint: true })).ino,
    ).toBe(stagedDatabaseInode);
  });

  it("falls back to per-database VACUUM snapshots and restores them", async () => {
    const fixture = await setup();
    await fs.mkdir(path.join(fixture.stateDir, "cache.db"));
    await fs.writeFile(path.join(fixture.stateDir, "cache.db", "metadata.json"), "preserved");
    await fs.symlink("openclaw.json", path.join(fixture.stateDir, "current-config"));
    await fs.writeFile(path.join(fixture.stateDir, "openclaw.sqlite-journal"), "hot-journal");
    await fs.writeFile(path.join(fixture.stateDir, "openclaw.sqlite-mjABCD"), "super-journal");
    await fs.writeFile(path.join(fixture.stateDir, "plugin.db"), "not-sqlite");
    await fs.writeFile(path.join(fixture.stateDir, "plugin.db-wal"), "not-a-sidecar");
    await fs.chmod(path.join(fixture.stateDir, "agents"), 0o755);
    const vacuumDatabase = vi.fn(async (source: string, target: string) => {
      await fs.copyFile(source, target);
    });
    const snapshot = await createUpdateStateSnapshot({
      ...fixture,
      timeoutMs: 1_000,
      platform: "linux",
      runCommand: async () => ({ stdout: "", stderr: "unsupported", code: 1 }),
      vacuumDatabase,
    });
    expect(snapshot.strategy).toBe("sqlite-vacuum");
    expect(snapshot.databases).toEqual(["agents/main/agent.sqlite", "openclaw.sqlite"]);
    expect(vacuumDatabase).toHaveBeenCalledTimes(2);
    expect(
      await fs.readFile(path.join(snapshot.root, "state", "cache.db", "metadata.json"), "utf8"),
    ).toBe("preserved");
    expect(await fs.readlink(path.join(snapshot.root, "state", "current-config"))).toBe(
      "openclaw.json",
    );
    await expect(
      fs.stat(path.join(snapshot.root, "state", "openclaw.sqlite-journal")),
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(snapshot.root, "state", "openclaw.sqlite-mjABCD")),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(snapshot.root, "state", "plugin.db"), "utf8")).toBe(
      "not-sqlite",
    );
    expect(await fs.readFile(path.join(snapshot.root, "state", "plugin.db-wal"), "utf8")).toBe(
      "not-a-sidecar",
    );

    await fs.writeFile(path.join(fixture.stateDir, "openclaw.sqlite"), "migrated-db");
    await fs.writeFile(fixture.configPath, '{"after":true}\n');
    await fs.writeFile(path.join(fixture.stateDir, "candidate-created.sqlite"), "new-db");
    await fs.writeFile(path.join(fixture.stateDir, "candidate-created.json"), "new-state");
    await fs.chmod(path.join(fixture.stateDir, "agents"), 0o777);
    await restoreUpdateStateSnapshot(snapshot);
    expect(await fs.readFile(path.join(fixture.stateDir, "openclaw.sqlite"), "utf8")).toBe(
      `${SQLITE_HEADER}state-db`,
    );
    expect(await fs.readFile(path.join(fixture.stateDir, "plugin.db"), "utf8")).toBe("not-sqlite");
    expect(await fs.readFile(path.join(fixture.stateDir, "plugin.db-wal"), "utf8")).toBe(
      "not-a-sidecar",
    );
    expect(await fs.readFile(fixture.configPath, "utf8")).toBe('{"before":true}\n');
    expect(await fs.readlink(path.join(fixture.stateDir, "current-config"))).toBe("openclaw.json");
    await expect(
      fs.stat(path.join(fixture.stateDir, "candidate-created.sqlite")),
    ).rejects.toThrow();
    await expect(fs.stat(path.join(fixture.stateDir, "candidate-created.json"))).rejects.toThrow();
    expect((await fs.stat(path.join(fixture.stateDir, "agents"))).mode & 0o777).toBe(0o755);
  });

  it("resolves a symlinked state root before cloning", async () => {
    const fixture = await setup();
    const stateLink = path.join(fixture.root, "state-link");
    await fs.symlink(fixture.stateDir, stateLink, "dir");
    const snapshot = await createUpdateStateSnapshot({
      ...fixture,
      stateDir: stateLink,
      timeoutMs: 1_000,
      platform: "linux",
      runCommand: cloneRunner(),
    });
    expect(snapshot.stateDir).toBe(await fs.realpath(fixture.stateDir));
    expect((await fs.lstat(path.join(snapshot.root, "state"))).isSymbolicLink()).toBe(false);
  });

  it("restores a symlinked config through its canonical target", async () => {
    const fixture = await setup();
    const configTarget = path.join(fixture.root, "managed-config.json");
    await fs.rm(fixture.configPath);
    await fs.writeFile(configTarget, '{"before":true}\n');
    await fs.symlink(configTarget, fixture.configPath);
    const snapshot = await createUpdateStateSnapshot({
      ...fixture,
      timeoutMs: 1_000,
      platform: "linux",
      runCommand: cloneRunner(),
    });

    await fs.writeFile(configTarget, '{"after":true}\n');
    await fs.rm(configTarget);
    await fs.mkdir(configTarget);
    await restoreUpdateStateSnapshot(snapshot);
    expect((await fs.lstat(fixture.configPath)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(fixture.configPath)).toBe(configTarget);
    expect(await fs.readFile(configTarget, "utf8")).toBe('{"before":true}\n');
  });

  it("restores an external configured symlink and its target", async () => {
    const fixture = await setup();
    const requestedConfigPath = path.join(fixture.root, "configured", "openclaw.json");
    const configTarget = path.join(fixture.root, "managed", "openclaw.json");
    await fs.mkdir(path.dirname(requestedConfigPath), { recursive: true });
    await fs.mkdir(path.dirname(configTarget), { recursive: true });
    await fs.writeFile(configTarget, '{"before":true}\n');
    await fs.symlink(
      path.relative(path.dirname(requestedConfigPath), configTarget),
      requestedConfigPath,
    );
    const snapshot = await createUpdateStateSnapshot({
      ...fixture,
      configPath: requestedConfigPath,
      timeoutMs: 1_000,
      platform: "linux",
      runCommand: cloneRunner(),
    });

    await fs.rm(requestedConfigPath);
    await fs.writeFile(requestedConfigPath, '{"candidate":true}\n');
    await fs.writeFile(configTarget, '{"after":true}\n');
    await restoreUpdateStateSnapshot(snapshot);

    expect((await fs.lstat(requestedConfigPath)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(requestedConfigPath)).toBe(
      path.relative(path.dirname(requestedConfigPath), configTarget),
    );
    expect(await fs.readFile(configTarget, "utf8")).toBe('{"before":true}\n');
  });

  it("removes an external config that was absent at snapshot time", async () => {
    const fixture = await setup();
    const externalConfig = path.join(fixture.root, "external", "openclaw.json");
    const snapshot = await createUpdateStateSnapshot({
      ...fixture,
      configPath: externalConfig,
      timeoutMs: 1_000,
      platform: "linux",
      runCommand: cloneRunner(),
    });
    expect(snapshot.configDisposition).toBe("external-absent");

    await fs.mkdir(externalConfig, { recursive: true });
    await restoreUpdateStateSnapshot(snapshot);
    await expect(fs.stat(externalConfig)).rejects.toThrow();
  });

  it("rejects state symlinks whose mutable target is outside the snapshot", async () => {
    const fixture = await setup();
    const external = path.join(fixture.root, "external-agent-state");
    await fs.mkdir(external);
    await fs.symlink(external, path.join(fixture.stateDir, "external-state"));

    await expect(
      createUpdateStateSnapshot({
        ...fixture,
        timeoutMs: 1_000,
        platform: "linux",
        runCommand: cloneRunner(),
      }),
    ).rejects.toThrow("state symlink escapes rollback snapshot");
  });

  it("rejects state symlinks into the excluded managed install tree", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-snapshot-excluded-link-"));
    roots.push(root);
    const stateDir = path.join(root, ".openclaw");
    const installOwner = path.join(stateDir, "tools", "node", "lib");
    const retainedPackageRoot = path.join(installOwner, ".openclaw-previous");
    const currentPackageRoot = path.join(installOwner, "node_modules", "openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(retainedPackageRoot, { recursive: true });
    await fs.mkdir(currentPackageRoot, { recursive: true });
    await fs.writeFile(configPath, "{}\n");
    await fs.symlink(currentPackageRoot, path.join(stateDir, "candidate-state"));

    await expect(
      createUpdateStateSnapshot({
        stateDir,
        configPath,
        retainedPackageRoot,
        currentPackageRoot,
        timeoutMs: 1_000,
        platform: "linux",
        runCommand: cloneRunner(),
      }),
    ).rejects.toThrow("state symlink escapes rollback snapshot");
  });

  it("rejects state nested inside the package swap root", async () => {
    const fixture = await setup();
    const nestedStateDir = path.join(fixture.currentPackageRoot, "state");
    await fs.mkdir(nestedStateDir);

    await expect(
      createUpdateStateSnapshot({
        ...fixture,
        stateDir: nestedStateDir,
        configPath: path.join(nestedStateDir, "openclaw.json"),
        timeoutMs: 1_000,
        platform: "linux",
        runCommand: cloneRunner(),
      }),
    ).rejects.toThrow("state directory cannot be inside the managed package root");
  });

  it("stages outside state and preserves an install tree nested in the managed state prefix", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-managed-state-snapshot-"));
    roots.push(root);
    const stateDir = path.join(root, ".openclaw");
    const installOwner = path.join(stateDir, "tools", "node", "lib");
    const retainedPackageRoot = path.join(installOwner, ".openclaw-previous");
    const currentPackageRoot = path.join(installOwner, "node_modules", "openclaw");
    const configPath = path.join(stateDir, "openclaw.json");
    await fs.mkdir(retainedPackageRoot, { recursive: true });
    await fs.mkdir(currentPackageRoot, { recursive: true });
    await fs.writeFile(configPath, '{"before":true}\n');
    await fs.writeFile(path.join(retainedPackageRoot, "version.txt"), "retained\n");

    const snapshot = await createUpdateStateSnapshot({
      stateDir,
      configPath,
      retainedPackageRoot,
      currentPackageRoot,
      timeoutMs: 1_000,
      platform: "darwin",
      runCommand: cloneRunner(),
    });
    expect(snapshot.root.startsWith(await fs.realpath(installOwner))).toBe(true);
    expect(snapshot.excludedStatePaths).toEqual(["tools/node/lib"]);
    await expect(fs.access(path.join(snapshot.root, "state"))).resolves.toBeUndefined();
    await expect(
      fs.stat(path.join(snapshot.root, "state", "tools", "node", "lib")),
    ).rejects.toThrow();

    await fs.writeFile(configPath, '{"after":true}\n');
    await restoreUpdateStateSnapshot(snapshot);
    expect(await fs.readFile(configPath, "utf8")).toBe('{"before":true}\n');
    expect(await fs.readFile(path.join(retainedPackageRoot, "version.txt"), "utf8")).toBe(
      "retained\n",
    );
    await expect(fs.access(path.join(snapshot.root, "state"))).resolves.toBeUndefined();
    expect(await fs.readFile(path.join(snapshot.root, "state", "openclaw.json"), "utf8")).toBe(
      '{"before":true}\n',
    );
    await expect(
      fs.access(path.join(snapshot.root, "update-state-snapshot.json")),
    ).resolves.toBeUndefined();
  });

  it("snapshots config separately when it lives inside the excluded install tree", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-managed-config-snapshot-"));
    roots.push(root);
    const stateDir = path.join(root, ".openclaw");
    const installOwner = path.join(stateDir, "tools", "node", "lib");
    const retainedPackageRoot = path.join(installOwner, ".openclaw-previous");
    const currentPackageRoot = path.join(installOwner, "node_modules", "openclaw");
    const configPath = path.join(installOwner, "managed-config", "openclaw.json");
    await fs.mkdir(retainedPackageRoot, { recursive: true });
    await fs.mkdir(currentPackageRoot, { recursive: true });
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, '{"before":true}\n');

    const snapshot = await createUpdateStateSnapshot({
      stateDir,
      configPath,
      retainedPackageRoot,
      currentPackageRoot,
      timeoutMs: 1_000,
      platform: "darwin",
      runCommand: cloneRunner(),
    });
    expect(snapshot.configDisposition).toBe("external-present");
    expect(snapshot.configSnapshot).toBe("config/openclaw.json");

    await fs.writeFile(configPath, '{"after":true}\n');
    await restoreUpdateStateSnapshot(snapshot);
    expect(await fs.readFile(configPath, "utf8")).toBe('{"before":true}\n');
  });
});
