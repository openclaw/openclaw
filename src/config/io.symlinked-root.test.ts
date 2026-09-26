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

    expect(io.configPath).toBe(configPath);
    await io.writeConfigFile({ gateway: { mode: "local", port: 19001 } });
    const firstWrite = await fs.readFile(physicalPath, "utf8");
    expect(JSON.parse(firstWrite).gateway.port).toBe(19001);
    expect(await fs.readFile(`${physicalPath}.bak`, "utf8")).toBe(raw);

    await io.writeConfigFile({ gateway: { mode: "local", port: 19002 } });

    expect(await fs.readlink(stateDir)).toBe(originalLink);
    expect(await fs.readFile(`${physicalPath}.bak`, "utf8")).toBe(firstWrite);
    expect(await fs.readFile(`${physicalPath}.bak.1`, "utf8")).toBe(raw);
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.path).toBe(configPath);
    expect(snapshot.config.gateway?.port).toBe(19002);
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
