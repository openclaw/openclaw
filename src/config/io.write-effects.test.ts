import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  content,
  createWriteEffectsFixture,
  instrumentDestination,
  original,
  prepareClosedWrite,
  prepareWriteEffects as prepare,
} from "./io.write-effects.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const fixture = () => createWriteEffectsFixture(fs.realpathSync(dirs.make("config-effects-")));

it.runIf(process.platform !== "win32").each([
  { name: "foreign state root", foreign: true, stateRoot: true, fileFailure: false },
  { name: "owned state root", foreign: false, stateRoot: true, fileFailure: false },
  { name: "foreign credential directory", foreign: true, stateRoot: false, fileFailure: false },
  { name: "private file chmod failure", foreign: true, stateRoot: true, fileFailure: true },
])("preserves only optional directory hardening: $name", async (scenario) => {
  const f = fixture();
  // A temporary root can inherit a group that cannot retain the setgid bit.
  fs.chownSync(f.dir, process.getuid!(), process.getgid!());
  fs.chmodSync(f.dir, 0o2775);
  const root = fs.statSync(f.dir);
  const uid = scenario.foreign ? root.uid + 1 : root.uid;
  const denied = Object.assign(new Error("EPERM: operation not permitted, fchmod"), {
    code: "EPERM",
  });
  const io: typeof fs = {
    ...fs,
    fstatSync: new Proxy(fs.fstatSync, {
      apply(target, self, args) {
        const stat: fs.Stats | fs.BigIntStats = Reflect.apply(target, self, args);
        if (typeof stat.uid === "number" && stat.dev === root.dev && stat.ino === root.ino) {
          stat.uid = uid;
        }
        return stat;
      },
    }),
    fchmodSync(fd, mode) {
      if (fs.fstatSync(fd).isDirectory() || scenario.fileFailure) {
        throw denied;
      }
      fs.fchmodSync(fd, mode);
    },
  };
  const warn = vi.fn();
  const stateDirectory = { path: scenario.stateRoot ? f.dir : path.dirname(f.dir), warn };
  const { prepared, guarded } = await prepare(f, io, {
    ...f.options,
    preserveDirectoryMode: false,
    stateDirectory,
  });
  try {
    if (!scenario.foreign || !scenario.stateRoot || scenario.fileFailure) {
      expect(() => prepared.publish()).toThrow(denied);
      expect(fs.readFileSync(f.target, "utf8")).toBe(original);
      expect(f.backups()).toEqual([null, null, null, null, null]);
      return;
    }
    prepared.publish();
    expect(fs.readFileSync(f.target, "utf8")).toBe(content);
    expect(fs.readFileSync(`${f.target}.bak`, "utf8")).toBe(original);
    expect(fs.statSync(f.target).mode & 0o7777).toBe(0o600);
    expect(fs.statSync(`${f.target}.bak`).mode & 0o7777).toBe(0o600);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`uid ${uid}, gid ${root.gid}; leaving mode 2775`),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(f.dir));
    await expect(
      f.rollback(io, guarded.captureRollbackProof(f.assertCurrent), {
        stateDirectory,
      }),
    ).resolves.toBe(true);
    expect(fs.readFileSync(f.target, "utf8")).toBe(original);
    expect(fs.statSync(f.target).mode & 0o7777).toBe(0o600);
  } finally {
    expect(fs.statSync(f.dir).mode & 0o7777).toBe(0o2775);
    await prepared[Symbol.asyncDispose]();
  }
});

it("finishes Windows fallback partial writes through the same descriptor", async () => {
  const f = fixture();
  let calls = 0;
  const io: typeof fs = {
    ...fs,
    renameSync: (from, to) => {
      if (to === f.target) {
        throw Object.assign(new Error("busy destination"), { code: "EPERM" });
      }
      fs.renameSync(from, to);
    },
    writeSync: new Proxy(fs.writeSync, {
      apply(fn, self, args) {
        calls++;
        args[3] = Math.min(args[3], 3);
        return Reflect.apply(fn, self, args);
      },
    }),
  };
  const { prepared: stage, guarded } = await prepare(f, io);
  await using prepared = stage;
  expect(prepared.publish().method).toBe("copy-fallback");
  guarded.assertPublishedIdentity();
  expect(calls).toBeGreaterThan(1);
  expect(fs.readFileSync(f.target, "utf8")).toBe(content);
});

it("does not swallow a transient assertion failure during awaited backup preparation", async () => {
  const f = fixture();
  let failNext = false;
  const refusal = new Error("transient owner read failed");
  const assertCurrent = () => {
    if (failNext) {
      failNext = false;
      throw refusal;
    }
    f.assertCurrent();
  };
  const open = fsp.open;
  vi.spyOn(fsp, "open").mockImplementation(async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).includes("openclaw-config-backup")) {
      failNext = true;
    }
    return handle;
  });
  await expect(prepare(f, fs, f.options, assertCurrent, {})).rejects.toBe(refusal);
  expect(fs.readFileSync(f.target, "utf8")).toBe(original);
  expect(f.backups()).toEqual([null, null, null, null, null]);
});
it.each(["replacement", "unlink-failure"] as const)(
  "private stage cleanup retains identity and original failure: %s",
  async (fault) => {
    const f = fixture();
    let stage: string | undefined;
    const primary = new Error("caller lost authority");
    const cleanup = Object.assign(new Error("private cleanup denied"), { code: "EACCES" });
    const io: typeof fs = {
      ...fs,
      renameSync: (from, to) => {
        if (to !== f.target) {
          return fs.renameSync(from, to);
        }
        stage = String(from);
        if (fault === "replacement") {
          fs.renameSync(from, `${String(from)}.owned`);
          fs.writeFileSync(from, "stranger");
        }
        throw primary;
      },
      unlinkSync: (name) => {
        if (name === stage && fault === "unlink-failure") {
          throw cleanup;
        }
        fs.unlinkSync(name);
      },
    };
    await using prepared = (await prepare(f, io)).prepared;
    let caught: unknown;
    try {
      prepared.publish();
    } catch (error) {
      caught = error;
    }
    if (fault === "replacement") {
      expect(caught).toBe(primary);
      expect(fs.readFileSync(stage!, "utf8")).toBe("stranger");
    } else {
      expect(caught).toMatchObject({ cause: primary });
      expect(String(caught)).toContain("private cleanup denied");
    }
    expect(fs.readFileSync(f.target, "utf8")).toBe(original);
  },
);

it("refuses a backup destination replaced between mode and rename", async () => {
  const f = fixture();
  const base = `${f.target}.bak`;
  fs.writeFileSync(base, "previous backup");
  const handles = new Map<number, string>();
  let replaced = false;
  const io: typeof fs = {
    ...fs,
    openSync: (name, flags, mode) => {
      const fd = fs.openSync(name, flags, mode);
      handles.set(fd, String(name));
      return fd;
    },
    closeSync: (fd) => {
      handles.delete(fd);
      fs.closeSync(fd);
    },
    fchmodSync: (fd, mode) => {
      fs.fchmodSync(fd, mode);
      if (!replaced && handles.get(fd) === base) {
        replaced = true;
        fs.writeFileSync(`${base}.1`, "concurrent backup");
      }
    },
  };
  await using prepared = (await prepare(f, io)).prepared;
  expect(() => prepared.publish()).toThrow("config backup destination changed");
  expect(replaced).toBe(true);
  expect(fs.readFileSync(`${base}.1`, "utf8")).toBe("concurrent backup");
  expect(fs.readFileSync(base, "utf8")).toBe("previous backup");
  expect(fs.readFileSync(f.target, "utf8")).toBe(original);
});

it.each([
  { fault: "revoked", at: "before-remove" },
  { fault: "revoked", at: "remove" },
  { fault: "revoked", at: "open" },
  { fault: "revoked", at: "truncate" },
  { fault: "revoked", at: "partial-write" },
  { fault: "parent", at: "open" },
  { fault: "same-byte-replacement", at: "open" },
] as const)("$fault after $at stops the next rollback content dispatch", async ({ fault, at }) => {
  const f = fixture();
  const guarded = await prepareClosedWrite(f);
  const rollbackProof = guarded.captureRollbackProof(f.assertCurrent);
  let destinationFd: number | undefined;
  let observed: string | null | undefined;
  let observedInode: bigint | undefined;
  let parentMoved = false;
  let effects = 0;
  let effectsAtFault = 0;
  const after = (stage: string) => {
    if (stage !== at || observed !== undefined) {
      return;
    }
    const raw = fs.existsSync(f.target) ? fs.readFileSync(f.target, "utf8") : null;
    if (fault === "revoked") {
      f.revoke();
    }
    if (fault === "parent") {
      fs.renameSync(f.dir, `${f.dir}-moved`);
      fs.mkdirSync(f.dir);
      parentMoved = true;
    } else if (fault === "same-byte-replacement" && fs.existsSync(f.target)) {
      fs.renameSync(f.target, `${f.target}.owned`);
    }
    if (fault !== "revoked") {
      // Preserve current bytes; an absent target uses the committed preimage.
      fs.writeFileSync(f.target, raw ?? content);
    }
    observed = fs.existsSync(f.target) ? fs.readFileSync(f.target, "utf8") : null;
    observedInode = fs.lstatSync(f.target, { bigint: true, throwIfNoEntry: false })?.ino;
    effectsAtFault = effects;
  };
  const io = instrumentDestination(
    {
      ...fs,
      renameSync: (from, to) => {
        if (to === f.target) {
          after("before-remove");
          throw Object.assign(new Error("rollback sharing violation"), { code: "EPERM" });
        }
        fs.renameSync(from, to);
      },
      rmSync: (name, options) => {
        fs.rmSync(name, options);
        if (name === f.target) {
          effects++;
          after("remove");
        }
      },
      ftruncateSync: (fd, length) => {
        fs.ftruncateSync(fd, length);
        if (fd === destinationFd) {
          effects++;
          after("truncate");
        }
      },
    },
    f.target,
    {
      chunkSize: 3,
      open(fd) {
        destinationFd = fd;
        effects++;
        after("open");
      },
      write() {
        effects++;
        after("partial-write");
      },
    },
  );
  try {
    await expect(
      f.rollback(io, rollbackProof, {
        preserveDirectoryMode: true,
        durable: true,
        destinationHardlinks: "reject",
      }),
    ).rejects.toThrow();
    expect(observed).not.toBeUndefined();
    expect(effects).toBe(effectsAtFault);
    expect(fs.existsSync(f.target) ? fs.readFileSync(f.target, "utf8") : null).toBe(observed);
    expect(fs.lstatSync(f.target, { bigint: true, throwIfNoEntry: false })?.ino).toBe(
      observedInode,
    );
    expect(
      fs.readFileSync(`${parentMoved ? `${f.dir}-moved/channel.json` : f.target}.bak`, "utf8"),
    ).toBe(original);
  } finally {
    if (parentMoved) {
      fs.unlinkSync(f.target);
      fs.rmdirSync(f.dir);
      fs.renameSync(`${f.dir}-moved`, f.dir);
    }
  }
});
