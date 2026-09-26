import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as fsSafe from "./fs-safe.js";
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

function atCopyMutation(mutate: () => void) {
  const openRoot = fsSafe.root;
  vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
    const root = await openRoot(...args);
    const copyIn = root.copyIn.bind(root);
    vi.spyOn(root, "copyIn").mockImplementation((relative, source, options) =>
      copyIn(relative, source, {
        ...options,
        assertBeforeMutation: () => {
          mutate();
          options?.assertBeforeMutation?.();
        },
      }),
    );
    return root;
  });
}

it("copies a nonempty plugin without native support or sharing its source inode", async () => {
  const f = await fixture(true);
  const linked = `${f.file}.linked`;
  const before = await fs.stat(f.file, { bigint: true });
  vi.stubEnv("FS_SAFE_NATIVE_MODE", "off");
  try {
    // FreeBSD has no fs-safe native binding. Exercise its real portable backend.
    expect(getFsSafeNativeConfig().mode).toBe("off");
    await f.copy();
  } finally {
    vi.unstubAllEnvs();
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
  expect(await fs.readdir(f.destination)).toEqual(["payload.txt", "payload.txt.linked"]);
});

it.each(["file", "symlink"] as const)(
  "preserves a %s that appears after missing-entry planning and cleans copy staging",
  async (kind) => {
    const f = await fixture();
    const target = path.join(f.destination, "payload.txt");
    let inserted = false;
    atCopyMutation(() => {
      if (inserted) {
        return;
      }
      inserted = true;
      if (kind === "file") {
        fsSync.writeFileSync(target, "existing private bytes", { flag: "wx" });
      } else {
        fsSync.symlinkSync(f.file, target);
      }
    });
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
    atCopyMutation(() => {
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

it("copies a linked workspace dependency without reading or changing Git update transactions", async () => {
  let dependency = "";
  let abandoned = "";
  let rollback = "";
  const sdkLink = "../../../../packages/plugin-sdk";
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
  });
  await f.copy();
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

it("retains explicitly linked inputs inside a Git transaction namespace", async () => {
  const name = "store.openclaw-update-00000000-0000-4000-8000-000000000011.tmp";
  const f = await fixture(false, async (source) => {
    await fs.mkdir(path.join(source, name));
    await fs.writeFile(path.join(source, name, "required.txt"), "explicit dependency");
    await fs.symlink(path.join(name, "required.txt"), path.join(source, "required.txt"));
  });
  await f.copy();
  expect(await fs.readFile(path.join(f.destination, "required.txt"), "utf8")).toBe(
    "explicit dependency",
  );
});
