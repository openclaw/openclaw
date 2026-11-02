import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { createConfigIO } from "./io.factory.js";

describe("config writes through a symlinked state root", () => {
  const roots = createSuiteTempRootTracker({ prefix: "openclaw-config-symlink-" });
  beforeAll(() => roots.setup());
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
  });
  afterAll(() => roots.cleanup());

  async function fixture(symlinkedState = true) {
    const home = await roots.make();
    const target = path.join(home, "real-state");
    const stateDir = symlinkedState ? path.join(home, "state-link") : target;
    await fs.mkdir(target);
    if (symlinkedState) {
      await fs.symlink(target, stateDir, "junction");
    }
    const configPath = path.join(stateDir, "openclaw.json");
    const physicalPath = path.join(await fs.realpath(target), "openclaw.json");
    const raw = JSON.stringify({ gateway: { mode: "local", port: 18789 } });
    await fs.writeFile(configPath, raw);
    const env: NodeJS.ProcessEnv = { HOME: home, NODE_ENV: "test", OPENCLAW_STATE_DIR: stateDir };
    const io = createConfigIO({
      env,
      homedir: () => home,
      logger: { warn: vi.fn(), error: vi.fn() },
    });
    return { io, env, home, stateDir, target, configPath, physicalPath, raw };
  }

  it("creates a missing state directory through the public writer", async () => {
    const home = await roots.make();
    const stateDir = path.join(home, "fresh", "state");
    const io = createConfigIO({
      env: { HOME: home, NODE_ENV: "test", OPENCLAW_STATE_DIR: stateDir },
      homedir: () => home,
      logger: { warn: vi.fn(), error: vi.fn() },
    });

    await expect(fs.stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
    await io.writeConfigFile({ gateway: { mode: "local", port: 19001 } });

    expect(JSON.parse(await fs.readFile(io.configPath, "utf8")).gateway.port).toBe(19001);
  });

  it.skipIf(process.platform === "win32")(
    "reads a config-file alias and its includes without allowing publication through it",
    async () => {
      const { io, home, env, configPath } = await fixture();
      const sourcePath = path.join(home, "external.json");
      const includePath = path.join(home, "gateway.json");
      const raw = JSON.stringify({ $include: includePath });
      env.OPENCLAW_INCLUDE_ROOTS = home;
      await fs.writeFile(includePath, JSON.stringify({ gateway: { mode: "local", port: 19001 } }));
      await fs.unlink(configPath);
      await fs.writeFile(sourcePath, raw);
      await fs.symlink(sourcePath, configPath);

      const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();

      expect(snapshot.path).toBe(configPath);
      expect(snapshot.valid).toBe(true);
      expect(snapshot.config.gateway?.port).toBe(19001);
      expect(writeOptions.includeFileTargetsForWrite?.[includePath]).toBe(
        await fs.realpath(includePath),
      );
      await expect(
        io.writeConfigFile(
          { gateway: { mode: "local", port: 19002 } },
          { ...writeOptions, baseSnapshot: snapshot },
        ),
      ).rejects.toMatchObject({ name: "ConfigMutationConflictError" });
      expect(await fs.readlink(configPath)).toBe(sourcePath);
      expect(await fs.readFile(sourcePath, "utf8")).toBe(raw);
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a config-file alias retarget after reading identical bytes",
    async () => {
      const { io, home, configPath, raw } = await fixture();
      const sourcePath = path.join(home, "external.json");
      const alternatePath = path.join(home, "alternate.json");
      await fs.rename(configPath, sourcePath);
      await fs.symlink(sourcePath, configPath);
      const { writeOptions } = await io.readConfigFileSnapshotForWrite();
      await fs.writeFile(alternatePath, raw);
      await fs.unlink(configPath);
      await fs.symlink(alternatePath, configPath);

      expect(() => writeOptions.assertConfigPathForWrite?.()).toThrow(
        "included config target changed since last load",
      );
    },
  );

  it.each([true, false])(
    "rejects an alias retarget between snapshot read and write even when bytes match (initial link: %s)",
    async (symlinkedState) => {
      const { io, home, stateDir, physicalPath, raw } = await fixture(symlinkedState);
      const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
      const alternate = path.join(home, "alternate");
      await fs.mkdir(alternate);
      const alternatePath = path.join(alternate, "openclaw.json");
      await fs.writeFile(alternatePath, raw);
      let originalPath = physicalPath;
      if (symlinkedState) {
        await fs.unlink(stateDir);
      } else {
        const moved = path.join(home, "original-state");
        await fs.rename(stateDir, moved);
        originalPath = path.join(moved, "openclaw.json");
      }
      await fs.symlink(alternate, stateDir, "junction");

      await expect(
        io.writeConfigFile(
          { gateway: { mode: "local", port: 19001 } },
          { ...writeOptions, baseSnapshot: snapshot },
        ),
      ).rejects.toMatchObject({ name: "ConfigMutationConflictError" });

      expect(await fs.readFile(originalPath, "utf8")).toBe(raw);
      expect(await fs.readFile(alternatePath, "utf8")).toBe(raw);
      expect(await fs.readdir(alternate)).toEqual(["openclaw.json"]);
    },
  );

  it("preserves the symlink, logical config identity, and rotating backups", async () => {
    const { io, stateDir, configPath, physicalPath, raw } = await fixture();
    const originalLink = await fs.readlink(stateDir);
    if (process.platform !== "win32") {
      await fs.chmod(stateDir, 0o750);
    }

    expect(io.configPath).toBe(configPath);
    await io.writeConfigFile({ gateway: { mode: "local", port: 19001 } });
    const firstWrite = await fs.readFile(physicalPath, "utf8");
    expect(JSON.parse(firstWrite).gateway.port).toBe(19001);
    expect(await fs.readFile(`${physicalPath}.bak`, "utf8")).toBe(raw);

    await io.writeConfigFile({ gateway: { mode: "local", port: 19002 } });

    expect(await fs.readlink(stateDir)).toBe(originalLink);
    if (process.platform !== "win32") {
      expect((await fs.stat(stateDir)).mode & 0o777).toBe(0o750);
    }
    expect(await fs.readFile(`${physicalPath}.bak`, "utf8")).toBe(firstWrite);
    expect(await fs.readFile(`${physicalPath}.bak.1`, "utf8")).toBe(raw);
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.path).toBe(configPath);
    expect(snapshot.config.gateway?.port).toBe(19002);
  });

  it.each(["prefix", "last-known-good"] as const)(
    "recovers a broken config through the symlinked state root (%s)",
    async (recovery) => {
      const { io, stateDir, physicalPath, raw } = await fixture();
      const originalLink = await fs.readlink(stateDir);
      if (process.platform !== "win32") {
        await fs.chmod(stateDir, 0o750);
      }
      if (recovery === "prefix") {
        await fs.writeFile(physicalPath, `shell profile noise\n${raw}`);
      } else {
        await expect(
          io.promoteConfigSnapshotToLastKnownGood(await io.readConfigFileSnapshot()),
        ).resolves.toBe(true);
        await fs.writeFile(physicalPath, "{ gateway: { mode: 123 } }\n");
      }
      const snapshot = await io.readConfigFileSnapshot();
      expect(snapshot.valid).toBe(false);

      await expect(
        recovery === "prefix"
          ? io.recoverConfigFromJsonRootSuffix(snapshot)
          : io.recoverConfigFromLastKnownGood({ snapshot, reason: "invalid-config" }),
      ).resolves.toBe(true);

      expect(await fs.readFile(physicalPath, "utf8")).toBe(raw);
      expect(await fs.readlink(stateDir)).toBe(originalLink);
      if (process.platform !== "win32") {
        expect((await fs.stat(stateDir)).mode & 0o777).toBe(0o750);
      }
    },
  );

  it.each(["unrelated", "physical"] as const)(
    "refuses prefix recovery from a snapshot of a %s config path",
    async (source) => {
      const { io, env, home, physicalPath, raw } = await fixture();
      const broken = `shell profile noise\n${raw}`;
      await fs.writeFile(physicalPath, broken);
      const snapshotPath = source === "physical" ? physicalPath : path.join(home, "other.json");
      if (source === "unrelated") {
        await fs.writeFile(snapshotPath, broken);
      }
      const snapshot = await createConfigIO({
        configPath: snapshotPath,
        env,
        homedir: () => home,
        observe: false,
      }).readConfigFileSnapshot();

      await expect(io.recoverConfigFromJsonRootSuffix(snapshot)).rejects.toMatchObject({
        name: "ConfigMutationConflictError",
      });
      expect(await fs.readFile(physicalPath, "utf8")).toBe(broken);
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses prefix recovery through a config-file symlink and names the fix",
    async () => {
      const { io, home, configPath, raw } = await fixture(false);
      const sourcePath = path.join(home, "external.json");
      const broken = `shell profile noise\n${raw}`;
      await fs.unlink(configPath);
      await fs.writeFile(sourcePath, broken);
      await fs.symlink(sourcePath, configPath);
      const snapshot = await io.readConfigFileSnapshot();

      await expect(io.recoverConfigFromJsonRootSuffix(snapshot)).rejects.toThrow(
        "is a symlink. Point OPENCLAW_CONFIG_PATH at the real file",
      );
      expect(await fs.readlink(configPath)).toBe(sourcePath);
      expect(await fs.readFile(sourcePath, "utf8")).toBe(broken);
    },
  );

  it("refuses synchronous backup recovery if the state root changes during staging", async () => {
    const { env, home, stateDir, physicalPath, raw } = await fixture();
    const broken = '{"update":{"channel":"beta"}}\n';
    const alternate = path.join(home, "alternate");
    const alternatePath = path.join(alternate, "openclaw.json");
    await fs.mkdir(alternate);
    await fs.writeFile(alternatePath, broken);
    await fs.writeFile(physicalPath, broken);
    await fs.writeFile(`${physicalPath}.bak`, raw);
    const warn = vi.fn();
    let retargeted = false;
    const io = createConfigIO({
      env,
      homedir: () => home,
      logger: { warn, error: vi.fn() },
      fs: {
        ...fsNode,
        openSync(...args: Parameters<typeof fsNode.openSync>) {
          const fd = fsNode.openSync(...args);
          if (!retargeted && args[1] === "wx") {
            retargeted = true;
            fsNode.unlinkSync(stateDir);
            fsNode.symlinkSync(alternate, stateDir, "junction");
          }
          return fd;
        },
      },
    });

    io.loadConfig();

    expect(retargeted).toBe(true);
    expect(await fs.readFile(physicalPath, "utf8")).toBe(broken);
    expect(await fs.readFile(alternatePath, "utf8")).toBe(broken);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("auto-restore from backup failed"));
  });

  it.each(["preflight", "beforeCommit"] as const)(
    "refuses a state-root retarget during %s without changing either config",
    async (phase) => {
      const { io, home, stateDir, physicalPath, raw } = await fixture();
      const alternate = path.join(home, "alternate");
      await fs.mkdir(alternate);
      const alternatePath = path.join(alternate, "openclaw.json");
      await fs.writeFile(alternatePath, raw);
      const retarget = async () => {
        await fs.unlink(stateDir);
        await fs.symlink(alternate, stateDir, "junction");
      };

      await expect(
        io.writeConfigFile(
          { gateway: { mode: "local", port: 19001 } },
          phase === "preflight"
            ? { preCommitRuntimePreflight: retarget }
            : { beforeCommit: retarget },
        ),
      ).rejects.toMatchObject({ name: "ConfigMutationConflictError" });

      expect(await fs.readFile(physicalPath, "utf8")).toBe(raw);
      expect(await fs.readFile(alternatePath, "utf8")).toBe(raw);
      expect(await fs.readdir(alternate)).toEqual(["openclaw.json"]);
      await expect(fs.stat(`${physicalPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["selection", "root"] as const)(
    "keeps rollback bound to the original path after a post-commit %s change",
    async (change) => {
      const { io, env, home, stateDir, configPath, physicalPath, raw } = await fixture();
      const originalLink = await fs.readlink(stateDir);
      const alternate = path.join(home, "alternate");
      await fs.mkdir(alternate);
      const alternatePath = path.join(alternate, "openclaw.json");
      await fs.writeFile(alternatePath, raw);
      const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
      let committed = false;
      const rename = fsNode.renameSync;
      vi.spyOn(fsNode, "renameSync").mockImplementation((source, destination) => {
        rename(source, destination);
        if (destination === physicalPath && !committed) {
          committed = true;
          if (change === "selection") {
            env.OPENCLAW_CONFIG_PATH = alternatePath;
          } else {
            fsNode.unlinkSync(stateDir);
            fsNode.symlinkSync(alternate, stateDir, "junction");
          }
        }
      });

      await expect(
        io.writeConfigFile(
          { gateway: { mode: "local", port: 19001 } },
          { ...writeOptions, baseSnapshot: snapshot },
        ),
      ).rejects.toMatchObject({
        name: "ConfigWritePostCommitError",
        configPath,
        rollbackStatus: change === "selection" ? "restored" : "unknown",
      });

      expect(committed).toBe(true);
      if (change === "selection") {
        expect(await fs.readFile(physicalPath, "utf8")).toBe(raw);
        expect(await fs.readlink(stateDir)).toBe(originalLink);
      } else {
        expect(JSON.parse(await fs.readFile(physicalPath, "utf8")).gateway.port).toBe(19001);
        expect(await fs.realpath(stateDir)).toBe(await fs.realpath(alternate));
      }
      expect(await fs.readFile(`${physicalPath}.bak`, "utf8")).toBe(raw);
      expect(await fs.readFile(alternatePath, "utf8")).toBe(raw);
      expect(await fs.readdir(alternate)).toEqual(["openclaw.json"]);
    },
  );
});
