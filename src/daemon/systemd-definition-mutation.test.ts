import "../test-utils/prepare-compiled-subprocesses.js";
import type { BigIntStats, Stats } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { execFileUtf8 } from "./exec-file.js";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput,
} from "./service.test-helpers.js";
import * as systemdExec from "./systemd-exec.js";
import {
  expectFiles,
  legacyGatewayUnit,
  writeUnit as writeFixtureFile,
} from "./systemd-files.test-support.js";
import { systemdManagerVersionProbe } from "./systemd-user-bus.test-support.js";

const assertNoSystemOwnership = vi.hoisted(() =>
  vi.fn<typeof import("./systemd-system.js").assertNoSystemSystemdOwnership>(),
);
const busctl = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execBusctlUser>());

vi.mock("./exec-file.js", () => ({ execFileUtf8: vi.fn() }));
vi.mock("./systemd-system.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-system.js")>()),
  assertNoSystemSystemdOwnership: assertNoSystemOwnership,
}));
vi.mock("./systemd-exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./systemd-exec.js")>()),
  assertSystemdAvailable: async () => {},
  execBusctlUser: busctl,
  execSystemctlUser: async () => ({ code: 0, termination: "exit", stdout: "", stderr: "" }),
}));

import {
  readSystemdDefinitionMutationCapability,
  withSystemdDefinitionMutation,
} from "./systemd-definition-mutation.js";
import { refreshLegacySystemdServiceMetadata, stageSystemdService } from "./systemd-install.js";
import { readSystemdServiceExecStart } from "./systemd-service-files.js";

describe.skipIf(process.platform === "win32")("systemd definition mutation ownership", () => {
  let root: string;
  let stateDir: string;
  let unitPath: string;
  let environmentPath: string;
  let env: Record<string, string>;
  const read = (file: string) => fs.readFile(file, "utf8");
  const readCapability = () => readSystemdDefinitionMutationCapability(env);
  const mutate = (work: Parameters<typeof withSystemdDefinitionMutation>[2]) =>
    withSystemdDefinitionMutation(env, env, work);
  const missing = (file: string) => expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  const baseUnit = "[Service]\nExecStart=/usr/bin/node gateway\n";
  const programArguments = ["/usr/bin/node", "/srv/openclaw/dist/index.js", "gateway"];
  const publish = (file: string, contents: string, mode = 0o600) =>
    mutate((mutation) => mutation.publish(file, contents, mode));
  const changed = (operation: Promise<unknown>) =>
    expect(operation).rejects.toThrow("changed during publication");
  const exists = (file = unitPath) =>
    fs.access(file).then(
      () => true,
      () => false,
    );
  async function input(name: string, contents: string) {
    const file = path.join(root, name);
    await writeFixtureFile(file, contents);
    return file;
  }
  const policy = (seconds: number) => `[Service]\nTimeoutStopSec=${seconds}s\n`;
  const owner = (value: string) => `[Service]\nEnvironment=OWNER=${value}\n`;
  async function alias(
    directory: string,
    target = "alias-target",
    replacement = "alias-replacement",
  ) {
    const original = path.join(root, target);
    const next = path.join(root, replacement);
    await fs.rename(directory, original);
    await fs.mkdir(next, { mode: 0o755 });
    await fs.symlink(original, directory);
    return [original, next] as const;
  }
  function setOwner(stat: { uid: number | bigint; gid: number | bigint }, uid = 0) {
    for (const field of ["uid", "gid"] as const) {
      Object.defineProperty(stat, field, {
        value: typeof stat[field] === "bigint" ? BigInt(uid) : uid,
      });
    }
  }
  function mockOpenedStat(handle: FileHandle, change: (stat: Stats | BigIntStats) => void) {
    const stat = handle.stat.bind(handle);
    vi.spyOn(handle, "stat").mockImplementation(async (...args) => {
      const opened = await stat(...args);
      change(opened);
      return opened;
    });
  }
  function onStat(change: (file: unknown, stat: Stats | BigIntStats) => void) {
    const lstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await lstat(...args);
      change(args[0], stat);
      return stat;
    });
  }
  async function expectRefusal(expected: object, ...messages: string[]) {
    const capability = await readCapability();
    expect(capability).toMatchObject(expected);
    expect(JSON.stringify(capability)).not.toContain("secret-canary");
    const staged = stage();
    for (const message of messages) {
      await expect(staged).rejects.toThrow(message);
    }
  }
  async function expectEmpty(...directories: string[]) {
    for (const directory of directories) {
      expect(await fs.readdir(directory)).toEqual([]);
    }
  }

  function onOpen(effect: (file: unknown, handle: FileHandle) => void) {
    const open = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      effect(args[0], handle);
      return handle;
    });
  }
  function mockMount(file: string, mountInfo: string, onTarget?: (handle: FileHandle) => void) {
    const readFile = fs.readFile.bind(fs);
    let fd: number | undefined;
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    onOpen((opened, handle) => {
      if (opened === file) {
        fd = handle.fd;
        onTarget?.(handle);
      } else if (onTarget) {
        fd = undefined;
      }
    });
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (typeof args[0] === "string" && args[0].startsWith("/proc/self/fdinfo/")) {
        return `mnt_id:\t${args[0] === `/proc/self/fdinfo/${fd}` ? 2 : 1}\n`;
      }
      return args[0] === "/proc/self/mountinfo" ? mountInfo : readFile(...args);
    });
  }

  function afterRename(target: string, fault: () => Promise<void>, before = false) {
    const rename = fs.rename.bind(fs);
    let renamed = false;
    return vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      const selected = destination === target && !renamed;
      renamed ||= selected;
      if (selected && before) {
        await fault();
      }
      await rename(source, destination);
      if (selected && !before) {
        await fault();
      }
    });
  }

  function mockStatOwner(matches: (file: unknown) => boolean, uid: number, writable = false) {
    onStat((file, stat) => {
      if (matches(file)) {
        Object.defineProperty(stat, "uid", {
          value: typeof stat.uid === "bigint" ? BigInt(uid) : uid,
        });
        if (writable) {
          Object.defineProperty(stat, "mode", {
            value: typeof stat.mode === "bigint" ? stat.mode | 0o022n : stat.mode | 0o022,
          });
        }
      }
    });
  }

  beforeEach(async () => {
    assertNoSystemOwnership.mockReset().mockResolvedValue(undefined);
    vi.mocked(execFileUtf8).mockReset().mockImplementation(systemdManagerVersionProbe);
    busctl.mockReset().mockImplementation(async (serviceEnv) => ({
      code: 1,
      termination: "exit",
      stdout: "",
      stderr: `Call failed: Unit ${serviceEnv.OPENCLAW_SYSTEMD_UNIT}.service not found.`,
    }));
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-definition-")));
    stateDir = path.join(root, "state");
    env = {
      HOME: path.join(root, "home"),
      XDG_RUNTIME_DIR: path.join(root, "runtime"),
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/bus`,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_SYSTEMD_UNIT: "openclaw-owned",
    };
    unitPath = path.join(env.HOME!, ".config/systemd/user/openclaw-owned.service");
    environmentPath = path.join(stateDir, "gateway.systemd.env");
    await fs.mkdir(path.dirname(unitPath), { recursive: true, mode: 0o755 });
    await fs.mkdir(stateDir, { mode: 0o700 });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  const stage = (environmentOverrides: Record<string, string> = {}) =>
    stageSystemdService({
      env,
      stdout: new PassThrough(),
      programArguments,
      environment: {
        OPENCLAW_GATEWAY_PORT: "18789",
        OPENCLAW_GATEWAY_TOKEN: "replacement-secret-canary",
        ...environmentOverrides,
      },
      environmentValueSources: {
        OPENCLAW_GATEWAY_PORT: "inline",
        OPENCLAW_GATEWAY_TOKEN: "file",
      },
    });

  function managerDefinition(
    fragmentPath: string,
    dropInPaths: string[] = [],
    environmentFiles: Array<[string, boolean]> = [],
    isLoaded = async () => true,
    includeLoadedLookup = false,
  ) {
    busctl.mockImplementation(async (_env, args) => {
      const loaded = await isLoaded();
      return {
        code: 0,
        termination: "exit",
        stderr: "",
        stdout:
          args.includes("LoadUnit") || (includeLoadedLookup && args.includes("GetUnit"))
            ? JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/owned"] })
            : args.includes("org.freedesktop.systemd1.Unit")
              ? buildSystemdUnitPropertyOutput({
                  fragmentPath: loaded ? fragmentPath : "",
                  dropInPaths: loaded ? dropInPaths : [],
                  loadState: loaded ? "loaded" : "not-found",
                })
              : buildSystemdManagerPropertyOutput({
                  programArguments: ["/usr/bin/node", "gateway"],
                  environment: ["TOKEN=manager-secret-canary"],
                  environmentFiles,
                }),
      };
    });
  }

  function afterTemporaryWrite(file: string, fault: () => void | Promise<void>, aliased = false) {
    const writeFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await writeFile(...args);
      if (
        typeof args[0] === "string" &&
        (aliased ? path.basename(args[0]) : args[0]).startsWith(
          `${aliased ? path.basename(file) : file}.`,
        ) &&
        args[0].endsWith(".tmp")
      ) {
        await fault();
      }
    });
  }
  const afterUnitTemporaryWrite = (fault: () => void | Promise<void>) =>
    afterTemporaryWrite(unitPath, fault);

  async function expectNoTemporaryFiles(...directories: string[]) {
    for (const directory of directories) {
      expect((await fs.readdir(directory)).filter((file) => file.endsWith(".tmp"))).toEqual([]);
    }
  }

  it("publishes a first unit through a manager-discovered alias", async ({ signal }) => {
    const directory = path.dirname(unitPath);
    await alias(directory);
    managerDefinition(unitPath, [], [], exists);
    expect(await readCapability()).toEqual({ kind: "writable" });
    signal.throwIfAborted();
    let published = false;
    afterRename(
      unitPath,
      async () => {
        expect(await read(environmentPath)).toContain("replacement-secret-canary");
        published = true;
      },
      true,
    );
    await expect(stage()).resolves.toMatchObject({ unitPath });
    expect(published).toBe(true);
    expect(await readCapability()).toEqual({ kind: "writable" });
    expect(await read(unitPath)).toContain("ExecStart=");
    expect(await fs.readdir(path.dirname(unitPath))).toEqual([path.basename(unitPath)]);
    expect(await fs.readdir(stateDir)).toEqual([path.basename(environmentPath)]);
  });

  it.each([
    { artifact: "unit", scenario: "changed alias" },
    { artifact: "environment", scenario: "retargeted alias" },
  ])("rejects $artifact directory $scenario", async ({ artifact, scenario }) => {
    const file = artifact === "unit" ? unitPath : environmentPath;
    const directory = path.dirname(file);
    const [target, replacement] = await alias(directory);
    managerDefinition(unitPath, [], [], exists);
    let replaced = false;
    afterTemporaryWrite(
      file,
      async () => {
        if (!replaced) {
          replaced = true;
          // Replacing an alias must reject publication and clean the original directory.
          await fs.rename(directory, `${directory}.previous`);
          await fs.symlink(scenario === "retargeted alias" ? replacement : target, directory);
        }
      },
      true,
    );
    if (scenario === "retargeted alias") {
      await expect(stage()).rejects.toThrow();
    } else {
      await expect(stage()).rejects.toThrow("changed during publication");
    }
    await expectEmpty(target, replacement, stateDir);
  });

  it("redacts and refuses uninspectable managers", async () => {
    busctl.mockRejectedValue(new Error("manager-secret-canary"));
    await expectRefusal({ kind: "unknown" }, "SERVICE_DEFINITION_UNKNOWN");
    await expectEmpty(stateDir, path.dirname(unitPath));
  });

  it("detects changed root-owned type-wide defaults", async () => {
    const shared = await input("distribution-user/service.d/default.conf", policy(30));
    await writeFixtureFile(unitPath, baseUnit);
    await writeFixtureFile(environmentPath, "OPERATOR=unchanged\n");
    managerDefinition(unitPath, [shared]);
    onStat((file, stat) => {
      if (file === shared || file === path.dirname(shared)) {
        setOwner(stat);
      }
    });
    mockMount(
      shared,
      `1 0 0:1 / / rw - tmpfs tmpfs rw\n2 1 0:2 / ${shared} ro - tmpfs tmpfs ro\n`,
      (handle) => mockOpenedStat(handle, setOwner),
    );
    expect(await readCapability()).toEqual({ kind: "writable" });
    const originalUnit = await read(unitPath);
    afterRename(unitPath, () => writeFixtureFile(shared, policy(60)));
    await changed(stage());
    await expectFiles({ [unitPath]: originalUnit, [environmentPath]: "OPERATOR=unchanged\n" });
    expect(await read(shared)).toContain("60s");
  });

  it("preserves unit replacement during first-load discovery", async () => {
    const shared = await input("service.d/default.conf", policy(30));
    managerDefinition(unitPath, [shared], [], exists);
    afterRename(unitPath, async () => {
      expect(await read(environmentPath)).toContain("replacement-secret-canary");
      const replacement = await input("operator-replacement", "OPERATOR=concurrent\n");
      await fs.rename(replacement, unitPath);
    });

    await changed(stage());

    expect(await read(unitPath)).toBe("OPERATOR=concurrent\n");
    await missing(environmentPath);
    expect(await read(shared)).toContain("30s");
    await expectNoTemporaryFiles(path.dirname(unitPath), stateDir);
  });

  it("rejects changed uid between lstat and open", async () => {
    await writeFixtureFile(unitPath, baseUnit);
    onOpen((file, handle) => {
      if (file === unitPath) {
        mockOpenedStat(handle, (opened) => {
          Object.defineProperty(opened, "uid", {
            value: typeof opened.uid === "bigint" ? opened.uid + 1n : opened.uid + 1,
          });
        });
      }
    });
    expect(await readCapability()).toMatchObject({ kind: "unknown" });
    await expectEmpty(stateDir);
  });

  it("fingerprints drop-ins without owning their publication", async () => {
    const extra = await input("operator.conf", owner("first"));
    await writeFixtureFile(unitPath, baseUnit);
    await writeFixtureFile(environmentPath, "OPERATOR=preserved\n");
    managerDefinition(unitPath, [extra]);
    expect(await readCapability()).toEqual({ kind: "writable" });
    await mutate(async (mutation) => {
      expect([...mutation.snapshots.keys()]).toEqual([unitPath, environmentPath]);
      await expect(mutation.publish(extra, "must not publish", 0o600)).rejects.toThrow(
        "Not a managed service publication target",
      );
      await expect(
        mutation.restore(extra, { contents: Buffer.from("must not restore"), mode: 0o600 }),
      ).rejects.toThrow("Not a managed service publication target");
      await mutation.publish(unitPath, "managed definition", 0o644);
      await mutation.restore(extra, null);
      expect(await read(extra)).toContain("OWNER=first");
      afterUnitTemporaryWrite(() => writeFixtureFile(extra, owner("second")));
      await changed(mutation.publish(unitPath, "must not publish", 0o644));
    });
    await expectFiles({
      [unitPath]: "managed definition",
      [environmentPath]: "OPERATOR=preserved\n",
    });
    expect(await read(extra)).toContain("OWNER=second");
    await expectNoTemporaryFiles(path.dirname(unitPath));
  });

  it("rejects a concurrent unit edit between publications", async () => {
    await mutate(async (mutation) => {
      await mutation.publish(unitPath, "first publication", 0o600);
      await writeFixtureFile(unitPath, "operator edit");
      await changed(mutation.publish(unitPath, "must not accept", 0o600));
    });
    expect(await read(unitPath)).toBe("operator edit");
    await expectNoTemporaryFiles(path.dirname(unitPath));
  });

  it.each([
    { artifact: "unit", select: () => unitPath, existed: false },
    { artifact: "environment", select: () => environmentPath, existed: true },
  ])("rolls back $artifact post-rename failure (existed=$existed)", async ({ select, existed }) => {
    const target = select();
    const extra = await input("operator.conf", owner("first"));
    managerDefinition(extra);
    if (existed) {
      await writeFixtureFile(target, "previous definition", 0o400);
    }
    afterRename(target, () => writeFixtureFile(extra, owner("second")));
    await changed(publish(target, "must not remain"));
    if (existed) {
      await expectFiles({ [target]: { contents: "previous definition", mode: 0o400 } });
    } else {
      await missing(target);
    }
    expect(await read(extra)).toContain("OWNER=second");
    await expectNoTemporaryFiles(path.dirname(target));
  });

  it("rollback preserves concurrent environment edits", async () => {
    const previousUnit = "[Service]\nExecStart=/usr/bin/node /old/index.js gateway\n";
    await writeFixtureFile(unitPath, previousUnit);
    await writeFixtureFile(environmentPath, "OPERATOR=original\n");
    afterRename(unitPath, async () => {
      expect(await read(environmentPath)).toContain("replacement-secret-canary");
      await writeFixtureFile(environmentPath, "OPERATOR=concurrent\n");
    });

    await changed(stage());
    await expectFiles({ [environmentPath]: "OPERATOR=concurrent\n", [unitPath]: previousUnit });
    await expectNoTemporaryFiles(path.dirname(unitPath), stateDir);
  });

  it.each([
    { mount: "file-ro", mode: 0o400 },
    { mount: "file-rw", mode: 0o644 },
  ])("inspects a mounted target before staging ($mount, $mode)", async ({ mount, mode }) => {
    await writeFixtureFile(unitPath, "original definition", mode);
    const escaped = unitPath.replaceAll(" ", "\\040");
    mockMount(
      unitPath,
      `1 0 0:1 / / rw - tmpfs tmpfs rw\n2 1 0:1 /unit ${escaped} ${mount === "file-ro" ? "ro" : "rw"} - tmpfs tmpfs rw\n`,
    );

    expect(await readCapability()).toMatchObject({ kind: "sealed" });
    await expect(stage()).rejects.toThrow("SERVICE_DEFINITION_SEALED");
    expect(await read(unitPath)).toBe("original definition");
    await expectEmpty(stateDir);
    expect(await fs.readdir(path.dirname(unitPath))).toEqual([path.basename(unitPath)]);
  });

  it("cleans unpublished temporary files after a write failure", async () => {
    await writeFixtureFile(unitPath, "previous definition");
    afterUnitTemporaryWrite(() => {
      throw new Error("write failed");
    });
    await expect(publish(unitPath, "must not remain")).rejects.toThrow("write failed");
    expect(await read(unitPath)).toBe("previous definition");
    await expectNoTemporaryFiles(path.dirname(unitPath));
  });

  it.each(["file symlink", "world-writable", "uninspectable", "directory"])(
    "rejects manager definition: %s",
    async (kind) => {
      const directory = path.join(root, "operator");
      const target = path.join(directory, "operator.conf");
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
        onStat((file) => {
          if (file === extra) {
            throw Object.assign(new Error("inspection-secret-canary"), { code: "EACCES" });
          }
        });
      }
      managerDefinition(extra);
      const reason =
        kind === "file symlink"
          ? "symlink"
          : kind === "world-writable"
            ? "unsafe-permissions"
            : "inspection-failed";
      await expectRefusal(
        { kind: "unknown", reason, path: extra },
        `SERVICE_DEFINITION_UNKNOWN: [${reason}]`,
      );
      expect(await read(target)).toContain("protected-secret-canary");
      await expectEmpty(path.dirname(unitPath), stateDir);
    },
  );

  it("seals foreign-owned parents", async () => {
    const protectedParent = path.dirname(unitPath);
    const originalEntries = await fs.readdir(protectedParent);
    mockStatOwner((file) => file === protectedParent, (process.geteuid?.() ?? 0) + 1);
    await expectRefusal({ kind: "sealed" }, "SERVICE_DEFINITION_SEALED");
    expect(await fs.readdir(protectedParent)).toEqual(originalEntries);
  });

  it("seals foreign-owned files before considering unsafe permissions", async () => {
    await writeFixtureFile(unitPath, baseUnit);
    const protectedPath = environmentPath;
    await writeFixtureFile(protectedPath, "protected-secret-canary\n");
    const original = await fs.readFile(protectedPath);
    mockStatOwner((file) => file === protectedPath, (process.geteuid?.() ?? 0) + 1, true);
    await expectRefusal(
      { kind: "sealed", path: protectedPath },
      "SERVICE_DEFINITION_SEALED",
      JSON.stringify(protectedPath),
    );
    expect(await fs.readFile(protectedPath)).toEqual(original);
  });

  it("preserves symlink targets before publishing a new unit", async () => {
    const file = environmentPath;
    const target = await input("operator-target", "operator-secret-canary\n");
    await fs.symlink(target, file);

    await expect(readCapability()).resolves.toEqual({
      kind: "unknown",
      reason: "symlink",
      artifact: "service-file",
      path: file,
    });
    await expect(stage()).rejects.toThrow("SERVICE_DEFINITION_UNKNOWN: [symlink]");
    expect(await fs.readlink(file)).toBe(target);
    expect(await read(target)).toBe("operator-secret-canary\n");
    await missing(unitPath);
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

    await expectFiles({ [`${unitPath}.bak`]: { contents: previous, mode: 0o600 } });
    const unit = await read(unitPath);
    for (const part of ["/srv/openclaw/dist/index.js", "TimeoutStopSec=330", "KillMode=mixed"]) {
      expect(unit).toContain(part);
    }
    expect(unit).not.toContain("replacement-secret-canary");
    expect((await fs.stat(unitPath)).mode & 0o777).toBe(0o600);
    expect(await read(environmentPath)).toContain("OPERATOR_SECRET=preserved-canary");
    expect(chmod).not.toHaveBeenCalled();
    expect(
      (await fs.readdir(path.dirname(unitPath))).filter((file) => file.includes(".tmp")),
    ).toEqual([]);
  });

  it("refuses unsafe directories with repairable units", async () => {
    const previous = "[Service]\nExecStart=/usr/bin/node /old/index.js gateway\n";
    await writeFixtureFile(unitPath, previous);
    await fs.chmod(unitPath, 0o664);
    await fs.chmod(path.dirname(unitPath), 0o775);

    await expect(stage()).rejects.toThrow("SERVICE_DEFINITION_UNKNOWN: [unsafe-permissions]");
    await expectFiles({ [unitPath]: { contents: previous, mode: 0o664 } });
    expect(await fs.readdir(path.dirname(unitPath))).toEqual([path.basename(unitPath)]);
  });

  it("repairs owned writable state dirs before publication", async () => {
    const mode = 0o777;
    await writeFixtureFile(path.join(stateDir, "operator-data"), "preserved\n");
    await fs.chmod(stateDir, mode);

    expect(await readCapability()).toEqual({ kind: "writable" });
    expect((await fs.stat(stateDir)).mode & 0o777).toBe(mode);
    await stage();

    expect((await fs.stat(stateDir)).mode & 0o777).toBe(0o700);
    expect(await read(path.join(stateDir, "operator-data"))).toBe("preserved\n");
    expect(await read(unitPath)).toContain("ExecStart=");
    expect(await read(environmentPath)).toContain("replacement-secret-canary");
  });

  it("does not publish service credentials if state directory repair fails", async () => {
    await fs.chmod(stateDir, 0o775);
    onOpen((file, handle) => {
      if (file === stateDir) {
        vi.spyOn(handle, "chmod").mockRejectedValue(new Error("state directory chmod denied"));
      }
    });

    await expect(stage()).rejects.toThrow("state directory chmod denied");
    await expectEmpty(stateDir, path.dirname(unitPath));
    expect((await fs.stat(stateDir)).mode & 0o777).toBe(0o775);
  });

  it("publishes only the effective state-dir environment", async () => {
    const effectiveStateDir = path.join(root, "effective-state");
    const effectiveEnvironmentPath = path.join(effectiveStateDir, "gateway.systemd.env");
    await fs.mkdir(effectiveStateDir, { mode: 0o700 });
    await writeFixtureFile(environmentPath, "CALLER_SECRET=caller-canary\n");
    await writeFixtureFile(effectiveEnvironmentPath, "OPERATOR_SECRET=preserved-canary\n");

    await stage({ OPENCLAW_STATE_DIR: effectiveStateDir });

    expect(await read(environmentPath)).toBe("CALLER_SECRET=caller-canary\n");
    expect(await read(effectiveEnvironmentPath)).toContain("OPERATOR_SECRET=preserved-canary");
    expect(await read(effectiveEnvironmentPath)).toContain(
      "OPENCLAW_GATEWAY_TOKEN=replacement-secret-canary",
    );
    expect(await read(unitPath)).toContain(effectiveEnvironmentPath);
  });

  it("retains retired environment files until unreferenced", async () => {
    await writeFixtureFile(
      unitPath,
      `[Service]\nExecStart=/usr/bin/node gateway\nEnvironmentFile=${environmentPath}\n`,
    );
    await writeFixtureFile(environmentPath, "OPENCLAW_GATEWAY_TOKEN=retired-secret-canary\n");
    managerDefinition(unitPath, [], [[environmentPath, false]]);

    await stageSystemdService({
      env,
      stdout: new PassThrough(),
      programArguments,
      environment: { OPENCLAW_GATEWAY_PORT: "18789" },
      environmentValueSources: { OPENCLAW_GATEWAY_TOKEN: "file" },
    });

    expect(await read(environmentPath)).toBe("");
    expect(await read(unitPath)).not.toContain("EnvironmentFile=");
  });

  it.each(["environment", "unit", "directory alias", "retargeted unit"])(
    "serializes concurrent canonical-target writers (%s)",
    async (shared) => {
      const retarget = shared.startsWith("retargeted");
      const file = shared.includes("environment") ? environmentPath : unitPath;
      const directory = path.dirname(file);
      let original = "";
      let replacement = "";
      const other = { ...env };
      if (retarget) {
        [original, replacement] = await alias(directory, "original", "replacement");
      } else if (shared === "environment") {
        other.OPENCLAW_SYSTEMD_UNIT = "openclaw-secondary";
      } else {
        other.OPENCLAW_STATE_DIR = path.join(root, "other-state");
        await fs.mkdir(other.OPENCLAW_STATE_DIR, { mode: 0o700 });
        if (shared === "directory alias") {
          other.HOME = path.join(root, "home-alias");
          await fs.symlink(env.HOME!, other.HOME);
        }
      }
      const events: string[] = [];
      const { promise: barrier, resolve: release } = createDeferred();
      const { promise: firstStarted, resolve: entered } = createDeferred();
      const first = mutate(async (mutation) => {
        events.push("first-start");
        entered();
        await barrier;
        if (!retarget) {
          await mutation.publish(file, "first writer", 0o600);
        }
        events.push("first-finish");
      });
      await firstStarted;
      let contended = false;
      onOpen((opened) => {
        // Reading a held sidecar follows the owner's failed exclusive acquire.
        if (typeof opened === "string" && opened.endsWith(".lock")) {
          contended = true;
        }
      });
      const second = withSystemdDefinitionMutation(other, other, async (mutation) => {
        events.push("second-start");
        const target = shared === "directory alias" ? file.replace(env.HOME!, other.HOME!) : file;
        if (!retarget) {
          expect(mutation.snapshots.get(target)?.contents.toString()).toBe("first writer");
        }
        await mutation.publish(target, "second writer", 0o600);
      });
      try {
        await vi.waitFor(() => expect(contended).toBe(true));
        expect(events).toEqual(["first-start"]);
        if (retarget) {
          await fs.unlink(directory);
          await fs.symlink(replacement, directory);
        }
      } finally {
        release();
      }
      await first;
      if (retarget) {
        await expect(second).rejects.toThrow("lock targets changed");
        expect(events).toEqual(["first-start", "first-finish"]);
        await expectEmpty(original, replacement);
      } else {
        await second;
        expect(events).toEqual(["first-start", "first-finish", "second-start"]);
        expect(await read(file)).toBe("second writer");
      }
    },
  );

  it("bounds lock acquisition by the deadline", async () => {
    const { promise: barrier, resolve: release } = createDeferred();
    const { promise: firstStarted, resolve: entered } = createDeferred();
    const first = mutate(async () => {
      entered();
      await barrier;
    });
    await firstStarted;
    const startedAt = Date.now();
    try {
      await expect(
        withSystemdDefinitionMutation(env, env, async () => undefined, { timeoutMs: 100 }),
      ).rejects.toMatchObject({ code: "file_lock_timeout" });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      release();
      await first;
    }
  });

  async function loadedDefinition() {
    await writeFixtureFile(unitPath, baseUnit);
    const state = { loaded: true };
    managerDefinition(unitPath, [], [], async () => state.loaded, true);
    return state;
  }

  async function unverifiableSystemOwner() {
    const actual =
      await vi.importActual<typeof import("./systemd-system.js")>("./systemd-system.js");
    vi.mocked(execFileUtf8)
      .mockReset()
      .mockResolvedValue({ code: 1, termination: "exit", stdout: "", stderr: "denied" });
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      return await actual.assertNoSystemSystemdOwnership("openclaw-owned.service", 1000).then(
        () => undefined,
        (error: unknown) => error,
      );
    } finally {
      if (platform) {
        Object.defineProperty(process, "platform", platform);
      }
      vi.mocked(execFileUtf8).mockReset().mockImplementation(systemdManagerVersionProbe);
    }
  }

  it.each([false, true])("inspects without loading managers (legacy=%s)", async (legacy) => {
    if (legacy) {
      delete env.OPENCLAW_SYSTEMD_UNIT;
      env.OPENCLAW_PROFILE = "lisa";
      unitPath = path.join(path.dirname(unitPath), "openclaw-lisa.service");
      // An unrelated canonical backup cannot decide the selected legacy unit's authority.
      await fs.symlink(
        unitPath,
        path.join(path.dirname(unitPath), "openclaw-gateway-lisa.service.bak"),
      );
    }
    await loadedDefinition();
    const unitName = path.basename(unitPath);
    await expect(
      readSystemdDefinitionMutationCapability(env, {
        requireLoaded: true,
        timeoutMs: 1000,
        ...(legacy ? { systemdReadTarget: { scope: "user" as const, unitName, unitPath } } : {}),
      }),
    ).resolves.toEqual({ kind: "writable" });
    expect(assertNoSystemOwnership).toHaveBeenCalledWith(unitName, expect.any(Number), {
      requireLoaded: true,
    });
    expect(
      busctl.mock.calls
        .filter(([, args]) => args.includes("GetUnit"))
        .every(([, args]) => args.at(-1) === unitName),
    ).toBe(true);
    expect(busctl.mock.calls.some(([, args]) => args.includes("LoadUnit"))).toBe(false);
    expect(busctl.mock.calls.every(([, args]) => args.includes("--auto-start=no"))).toBe(true);
  });

  it("keeps only a loaded owned unit writable when system ownership is unverifiable", async () => {
    const unverifiable = await unverifiableSystemOwner();
    expect(unverifiable).toMatchObject({ ownership: { status: "unverifiable" } });
    const state = await loadedDefinition();
    assertNoSystemOwnership.mockRejectedValue(unverifiable);
    const capability = (requireLoaded = false) =>
      readSystemdDefinitionMutationCapability(env, { requireLoaded, timeoutMs: 1000 });
    await expect(capability(true)).resolves.toEqual({ kind: "writable" });
    await expect(capability()).resolves.toEqual({
      kind: "unknown",
      reason: "system-ownership-unverified",
    });
    state.loaded = false;
    await expect(capability(true)).resolves.toEqual({
      kind: "unknown",
      reason: "system-ownership-unverified",
    });
  });

  it("admits activation past an unverifiable system probe only for a loaded owned unit", async () => {
    const { assertNoSystemGatewayOwnershipForActivation } = await import("./systemd-scope.js");
    const unverifiable = await unverifiableSystemOwner();
    const state = await loadedDefinition();
    assertNoSystemOwnership.mockRejectedValue(unverifiable);
    const activate = () => assertNoSystemGatewayOwnershipForActivation(env, 1000);
    await expect(activate()).resolves.toBeUndefined();
    state.loaded = false;
    await expect(activate()).rejects.toBe(unverifiable);
    assertNoSystemOwnership.mockReset().mockRejectedValue(new Error("system-owned"));
    await expect(activate()).rejects.toThrow("system-owned");
  });

  it.each([
    { kind: "mutation", timeouts: [1_666, 1_633] },
    { kind: "loaded", timeouts: [1_666, 2_450, 4_800] },
    { kind: "metadata", timeouts: [5_000, 4_900, 4_800, 4_700] },
  ])("$kind retains its budget across a wall-clock step", async ({ kind, timeouts }) => {
    const reloadUserManager = vi
      .spyOn(systemdExec, "reloadSystemdUserManager")
      .mockResolvedValue(undefined);
    const realNow = Date.now;
    let offset = 0;
    let monotonicNow = 0;
    const stepClock = () => {
      offset = 60_000;
      monotonicNow += 100;
    };
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    // Filesystem scheduling must not consume this clock-contract fixture's budget.
    vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
    if (kind === "loaded") {
      managerDefinition("/etc/systemd/user/openclaw-owned.service");
    }
    const readManager = busctl.getMockImplementation()!;
    busctl.mockImplementation(async (...args) => {
      if (kind !== "metadata") {
        stepClock();
      }
      return readManager(...args);
    });
    if (kind === "metadata") {
      await writeFixtureFile(
        unitPath,
        legacyGatewayUnit("2026.7.1-2", "ExecStart=/usr/bin/openclaw gateway run"),
        0o600,
      );
      assertNoSystemOwnership.mockImplementation(async () => stepClock());
      await expect(refreshLegacySystemdServiceMetadata(env, 5_000)).resolves.toBe(true);
      expect(assertNoSystemOwnership).toHaveBeenCalledTimes(3);
      expect([
        ...assertNoSystemOwnership.mock.calls.map((call) => call[1]),
        ...reloadUserManager.mock.calls.map((call) => call[1]),
      ]).toEqual(timeouts);
    } else {
      if (kind === "loaded") {
        await expect(
          readSystemdServiceExecStart(env, { requireEffective: true, timeoutMs: 5_000 }),
        ).resolves.toMatchObject({ programArguments: ["/usr/bin/node", "gateway"] });
      } else {
        await withSystemdDefinitionMutation(env, env, async () => undefined, {
          timeoutMs: 5_000,
        });
      }
      expect(busctl.mock.calls.map((call) => call[2])).toEqual(timeouts);
    }
  });
});
