import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { afterEach, expect, it, vi } from "vitest";
import {
  copyWorkerNativeArchiveCache,
  prepareWorkerDarwinNativeAssets,
} from "../../scripts/lib/fs-safe-worker-native-assets.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const root = await fs.realpath(temp.make("native-archives-"));
  const snapshot = await fs.realpath(temp.make("native-snapshot-"));
  const packageDir = path.join(root, "package");
  await fs.mkdir(packageDir);
  await fs.writeFile(path.join(packageDir, "fs-safe-native.node"), "synthetic-addon");
  const chunks: Buffer[] = [];
  for await (const chunk of tar.create({ cwd: root, gzip: true }, [
    "package/fs-safe-native.node",
  ])) {
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
  const digest = createHash("sha256").update(integrity).digest("hex");
  const targets = ["darwin-arm64", "darwin-x64"];
  const names = targets.map((target) => "@openclaw/fs-safe-" + target);
  const filenames = targets.map((target) => `${target}-1.2.3-${digest}.tgz`);
  const cache = path.join(root, ".artifacts/worker-native-assets");
  await fs.mkdir(cache, { recursive: true });
  for (const filename of filenames) {
    await fs.writeFile(path.join(cache, filename), bytes);
  }
  const manifest = path.join(root, "manifest.json");
  await fs.writeFile(
    manifest,
    JSON.stringify({
      optionalDependencies: Object.fromEntries(names.map((name) => [name, "1.2.3"])),
    }),
  );
  await fs.writeFile(
    path.join(snapshot, "pnpm-lock.yaml"),
    JSON.stringify({
      packages: Object.fromEntries(
        names.map((name) => [name + "@1.2.3", { resolution: { integrity } }]),
      ),
    }),
  );
  const fetch = vi.fn(() => {
    throw new Error("Offline input must not fetch");
  });
  vi.stubGlobal("fetch", fetch);
  return {
    root,
    snapshot,
    cache,
    manifest,
    filenames,
    fetch,
    copy: () => copyWorkerNativeArchiveCache(root, snapshot, manifest),
  };
}

it("copies only pinned public archives usable offline", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.cache, "unrelated-private.tgz"), "must not copy");
  await f.copy();
  expect(
    (await fs.readdir(path.join(f.snapshot, ".artifacts/worker-native-assets"))).toSorted(),
  ).toEqual(f.filenames.toSorted());
  const assets = await prepareWorkerDarwinNativeAssets(f.snapshot, f.manifest);
  expect(assets.map((asset) => asset.source.toString())).toEqual([
    "synthetic-addon",
    "synthetic-addon",
  ]);
  expect(f.fetch).not.toHaveBeenCalled();
});

it("rejects tampered native bytes before copying or fetching", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.cache, f.filenames[0]!), "not the pinned archive");
  await expect(f.copy()).rejects.toThrow("integrity mismatch");
  await expect(fs.stat(path.join(f.snapshot, ".artifacts"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(f.fetch).not.toHaveBeenCalled();
});
