import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { readSystemdDefinitionMutationCapability } from "./systemd-definition-mutation.js";
import {
  setupSystemdDefinitionMutationFixture,
  busctl,
  writeFixtureFile,
  root,
  stateDir,
  unitPath,
  environmentPath,
  env,
  artifacts,
  stage,
  managerDefinition,
} from "./systemd-definition-mutation.test-support.js";
import { stageSystemdService } from "./systemd-install.js";

// Install shared mocks before the production imports, regardless of import sorting.
await vi.hoisted(() => import("./systemd-definition-mutation.test-support.js"));

describe.skipIf(process.platform === "win32")("systemd definition mutation ownership", () => {
  setupSystemdDefinitionMutationFixture();

  it.for(["unit"])(
    "publishes a first unit through a %s directory alias discovered by the manager",
    async (alias, { signal, onTestFinished }) => {
      const directory =
        alias === "state"
          ? stateDir
          : alias === "ancestor"
            ? path.dirname(path.dirname(unitPath))
            : path.dirname(unitPath);
      const target = path.join(root, "unit-directory");
      await fs.rename(directory, target);
      await fs.symlink(target, directory);
      managerDefinition(unitPath, [], [], () =>
        fs.access(unitPath).then(
          () => true,
          () => false,
        ),
      );
      await expect(readSystemdDefinitionMutationCapability(env)).resolves.toEqual({
        kind: "writable",
      });
      signal.throwIfAborted();
      const rename = fs.rename.bind(fs);
      let published = false;
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
        if (destination === unitPath) {
          expect(await fs.readFile(environmentPath, "utf8")).toContain("replacement-secret-canary");
          published = true;
        }
        await rename(source, destination);
      });
      onTestFinished(() => renameSpy.mockRestore());
      await expect(stage()).resolves.toMatchObject({ unitPath });
      expect(published).toBe(true);
      await expect(readSystemdDefinitionMutationCapability(env)).resolves.toEqual({
        kind: "writable",
      });
      expect(await fs.readFile(unitPath, "utf8")).toContain("ExecStart=");
      expect(await fs.readdir(path.dirname(unitPath))).toEqual([path.basename(unitPath)]);
      expect(await fs.readdir(stateDir)).toEqual([path.basename(environmentPath)]);
    },
  );

  it.each([
    { artifact: "unit", scenario: "changed alias" },
    { artifact: "environment", scenario: "retargeted alias" },
  ])("protects an aliased $artifact directory with $scenario", async ({ artifact, scenario }) => {
    const file = artifact === "unit" ? unitPath : environmentPath;
    const directory = path.dirname(file);
    const target = path.join(root, "alias-target");
    const replacement = path.join(root, "alias-replacement");
    await fs.rename(directory, target);
    await fs.mkdir(replacement, { mode: 0o755 });
    await fs.symlink(target, directory);
    managerDefinition(unitPath, [], [], () =>
      fs.access(unitPath).then(
        () => true,
        () => false,
      ),
    );
    if (scenario === "root-owned") {
      const stat = fs.stat.bind(fs);
      vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
        const value = await stat(...args);
        if (value && args[0] === directory) {
          Object.defineProperty(value, "uid", { value: typeof value.uid === "bigint" ? 0n : 0 });
        }
        return value;
      });
    } else if (scenario === "unsafe mode") {
      await fs.chmod(target, 0o777);
    } else {
      const writeFile = fs.writeFile.bind(fs);
      let replaced = false;
      vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        await writeFile(...args);
        if (
          !replaced &&
          typeof args[0] === "string" &&
          path.basename(args[0]).startsWith(`${path.basename(file)}.`) &&
          args[0].endsWith(".tmp")
        ) {
          replaced = true;
          // Replacing an alias must reject publication and clean the original directory.
          await fs.rename(directory, `${directory}.previous`);
          await fs.symlink(scenario === "retargeted alias" ? replacement : target, directory);
        }
      });
    }
    if (scenario === "retargeted alias") {
      await expect(stage()).rejects.toThrow();
    } else {
      await expect(stage()).rejects.toThrow(
        scenario === "changed alias" ? "changed during publication" : "SERVICE_DEFINITION_",
      );
    }
    expect(await fs.readdir(target)).toEqual([]);
    expect(await fs.readdir(replacement)).toEqual([]);
    expect(await fs.readdir(stateDir)).toEqual([]);
  });

  it.each(["fragment"])("seals a root-owned manager %s before publication", async (kind) => {
    const extra = path.join(
      root,
      "global-user",
      kind === "fragment" ? "service.d" : "owned.service.d",
      "operator.conf",
    );
    await fs.mkdir(path.dirname(extra), { recursive: true, mode: 0o755 });
    await writeFixtureFile(extra, "[Service]\nEnvironment=TOKEN=operator-secret-canary\n");
    if (kind !== "fragment") {
      await writeFixtureFile(unitPath, "[Service]\nExecStart=/usr/bin/node gateway\n");
    }
    managerDefinition(kind === "fragment" ? extra : unitPath, kind === "fragment" ? [] : [extra]);
    const originalLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await originalLstat(...args);
      if (args[0] === (kind === "parent" ? path.dirname(extra) : extra)) {
        Object.defineProperty(stat, "uid", { value: typeof stat.uid === "bigint" ? 0n : 0 });
      }
      return stat;
    });
    const before = await fs.readFile(extra);
    const entries = await fs.readdir(path.dirname(unitPath));
    const capability = await readSystemdDefinitionMutationCapability(env);
    expect(capability).toMatchObject({ kind: "sealed" });
    expect(JSON.stringify(capability)).not.toContain("secret-canary");
    await expect(stage()).rejects.toThrow("SERVICE_DEFINITION_SEALED");
    expect(await fs.readFile(extra)).toEqual(before);
    expect(await fs.readdir(path.dirname(unitPath))).toEqual(entries);
    expect(await fs.readdir(stateDir)).toEqual([]);
  });

  it("refuses an uninspectable user manager before publication and redacts its diagnostics", async () => {
    busctl.mockRejectedValue(new Error("manager-secret-canary"));
    const capability = await readSystemdDefinitionMutationCapability(env);
    expect(capability).toMatchObject({ kind: "unknown" });
    expect(JSON.stringify(capability)).not.toContain("secret-canary");
    await expect(stage()).rejects.toThrow("SERVICE_DEFINITION_UNKNOWN");
    expect(await fs.readdir(stateDir)).toEqual([]);
    expect(await fs.readdir(path.dirname(unitPath))).toEqual([]);
  });

  it.each(["changed"])(
    "reads root-owned type-wide defaults without write authority (%s)",
    async (scenario) => {
      const changed = scenario === "changed";
      const firstInstall = scenario === "first install";
      const shared = path.join(root, "distribution-user", "service.d", "default.conf");
      await fs.mkdir(path.dirname(shared), { recursive: true, mode: 0o755 });
      await writeFixtureFile(shared, "[Service]\nTimeoutStopSec=30s\n", { mode: 0o644 });
      if (!firstInstall) {
        await writeFixtureFile(unitPath, "[Service]\nExecStart=/usr/bin/node gateway\n");
      }
      await writeFixtureFile(environmentPath, "OPERATOR=unchanged\n");
      managerDefinition(unitPath, [shared], [], async () =>
        firstInstall
          ? fs.stat(unitPath).then(
              () => true,
              () => false,
            )
          : true,
      );
      const lstat = fs.lstat.bind(fs);
      const open = fs.open.bind(fs);
      const readFile = fs.readFile.bind(fs);
      let sharedFd: number | undefined;
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
        const stat = await lstat(...args);
        if (args[0] === shared || args[0] === path.dirname(shared)) {
          Object.defineProperty(stat, "uid", { value: typeof stat.uid === "bigint" ? 0n : 0 });
          Object.defineProperty(stat, "gid", { value: typeof stat.gid === "bigint" ? 0n : 0 });
        }
        return stat;
      });
      vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await open(...args);
        sharedFd = args[0] === shared ? handle.fd : undefined;
        if (args[0] === shared) {
          const stat = handle.stat.bind(handle);
          vi.spyOn(handle, "stat").mockImplementation(async (...statArgs) => {
            const opened = await stat(...statArgs);
            Object.defineProperty(opened, "uid", {
              value: typeof opened.uid === "bigint" ? 0n : 0,
            });
            Object.defineProperty(opened, "gid", {
              value: typeof opened.gid === "bigint" ? 0n : 0,
            });
            return opened;
          });
        }
        return handle;
      });
      vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
        if (typeof args[0] === "string" && args[0].startsWith("/proc/self/fdinfo/")) {
          return `mnt_id:\t${args[0] === `/proc/self/fdinfo/${sharedFd}` ? 2 : 1}\n`;
        }
        if (args[0] === "/proc/self/mountinfo") {
          return `1 0 0:1 / / rw - tmpfs tmpfs rw\n2 1 0:2 / ${shared} ro - tmpfs tmpfs ro\n`;
        }
        return readFile(...args);
      });
      await expect(readSystemdDefinitionMutationCapability(env)).resolves.toEqual({
        kind: "writable",
      });
      if (firstInstall) {
        const rename = fs.rename.bind(fs);
        vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
          await rename(source, destination);
          if (destination === unitPath) {
            expect(await fs.readFile(environmentPath, "utf8")).toContain(
              "replacement-secret-canary",
            );
            // Native LoadUnit reveals type-wide defaults only once the base exists,
            // without daemon-reload between the not-found and loaded observations.
            expect(await fs.readFile(shared, "utf8")).toContain("30s");
          }
        });
      }
      if (changed) {
        const originalUnit = await fs.readFile(unitPath, "utf8");
        const rename = fs.rename.bind(fs);
        let edited = false;
        vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
          await rename(source, destination);
          if (destination === unitPath && !edited) {
            edited = true;
            await writeFixtureFile(shared, "[Service]\nTimeoutStopSec=60s\n");
          }
        });
        await expect(stage()).rejects.toThrow("changed during publication");
        expect(await fs.readFile(unitPath, "utf8")).toBe(originalUnit);
        expect(await fs.readFile(environmentPath, "utf8")).toBe("OPERATOR=unchanged\n");
      } else {
        await stage();
        expect(await fs.readFile(unitPath, "utf8")).toContain("/srv/openclaw/dist/index.js");
        expect(await fs.readFile(environmentPath, "utf8")).toContain("replacement-secret-canary");
      }
      expect(await fs.readFile(shared, "utf8")).toContain(changed ? "60s" : "30s");
    },
  );

  it.each(["file symlink", "world-writable", "uninspectable", "directory"])(
    "rejects a manager definition with %s without publication",
    async (kind) => {
      const directory = path.join(root, "operator");
      const target = path.join(directory, "operator.conf");
      await fs.mkdir(directory, { mode: 0o755 });
      await writeFixtureFile(target, "[Service]\nEnvironment=TOKEN=protected-secret-canary\n");
      let extra = target;
      if (kind === "file symlink") {
        extra = path.join(root, "linked.conf");
        await fs.symlink(target, extra);
      } else if (kind === "world-writable") {
        await fs.chmod(target, 0o606);
      } else if (kind === "directory") {
        extra = stateDir;
      } else {
        const lstat = fs.lstat.bind(fs);
        vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          if (args[0] === extra) {
            throw Object.assign(new Error("inspection-secret-canary"), { code: "EACCES" });
          }
          return lstat(...args);
        });
      }
      managerDefinition(extra);
      const capability = await readSystemdDefinitionMutationCapability(env);
      const reason =
        kind === "file symlink"
          ? "symlink"
          : kind === "world-writable"
            ? "unsafe-permissions"
            : "inspection-failed";
      expect(capability).toMatchObject({ kind: "unknown", reason });
      expect(capability).toMatchObject({ path: extra });
      expect(JSON.stringify(capability)).not.toContain("secret-canary");
      await expect(stage()).rejects.toThrow(`SERVICE_DEFINITION_UNKNOWN: [${reason}]`);
      expect(await fs.readFile(target, "utf8")).toContain("protected-secret-canary");
      expect(await fs.readdir(path.dirname(unitPath))).toEqual([]);
      expect(await fs.readdir(stateDir)).toEqual([]);
    },
  );

  it.each([
    { parent: "unit", select: () => path.dirname(unitPath) },
    { parent: "environment", select: () => stateDir },
  ])("seals a foreign-owned $parent parent before creating service files", async ({ select }) => {
    const protectedParent = select();
    const originalEntries = await fs.readdir(protectedParent);
    const originalLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await originalLstat(...args);
      if (args[0] === protectedParent) {
        Object.defineProperty(stat, "uid", {
          value:
            typeof stat.uid === "bigint"
              ? BigInt((process.geteuid?.() ?? 0) + 1)
              : (process.geteuid?.() ?? 0) + 1,
        });
      }
      return stat;
    });

    await expect(readSystemdDefinitionMutationCapability(env)).resolves.toMatchObject({
      kind: "sealed",
    });
    await expect(stage()).rejects.toThrow("SERVICE_DEFINITION_SEALED");
    expect(await fs.readdir(protectedParent)).toEqual(originalEntries);
  });

  it.each(artifacts)("seals a foreign-owned $artifact before publication", async ({ select }) => {
    await writeFixtureFile(unitPath, "[Service]\nExecStart=/usr/bin/node gateway\n");
    const protectedPath = select();
    if (protectedPath !== unitPath) {
      await writeFixtureFile(protectedPath, "protected-secret-canary\n");
    }
    const original = await fs.readFile(protectedPath);
    const originalLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await originalLstat(...args);
      if (args[0] === protectedPath) {
        Object.defineProperty(stat, "uid", {
          value:
            typeof stat.uid === "bigint"
              ? BigInt((process.geteuid?.() ?? 0) + 1)
              : (process.geteuid?.() ?? 0) + 1,
        });
        Object.defineProperty(stat, "mode", {
          value: typeof stat.mode === "bigint" ? stat.mode | 0o022n : stat.mode | 0o022,
        });
      }
      return stat;
    });

    const capability = await readSystemdDefinitionMutationCapability(env);
    expect(capability).toMatchObject({ kind: "sealed", path: protectedPath });
    expect(JSON.stringify(capability)).not.toContain("secret-canary");
    const staged = stage();
    await expect(staged).rejects.toThrow("SERVICE_DEFINITION_SEALED");
    await expect(staged).rejects.toThrow(JSON.stringify(protectedPath));
    expect(await fs.readFile(protectedPath)).toEqual(original);
  });

  it.each([
    ...artifacts.map(({ artifact, select }) => ({ artifact, select, fresh: false })),
    { artifact: "fresh environment", select: () => environmentPath, fresh: true },
  ])("rejects a symlinked $artifact without changing its target", async ({ select, fresh }) => {
    const file = select();
    if (file !== unitPath && !fresh) {
      await writeFixtureFile(unitPath, "[Service]\n");
    }
    const target = path.join(root, "operator-target");
    await writeFixtureFile(target, "operator-secret-canary\n");
    await fs.symlink(target, file);

    await expect(readSystemdDefinitionMutationCapability(env)).resolves.toEqual({
      kind: "unknown",
      reason: "symlink",
      artifact: "service-file",
      path: file,
    });
    await expect(stage()).rejects.toThrow("SERVICE_DEFINITION_UNKNOWN: [symlink]");
    expect(await fs.readlink(file)).toBe(target);
    expect(await fs.readFile(target, "utf8")).toBe("operator-secret-canary\n");
    if (fresh) {
      await expect(fs.stat(unitPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.each([0o644, 0o664])("regenerates owned unit artifacts with mode %o safely", async (mode) => {
    const previous =
      "[Service]\nExecStart=/usr/bin/node /old/index.js gateway\nTimeoutStopSec=30\nKillMode=control-group\n";
    await writeFixtureFile(unitPath, previous);
    await writeFixtureFile(`${unitPath}.bak`, "older backup\n");
    await fs.chmod(unitPath, mode);
    await fs.chmod(`${unitPath}.bak`, mode);
    await writeFixtureFile(environmentPath, "OPERATOR_SECRET=preserved-canary\n");
    const chmod = vi.spyOn(fs, "chmod");

    await stage();

    expect(await fs.readFile(`${unitPath}.bak`, "utf8")).toBe(previous);
    expect(await fs.readFile(unitPath, "utf8")).toContain("/srv/openclaw/dist/index.js");
    expect(await fs.readFile(unitPath, "utf8")).not.toContain("replacement-secret-canary");
    expect(await fs.readFile(unitPath, "utf8")).toContain("TimeoutStopSec=330");
    expect(await fs.readFile(unitPath, "utf8")).toContain("KillMode=mixed");
    expect((await fs.stat(unitPath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(`${unitPath}.bak`)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(environmentPath, "utf8")).toContain(
      "OPERATOR_SECRET=preserved-canary",
    );
    expect(chmod).not.toHaveBeenCalled();
    expect(
      (await fs.readdir(path.dirname(unitPath))).filter((file) => file.includes(".tmp")),
    ).toEqual([]);
  });

  it("refuses an unsafe directory even when its unit mode is repairable", async () => {
    const previous = "[Service]\nExecStart=/usr/bin/node /old/index.js gateway\n";
    await writeFixtureFile(unitPath, previous);
    await fs.chmod(unitPath, 0o664);
    await fs.chmod(path.dirname(unitPath), 0o775);

    await expect(stage()).rejects.toThrow("SERVICE_DEFINITION_UNKNOWN: [unsafe-permissions]");
    expect(await fs.readFile(unitPath, "utf8")).toBe(previous);
    expect((await fs.stat(unitPath)).mode & 0o777).toBe(0o664);
    expect(await fs.readdir(path.dirname(unitPath))).toEqual([path.basename(unitPath)]);
  });

  it.each([0o775, 0o777])(
    "repairs an owned writable state directory (%o) before publication",
    async (mode) => {
      await writeFixtureFile(path.join(stateDir, "operator-data"), "preserved\n");
      await fs.chmod(stateDir, mode);

      expect(await readSystemdDefinitionMutationCapability(env)).toEqual({ kind: "writable" });
      expect((await fs.stat(stateDir)).mode & 0o777).toBe(mode);
      await stage();

      expect((await fs.stat(stateDir)).mode & 0o777).toBe(0o700);
      expect(await fs.readFile(path.join(stateDir, "operator-data"), "utf8")).toBe("preserved\n");
      expect(await fs.readFile(unitPath, "utf8")).toContain("ExecStart=");
      expect(await fs.readFile(environmentPath, "utf8")).toContain("replacement-secret-canary");
    },
  );

  it("does not publish service credentials if state directory repair fails", async () => {
    await fs.chmod(stateDir, 0o775);
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === stateDir) {
        vi.spyOn(handle, "chmod").mockRejectedValue(new Error("state directory chmod denied"));
      }
      return handle;
    });

    await expect(stage()).rejects.toThrow("state directory chmod denied");
    for (const directory of [stateDir, path.dirname(unitPath)]) {
      expect(await fs.readdir(directory)).toEqual([]);
    }
    expect((await fs.stat(stateDir)).mode & 0o777).toBe(0o775);
  });

  it("publishes only the environment selected by the effective service state dir", async () => {
    const effectiveStateDir = path.join(root, "effective-state");
    const effectiveEnvironmentPath = path.join(effectiveStateDir, "gateway.systemd.env");
    await fs.mkdir(effectiveStateDir, { mode: 0o700 });
    await writeFixtureFile(environmentPath, "CALLER_SECRET=caller-canary\n");
    await writeFixtureFile(effectiveEnvironmentPath, "OPERATOR_SECRET=preserved-canary\n");

    await stage({ OPENCLAW_STATE_DIR: effectiveStateDir });

    expect(await fs.readFile(environmentPath, "utf8")).toBe("CALLER_SECRET=caller-canary\n");
    expect(await fs.readFile(effectiveEnvironmentPath, "utf8")).toContain(
      "OPERATOR_SECRET=preserved-canary",
    );
    expect(await fs.readFile(effectiveEnvironmentPath, "utf8")).toContain(
      "OPENCLAW_GATEWAY_TOKEN=replacement-secret-canary",
    );
    expect(await fs.readFile(unitPath, "utf8")).toContain(effectiveEnvironmentPath);
  });

  it("keeps a retired generated environment file readable until the unit drops it", async () => {
    await writeFixtureFile(
      unitPath,
      `[Service]\nExecStart=/usr/bin/node gateway\nEnvironmentFile=${environmentPath}\n`,
    );
    await writeFixtureFile(environmentPath, "OPENCLAW_GATEWAY_TOKEN=retired-secret-canary\n");
    managerDefinition(unitPath, [], [[environmentPath, false]]);

    await stageSystemdService({
      env,
      stdout: new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      programArguments: ["/usr/bin/node", "/srv/openclaw/dist/index.js", "gateway"],
      environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      environmentValueSources: { OPENCLAW_GATEWAY_TOKEN: "file" },
    });

    expect(await fs.readFile(environmentPath, "utf8")).toBe("");
    expect(await fs.readFile(unitPath, "utf8")).not.toContain("EnvironmentFile=");
  });
});
