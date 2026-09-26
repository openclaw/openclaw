import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareConfigFileWrite } from "./backup-rotation.js";
import { hashConfigRaw } from "./io.read-helpers.js";
import {
  captureConfigFileWritePathProof,
  createGuardedConfigFileSystem,
  rollbackConfigFileWriteIfUnchanged,
} from "./io.write-safety.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const original = '{"channel":"stable"}\n';
const content = '{"channel":"beta"}\n';

function fixture() {
  const dir = fs.realpathSync(dirs.make("config-effects-"));
  const target = path.join(dir, "channel.json");
  fs.writeFileSync(target, original);
  const proof = captureConfigFileWritePathProof(target, target, fs);
  let current = true;
  const refusal = new Error("original executor revoked");
  const assertCurrent = () => {
    if (!current) {
      throw refusal;
    }
    proof.assertCurrent();
  };
  const revoke = () => {
    current = false;
  };
  const options = {
    snapshot: { path: target, exists: true, raw: original },
    includeGraph: { hashes: {}, targets: {} },
    targetPathProof: proof,
    preserveDirectoryMode: true,
  };
  const backups = () =>
    ["", ".1", ".2", ".3", ".4"].map((suffix) => {
      try {
        return fs.readFileSync(`${target}.bak${suffix}`, "utf8");
      } catch {
        return null;
      }
    });
  return { dir, target, proof, assertCurrent, revoke, refusal, options, backups };
}

async function prepare(f: ReturnType<typeof fixture>, io: typeof fs = fs) {
  const guarded = createGuardedConfigFileSystem(f.target, io, f.assertCurrent, f.options);
  const prepared = await prepareConfigFileWrite({
    configPath: f.target,
    previousRaw: original,
    content,
    fsModule: guarded.fileSystem,
    assertCurrent: guarded.assertCurrent,
    destinationHardlinks: "reject",
    durable: true,
  });
  return { guarded, prepared };
}

describe("guarded config final effects", () => {
  it.each(["remove", "open", "truncate", "write"] as const)(
    "stops Windows fallback content dispatch after %s revocation",
    async (at) => {
      const f = fixture();
      let destinationFd: number | undefined;
      let observed: string | null | undefined;
      const after = (stage: string) => {
        if (stage === at && observed === undefined) {
          f.revoke();
          observed = fs.existsSync(f.target) ? fs.readFileSync(f.target, "utf8") : null;
        }
      };
      const io: typeof fs = {
        ...fs,
        renameSync: (from, to) => {
          if (to === f.target) {
            throw Object.assign(new Error("Windows sharing violation"), { code: "EPERM" });
          }
          fs.renameSync(from, to);
        },
        rmSync: (name, options) => {
          fs.rmSync(name, options);
          if (name === f.target) {
            after("remove");
          }
        },
        openSync: (name, flags, mode) => {
          const fd = fs.openSync(name, flags, mode);
          if (name === f.target && typeof flags === "number" && flags & fs.constants.O_EXCL) {
            destinationFd = fd;
            after("open");
          }
          return fd;
        },
        ftruncateSync: (fd, length) => {
          fs.ftruncateSync(fd, length);
          if (fd === destinationFd) {
            after("truncate");
          }
        },
        writeSync: new Proxy(fs.writeSync, {
          apply(fn, self, args) {
            const result = Reflect.apply(fn, self, args);
            if (args[0] === destinationFd) {
              after("write");
            }
            return result;
          },
        }),
      };
      const { prepared } = await prepare(f, io);
      try {
        expect(() => prepared.publish()).toThrow(f.refusal);
        expect(observed).not.toBeUndefined();
        expect(fs.existsSync(f.target) ? fs.readFileSync(f.target, "utf8") : null).toBe(observed);
        expect(fs.readFileSync(`${f.target}.bak`, "utf8")).toBe(original);
      } finally {
        await prepared[Symbol.asyncDispose]();
      }
      expect(fs.readdirSync(f.dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
  );

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
    const { prepared, guarded } = await prepare(f, io);
    try {
      expect(prepared.publish().method).toBe("copy-fallback");
      guarded.assertPublishedIdentity();
      expect(calls).toBeGreaterThan(1);
      expect(fs.readFileSync(f.target, "utf8")).toBe(content);
    } finally {
      await prepared[Symbol.asyncDispose]();
    }
  });

  it.each(["rename", "unlink", "mode"] as const)(
    "stops backup rotation after %s revocation",
    async (at) => {
      const f = fixture();
      for (const [index, suffix] of ["", ".1", ".2", ".3", ".4"].entries()) {
        fs.writeFileSync(`${f.target}.bak${suffix}`, `recovery-${index}`);
      }
      const handles = new Map<number, string>();
      let observed: ReturnType<typeof f.backups> | undefined;
      const after = (stage: string, name: string) => {
        if (!observed && stage === at && name.includes(".bak")) {
          f.revoke();
          observed = f.backups();
        }
      };
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
          after("mode", handles.get(fd) ?? "");
        },
        unlinkSync: (name) => {
          fs.unlinkSync(name);
          after("unlink", String(name));
        },
        renameSync: (from, to) => {
          fs.renameSync(from, to);
          after("rename", String(to));
        },
      };
      const { prepared } = await prepare(f, io);
      try {
        expect(() => prepared.publish()).toThrow(f.refusal);
        expect(observed).toBeDefined();
        expect(f.backups()).toEqual(observed);
        expect(fs.readFileSync(f.target, "utf8")).toBe(original);
      } finally {
        await prepared[Symbol.asyncDispose]();
      }
    },
  );

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
    const guarded = createGuardedConfigFileSystem(f.target, fs, assertCurrent, f.options);
    await expect(
      prepareConfigFileWrite({
        configPath: f.target,
        previousRaw: original,
        content,
        fsModule: guarded.fileSystem,
        assertCurrent: guarded.assertCurrent,
      }),
    ).rejects.toBe(refusal);
    expect(fs.readFileSync(f.target, "utf8")).toBe(original);
    expect(f.backups()).toEqual([null, null, null, null, null]);
  });

  it.each(["authority", "parent", "replacement", "permission"] as const)(
    "preserves actual publication when conditional rollback loses %s",
    async (at) => {
      const f = fixture();
      const { prepared, guarded } = await prepare(f);
      try {
        prepared.publish();
      } finally {
        await prepared[Symbol.asyncDispose]();
      }
      const rollbackProof = guarded.captureRollbackProof(f.assertCurrent);
      if (at === "authority") {
        f.revoke();
      }
      if (at === "parent") {
        fs.renameSync(f.dir, `${f.dir}-moved`);
        fs.mkdirSync(f.dir);
        fs.writeFileSync(f.target, content);
      }
      if (at === "replacement") {
        fs.renameSync(f.target, `${f.target}.owned`);
        fs.writeFileSync(f.target, content);
      }
      const io: typeof fs = {
        ...fs,
        renameSync: (from, to) => {
          if (at === "permission" && to === f.target) {
            throw Object.assign(new Error("read-only"), { code: "EROFS" });
          }
          fs.renameSync(from, to);
        },
      };
      try {
        await expect(
          rollbackConfigFileWriteIfUnchanged({
            configPath: f.target,
            previousSnapshot: f.options.snapshot,
            committedHash: hashConfigRaw(content),
            fsModule: io,
            ...rollbackProof,
          }),
        ).rejects.toThrow();
        expect(fs.readFileSync(f.target, "utf8")).toBe(content);
      } finally {
        if (at === "parent") {
          fs.unlinkSync(f.target);
          fs.rmdirSync(f.dir);
          fs.renameSync(`${f.dir}-moved`, f.dir);
        }
      }
    },
  );

  it("conditionally restores an authorized unchanged publication", async () => {
    const f = fixture();
    const { prepared, guarded } = await prepare(f);
    try {
      prepared.publish();
    } finally {
      await prepared[Symbol.asyncDispose]();
    }
    await expect(
      rollbackConfigFileWriteIfUnchanged({
        configPath: f.target,
        previousSnapshot: f.options.snapshot,
        committedHash: hashConfigRaw(content),
        fsModule: fs,
        ...guarded.captureRollbackProof(f.assertCurrent),
      }),
    ).resolves.toBe(true);
    expect(fs.readFileSync(f.target, "utf8")).toBe(original);
  });
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
    const { prepared } = await prepare(f, io);
    try {
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
    } finally {
      await prepared[Symbol.asyncDispose]();
    }
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
  const { prepared } = await prepare(f, io);
  try {
    expect(() => prepared.publish()).toThrow("config backup destination changed");
    expect(replaced).toBe(true);
    expect(fs.readFileSync(`${base}.1`, "utf8")).toBe("concurrent backup");
    expect(fs.readFileSync(base, "utf8")).toBe("previous backup");
    expect(fs.readFileSync(f.target, "utf8")).toBe(original);
  } finally {
    await prepared[Symbol.asyncDispose]();
  }
});

it("retains original and private cleanup failures during conditional rollback", async () => {
  const f = fixture();
  const { prepared, guarded } = await prepare(f);
  try {
    prepared.publish();
  } finally {
    await prepared[Symbol.asyncDispose]();
  }
  let stage: string | undefined;
  const primary = Object.assign(new Error("rollback destination read-only"), { code: "EROFS" });
  const cleanup = Object.assign(new Error("rollback private cleanup denied"), { code: "EACCES" });
  const io: typeof fs = {
    ...fs,
    renameSync: (from, to) => {
      if (to === f.target) {
        stage = String(from);
        throw primary;
      }
      fs.renameSync(from, to);
    },
    unlinkSync: (name) => {
      if (name === stage) {
        throw cleanup;
      }
      fs.unlinkSync(name);
    },
  };
  const failure = await rollbackConfigFileWriteIfUnchanged({
    configPath: f.target,
    previousSnapshot: f.options.snapshot,
    committedHash: hashConfigRaw(content),
    fsModule: io,
    ...guarded.captureRollbackProof(f.assertCurrent),
  }).catch((error: unknown) => error);
  expect(failure).toMatchObject({ cause: primary });
  expect(String(failure)).toContain("rollback private cleanup denied");
  expect(fs.readFileSync(f.target, "utf8")).toBe(content);
  expect(fs.readFileSync(`${f.target}.bak`, "utf8")).toBe(original);
});

it("restores an authorized publication through EPERM rollback fallback", async () => {
  const f = fixture();
  const { prepared, guarded } = await prepare(f);
  try {
    prepared.publish();
  } finally {
    await prepared[Symbol.asyncDispose]();
  }
  let injected = 0;
  const io: typeof fs = {
    ...fs,
    renameSync: (from, to) => {
      if (to === f.target && injected++ === 0) {
        throw Object.assign(new Error("rollback sharing violation"), { code: "EPERM" });
      }
      fs.renameSync(from, to);
    },
  };
  await expect(
    rollbackConfigFileWriteIfUnchanged({
      configPath: f.target,
      previousSnapshot: f.options.snapshot,
      committedHash: hashConfigRaw(content),
      fsModule: io,
      preserveDirectoryMode: true,
      durable: true,
      destinationHardlinks: "reject",
      ...guarded.captureRollbackProof(f.assertCurrent),
    }),
  ).resolves.toBe(true);
  expect(injected).toBe(1);
  expect(fs.readFileSync(f.target, "utf8")).toBe(original);
  expect(fs.readFileSync(`${f.target}.bak`, "utf8")).toBe(original);
  expect(fs.readdirSync(f.dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

describe("rollback owns only its permission-fallback transitions", () => {
  for (const fault of ["revoked", "parent", "same-byte-replacement"] as const) {
    it.each(["before-remove", "remove", "open", "truncate", "partial-write"] as const)(
      `${fault} after %s stops the next rollback content dispatch`,
      async (at) => {
        const f = fixture();
        const { prepared, guarded } = await prepare(f);
        try {
          prepared.publish();
        } finally {
          await prepared[Symbol.asyncDispose]();
        }
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
            // A missing target is replaced with the committed preimage; existing
            // files are replaced with exactly their current bytes, never just an edit.
            fs.writeFileSync(f.target, raw ?? content);
          }
          observed = fs.existsSync(f.target) ? fs.readFileSync(f.target, "utf8") : null;
          observedInode = fs.lstatSync(f.target, { bigint: true, throwIfNoEntry: false })?.ino;
          effectsAtFault = effects;
        };
        const io: typeof fs = {
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
          openSync: (name, flags, mode) => {
            const fd = fs.openSync(name, flags, mode);
            if (name === f.target && typeof flags === "number" && flags & fs.constants.O_EXCL) {
              destinationFd = fd;
              effects++;
              after("open");
            }
            return fd;
          },
          ftruncateSync: (fd, length) => {
            fs.ftruncateSync(fd, length);
            if (fd === destinationFd) {
              effects++;
              after("truncate");
            }
          },
          writeSync: new Proxy(fs.writeSync, {
            apply(fn, self, args) {
              if (args[0] === destinationFd) {
                args[3] = Math.min(args[3], 3);
              }
              const result = Reflect.apply(fn, self, args);
              if (args[0] === destinationFd) {
                effects++;
                after("partial-write");
              }
              return result;
            },
          }),
        };
        try {
          await expect(
            rollbackConfigFileWriteIfUnchanged({
              configPath: f.target,
              previousSnapshot: f.options.snapshot,
              committedHash: hashConfigRaw(content),
              fsModule: io,
              ...rollbackProof,
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
            fs.readFileSync(
              `${parentMoved ? `${f.dir}-moved/channel.json` : f.target}.bak`,
              "utf8",
            ),
          ).toBe(original);
        } finally {
          if (parentMoved) {
            fs.unlinkSync(f.target);
            fs.rmdirSync(f.dir);
            fs.renameSync(`${f.dir}-moved`, f.dir);
          }
        }
      },
    );
  }

  it("retains refusal and private cleanup failure after owned fallback removal", async () => {
    const f = fixture();
    const { prepared, guarded } = await prepare(f);
    try {
      prepared.publish();
    } finally {
      await prepared[Symbol.asyncDispose]();
    }
    const rollbackProof = guarded.captureRollbackProof(f.assertCurrent);
    let stage: string | undefined;
    const cleanup = Object.assign(new Error("rollback stage cleanup denied"), { code: "EACCES" });
    const io: typeof fs = {
      ...fs,
      renameSync: (from, to) => {
        if (to === f.target) {
          stage = String(from);
          throw Object.assign(new Error("sharing"), { code: "EPERM" });
        }
        fs.renameSync(from, to);
      },
      rmSync: (name, options) => {
        fs.rmSync(name, options);
        if (name === f.target) {
          f.revoke();
        }
      },
      unlinkSync: (name) => {
        if (name === stage) {
          throw cleanup;
        }
        fs.unlinkSync(name);
      },
    };
    const failure = await rollbackConfigFileWriteIfUnchanged({
      configPath: f.target,
      previousSnapshot: f.options.snapshot,
      committedHash: hashConfigRaw(content),
      fsModule: io,
      ...rollbackProof,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ cause: f.refusal });
    expect(String(failure)).toContain(cleanup.message);
    expect(fs.existsSync(f.target)).toBe(false);
    expect(fs.readFileSync(`${f.target}.bak`, "utf8")).toBe(original);
    expect(fs.readFileSync(stage!, "utf8")).toBe(original);
  });
});
