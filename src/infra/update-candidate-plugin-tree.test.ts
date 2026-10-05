import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as fsSafe from "./fs-safe.js";
import { hasNodeErrorCode } from "./path-guards.js";
import {
  copyUpdateCandidatePluginTrees,
  prepareUpdateCandidatePluginTrees,
} from "./update-candidate-plugin-tree.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function fixture(hardlink = false, beforePlan?: (source: string) => Promise<void>) {
  const root = await fs.realpath(dirs.make("candidate-plugin-copy-"));
  const source = path.join(root, "source");
  const targetStateDir = path.join(root, "snapshot");
  const candidateRoot = path.join(root, "candidate");
  const destination = path.join(targetStateDir, "plugin");
  await fs.mkdir(source);
  await fs.mkdir(candidateRoot);
  const file = path.join(source, "payload.txt");
  await fs.writeFile(file, "inventoried plugin bytes");
  await fs.chmod(file, 0o444);
  if (hardlink) {
    await fs.link(file, `${file}.linked`);
  }
  await beforePlan?.(source);
  const plan = await prepareUpdateCandidatePluginTrees({
    roots: new Map([[source, destination]]),
    project: (entry) => path.join(destination, path.relative(source, entry)),
    targetStateDir,
    candidateRoot,
  });
  return {
    file,
    destination,
    plan,
    copy: () => copyUpdateCandidatePluginTrees(plan, { targetStateDir, candidateRoot }),
  };
}

function atCopyBoundary(mutate: () => void, phase: "admission" | "mutation" = "mutation") {
  const openRoot = fsSafe.root;
  vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
    const root = await openRoot(...args);
    const copyIn = root.copyIn.bind(root);
    vi.spyOn(root, "copyIn").mockImplementation((relative, source, options) => {
      if (phase === "admission") {
        mutate();
        return copyIn(relative, source, options);
      }
      return copyIn(relative, source, {
        ...options,
        assertBeforeMutation: () => {
          mutate();
          options?.assertBeforeMutation?.();
        },
      });
    });
    return root;
  });
}

it.for([".MODULES.YAML", ".moduleſ.yaml"])(
  "discovers external stores through the filesystem metadata alias %s",
  async (alias, context) => {
    let store = "";
    const f = await fixture(false, async (source) => {
      store = path.join(path.dirname(source), "external-store");
      await fs.mkdir(store);
      await fs.writeFile(path.join(store, "entry.js"), "export const value = 1;");
      await fs.writeFile(path.join(source, alias), `virtualStoreDir: ${JSON.stringify(store)}\n`);
      const canonical = await fs
        .stat(path.join(source, ".modules.yaml"))
        .catch((error: unknown) => {
          if (hasNodeErrorCode(error, "ENOENT")) {
            return undefined;
          }
          throw error;
        });
      if (!canonical) {
        context.skip("Requires this metadata alias to resolve on the fixture filesystem");
      }
    });
    expect(f.plan.copies.map(([source]) => source)).toContain(store);
    expect(f.plan.entries.map((entry) => entry.path)).toContain(path.join(store, "entry.js"));
  },
);

it.each(["directory", "invalid YAML"])("rejects a listed .modules.yaml %s", async (kind) => {
  await expect(
    fixture(false, async (source) => {
      const manifest = path.join(source, ".modules.yaml");
      if (kind === "directory") {
        await fs.mkdir(manifest);
      } else {
        await fs.writeFile(manifest, "virtualStoreDir: [");
      }
    }),
  ).rejects.toThrow();
});

it.each(["auto", "off", "clone-denied"] as const)(
  "isolates plugin bytes and modes with native copying %s",
  async (nativeMode) => {
    const metadataStat = vi.spyOn(fsSync, "lstatSync");
    const metadataRead = vi.spyOn(fs, "readFile");
    const f = await fixture(true, async (source) => {
      await fs.mkdir(path.join(source, "nested"));
      for (let index = 0; index < 8; index++) {
        await fs.writeFile(path.join(source, "nested", `${index}.txt`), `payload ${index}`);
      }
    });
    const source = path.dirname(f.file);
    expect(
      metadataStat.mock.calls.filter(([file]) => file === path.join(source, "package.json")),
    ).toHaveLength(0);
    expect(
      metadataRead.mock.calls.filter(([file]) => file === path.join(source, ".modules.yaml")),
    ).toHaveLength(0);
    const linked = `${f.file}.linked`;
    const before = await fs.stat(f.file, { bigint: true });
    const mkdir = vi.spyOn(fs, "mkdir");
    if (nativeMode === "clone-denied") {
      const openRoot = fsSafe.root;
      vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
        const root = await openRoot(...args);
        const copyIn = root.copyIn.bind(root);
        vi.spyOn(root, "copyIn").mockImplementation((relative, input, options) => {
          if (options?.clone !== "never") {
            throw new fsSafe.FsSafeError("helper-failed", "native file copy failed", {
              cause: Object.assign(new Error("FICLONE: denied"), { code: "EPERM" }),
            });
          }
          return copyIn(relative, input, options);
        });
        return root;
      });
    }
    const configuredMode = nativeMode === "off" ? "off" : "auto";
    vi.stubEnv("FS_SAFE_NATIVE_MODE", configuredMode);
    try {
      // FreeBSD has no native binding; "off" exercises the real portable fallback.
      expect(getFsSafeNativeConfig().mode).toBe(configuredMode);
      await f.copy();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(mkdir.mock.calls.length).toBeLessThanOrEqual(
      f.plan.entries.filter((entry) => entry.kind === "directory").length + 1,
    );
    for (let index = 0; index < 8; index++) {
      expect(await fs.readFile(path.join(f.destination, "nested", `${index}.txt`), "utf8")).toBe(
        `payload ${index}`,
      );
    }
    const copied = path.join(f.destination, "payload.txt");
    const after = await fs.stat(f.file, { bigint: true });
    const snapshot = await fs.stat(copied, { bigint: true });
    expect(await fs.readFile(copied, "utf8")).toBe("inventoried plugin bytes");
    expect(await fs.readFile(linked, "utf8")).toBe("inventoried plugin bytes");
    expect(after).toMatchObject({
      ino: before.ino,
      mode: before.mode,
      size: before.size,
      mtimeNs: before.mtimeNs,
      ctimeNs: before.ctimeNs,
    });
    expect(snapshot.ino).not.toBe(before.ino);
    expect(snapshot.nlink).toBe(1n);
    if (process.platform !== "win32") {
      expect(snapshot.mode & 0o777n).toBe(0o444n);
    }
    expect((await fs.readdir(f.destination)).toSorted()).toEqual([
      "nested",
      "payload.txt",
      "payload.txt.linked",
    ]);
    await fs.chmod(copied, 0o600);
    await fs.writeFile(copied, "private candidate changes");
    expect(await fs.readFile(f.file, "utf8")).toBe("inventoried plugin bytes");
    expect(await fs.readFile(linked, "utf8")).toBe("inventoried plugin bytes");
    expect((await fs.stat(f.file, { bigint: true })).mode).toBe(before.mode);
    expect((await fs.stat(linked, { bigint: true })).mode).toBe(before.mode);
  },
);

it.each(["file", "symlink"] as const)(
  "preserves a %s that appears after planning before copy admission",
  async (kind) => {
    const f = await fixture();
    const target = path.join(f.destination, "payload.txt");
    let inserted = false;
    atCopyBoundary(() => {
      if (inserted) {
        return;
      }
      inserted = true;
      if (kind === "file") {
        fsSync.writeFileSync(target, "existing private bytes", { flag: "wx" });
      } else {
        fsSync.symlinkSync(f.file, target);
      }
    }, "admission");
    await expect(f.copy()).rejects.toThrow();
    expect(inserted).toBe(true);
    expect(await fs.readdir(f.destination)).toEqual(["payload.txt"]);
    expect(await fs.readFile(f.file, "utf8")).toBe("inventoried plugin bytes");
    if (kind === "file") {
      expect(await fs.readFile(target, "utf8")).toBe("existing private bytes");
    } else {
      expect(await fs.readlink(target)).toBe(f.file);
    }
  },
);

it.each(["mode", "same-size content with changed mtime", "identity"] as const)(
  "refuses %s changes at the copy mutation boundary before exposing plugin bytes",
  async (change) => {
    const f = await fixture();
    let mutated = false;
    atCopyBoundary(() => {
      if (mutated) {
        return;
      }
      mutated = true;
      if (change === "identity") {
        fsSync.renameSync(f.file, `${f.file}.original`);
        fsSync.writeFileSync(f.file, "inventoried plugin bytes", { mode: 0o444 });
      } else if (change === "mode") {
        fsSync.chmodSync(f.file, 0o600);
      } else {
        const before = fsSync.lstatSync(f.file, { bigint: true });
        fsSync.chmodSync(f.file, 0o600);
        fsSync.writeFileSync(f.file, "altered but equal bytes!");
        fsSync.chmodSync(f.file, 0o444);
        // A same-tick rewrite can retain its timestamps; force a real fingerprint change.
        fsSync.utimesSync(f.file, before.atime, new Date(before.mtime.getTime() + 60_000));
        const changed = fsSync.lstatSync(f.file, { bigint: true });
        expect(changed).toMatchObject({
          dev: before.dev,
          ino: before.ino,
          size: before.size,
          mode: before.mode,
        });
        expect(changed.mtimeNs).not.toBe(before.mtimeNs);
      }
    });
    await expect(f.copy()).rejects.toThrow("changed after snapshot inventory");
    expect(mutated).toBe(true);
    expect(await fs.readdir(f.destination)).toEqual([]);
  },
);

it("drains concurrent file copies before reporting a failure or publishing links", async () => {
  const f = await fixture(false, async (source) => {
    for (let index = 0; index < 7; index++) {
      await fs.writeFile(path.join(source, `extra-${index}.txt`), `plugin bytes ${index}`);
    }
    await fs.symlink("payload.txt", path.join(source, "payload-link"), "file");
  });
  const peerEntered = createDeferredCore();
  const releasePeers = createDeferredCore();
  const firstFailure = createDeferredCore<unknown>();
  const started: string[] = [];
  const settled = new Set<string>();
  const inFlight: Promise<void>[] = [];
  let settledAtRejection: string[] = [];
  const openRoot = fsSafe.root;
  vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
    const root = await openRoot(...args);
    const copyIn = root.copyIn.bind(root);
    vi.spyOn(root, "copyIn").mockImplementation((relative, source, options) => {
      const first = started.length === 0;
      started.push(relative);
      if (started.length === 2) {
        peerEntered.resolve();
      }
      const copying = (async () => {
        try {
          await peerEntered.promise;
          if (first) {
            await fs.writeFile(
              path.join(f.destination, path.basename(relative)),
              "existing bytes",
              {
                flag: "wx",
              },
            );
          } else {
            await releasePeers.promise;
          }
          await copyIn(relative, source, options);
          if (first) {
            throw new Error("Expected the real copy to reject its occupied destination");
          }
        } catch (error) {
          if (first) {
            firstFailure.resolve(error);
          }
          throw error;
        } finally {
          settled.add(relative);
        }
      })();
      inFlight.push(copying);
      return copying;
    });
    return root;
  });
  const copying = f.copy().catch((error: unknown) => {
    settledAtRejection = [...settled];
    return error;
  });
  try {
    const failure = await Promise.race([firstFailure.promise, copying]);
    releasePeers.resolve();
    expect(await copying).toBe(failure);
    expect(failure).toMatchObject({ code: "already-exists" });
    expect(started.length).toBeGreaterThan(1);
    expect(started.length).toBeLessThanOrEqual(4);
    expect(settledAtRejection.toSorted()).toEqual(started.toSorted());
    expect((await fs.readdir(f.destination)).toSorted()).toEqual(
      started.map((file) => path.basename(file)).toSorted(),
    );
    expect(await fs.readFile(path.join(f.destination, path.basename(started[0]!)), "utf8")).toBe(
      "existing bytes",
    );
  } finally {
    peerEntered.resolve();
    releasePeers.resolve();
    await Promise.allSettled(inFlight);
    await copying;
  }
});

it.each(["inventory", "bindings", "admission", "completion", "verification"] as const)(
  "settles bounded %s reads before a metadata failure reaches cleanup",
  async (phase) => {
    const peerEntered = createDeferredCore();
    const releasePeers = createDeferredCore();
    const failure = new Error("plugin metadata unavailable");
    const started: string[] = [];
    let active = 0;
    let maximum = 0;
    let activeAtRejection: number | undefined;
    let selectedDirectory = "";
    let enabled = phase === "inventory" || phase === "bindings" || phase === "admission";
    const intercept = async <T>(file: unknown, read: () => Promise<T>): Promise<T> => {
      if (
        !enabled ||
        typeof file !== "string" ||
        path.dirname(file) !== selectedDirectory ||
        !path.basename(file).startsWith("read-")
      ) {
        return await read();
      }
      started.push(file);
      active += 1;
      maximum = Math.max(maximum, active);
      try {
        if (started.length === 1) {
          await read();
          throw failure;
        }
        peerEntered.resolve();
        await releasePeers.promise;
        return await read();
      } finally {
        active -= 1;
      }
    };
    const installReadSpy = () => {
      if (phase === "bindings") {
        const realpath = fs.realpath;
        vi.spyOn(fs, "realpath").mockImplementation((...args) =>
          intercept(args[0], () => realpath(...args)),
        );
      } else {
        const lstat = fs.lstat;
        vi.spyOn(fs, "lstat").mockImplementation((...args) =>
          intercept(args[0], () => lstat(...args)),
        );
      }
    };
    const preparing = fixture(false, async (source) => {
      selectedDirectory = source;
      for (let index = 0; index < 9; index += 1) {
        const file = path.join(source, `read-${index}.txt`);
        if (phase === "bindings") {
          await fs.symlink("payload.txt", file);
        } else {
          await fs.writeFile(file, `plugin payload ${index}`);
        }
      }
      if (phase === "completion") {
        await fs.symlink("payload.txt", path.join(source, "copy-complete"));
      }
      if (phase === "inventory") {
        installReadSpy();
      }
    });
    const operation = (async () => {
      const f = await preparing;
      if (phase !== "inventory") {
        installReadSpy();
      }
      if (phase === "completion") {
        const symlink = fs.symlink;
        vi.spyOn(fs, "symlink").mockImplementation(async (...args) => {
          const result = await symlink(...args);
          if (args[1] === path.join(f.destination, "copy-complete")) {
            enabled = true;
          }
          return result;
        });
      } else if (phase === "verification") {
        selectedDirectory = f.destination;
        const readdir = fs.readdir;
        vi.spyOn(fs, "readdir").mockImplementation((...args) => {
          if (args[0] === f.destination) {
            enabled = true;
          }
          return readdir(...args);
        });
      }
      await f.copy();
    })().catch((error: unknown) => {
      activeAtRejection = active;
      return error;
    });
    try {
      await awaitGateBeforeSettlement(
        peerEntered.promise,
        operation,
        "metadata reads did not overlap before rejection",
      );
      expect(activeAtRejection).toBeUndefined();
      releasePeers.resolve();
      expect(await operation).toBe(failure);
      expect(activeAtRejection).toBe(0);
      expect(started.length).toBeGreaterThan(1);
      expect(maximum).toBeLessThanOrEqual(4);
    } finally {
      releasePeers.resolve();
      await operation;
    }
  },
);

it("copies a linked workspace dependency without reading or changing Git update transactions", async () => {
  let dependency = "";
  let abandoned = "";
  let rollback = "";
  const sdkLink = "../../../../packages/plugin-sdk";
  const required = "store.openclaw-update-00000000-0000-4000-8000-000000000011.tmp";
  const f = await fixture(false, async (source) => {
    const workspace = path.join(path.dirname(source), "workspace");
    dependency = path.join(workspace, "extensions", "a2a");
    const sdk = path.join(workspace, "packages", "plugin-sdk");
    await fs.mkdir(path.join(dependency, "node_modules", "@openclaw"), { recursive: true });
    await fs.mkdir(sdk, { recursive: true });
    await fs.writeFile(path.join(sdk, "package.json"), '{"name":"@openclaw/plugin-sdk"}');
    await fs.writeFile(path.join(dependency, "package.json"), '{"name":"workspace-dependency"}');
    await fs.writeFile(path.join(dependency, "data.txt"), "live dependency");
    await fs.symlink(sdkLink, path.join(dependency, "node_modules", "@openclaw", "plugin-sdk"));
    await fs.mkdir(path.join(source, "node_modules"));
    await fs.symlink(
      dependency,
      path.join(source, "node_modules", "workspace-dependency"),
      "junction",
    );

    // Promotion links describe the final destination, not the intermediate candidate directory.
    abandoned = path.join(
      dependency,
      "node_modules.openclaw-update-00000000-0000-4000-8000-000000000009.tmp",
    );
    const stagedSdk = path.join(abandoned, "candidate", "@openclaw", "plugin-sdk");
    await fs.mkdir(path.dirname(stagedSdk), { recursive: true });
    await fs.symlink(sdkLink, stagedSdk);
    rollback = path.join(
      dependency,
      "dist.openclaw-update-00000000-0000-4000-8000-000000000010.tmp",
    );
    await fs.mkdir(path.join(rollback, "previous"), { recursive: true });
    await fs.writeFile(path.join(rollback, "previous", "keep.txt"), "rollback bytes");
    await fs.mkdir(path.join(dependency, "ordinary.tmp"));
    await fs.writeFile(path.join(dependency, "ordinary.tmp", "asset.txt"), "plugin asset");
    await fs.mkdir(path.join(source, required));
    await fs.writeFile(path.join(source, required, "required.txt"), "explicit dependency");
    await fs.symlink(path.join(required, "required.txt"), path.join(source, "required.txt"));
  });
  await f.copy();
  expect(await fs.readFile(path.join(f.destination, "required.txt"), "utf8")).toBe(
    "explicit dependency",
  );
  const copied = path.join(f.destination, "node_modules", "workspace-dependency");
  expect(await fs.readFile(path.join(copied, "data.txt"), "utf8")).toBe("live dependency");
  expect(await fs.readFile(path.join(copied, "ordinary.tmp", "asset.txt"), "utf8")).toBe(
    "plugin asset",
  );
  expect(await fs.readdir(copied)).not.toContain(path.basename(abandoned));
  expect(await fs.readdir(copied)).not.toContain(path.basename(rollback));
  expect(await fs.readlink(path.join(abandoned, "candidate", "@openclaw", "plugin-sdk"))).toBe(
    sdkLink,
  );
  expect(await fs.readFile(path.join(rollback, "previous", "keep.txt"), "utf8")).toBe(
    "rollback bytes",
  );
  await fs.writeFile(path.join(copied, "data.txt"), "private candidate data");
  expect(await fs.readFile(path.join(dependency, "data.txt"), "utf8")).toBe("live dependency");
});

it.each(["ordinary.tmp", "node_modules.openclaw-update-operator.tmp"])(
  "still rejects a missing dependency beneath %s",
  async (directory) => {
    await expect(
      fixture(false, async (source) => {
        const nested = path.join(source, directory);
        await fs.mkdir(nested);
        await fs.symlink(
          path.join(path.dirname(source), "missing-dependency"),
          path.join(nested, "required"),
        );
      }),
    ).rejects.toThrow("Cannot privately copy plugin dependency");
  },
);
