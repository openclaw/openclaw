import fs from "node:fs";
import path from "node:path";
import * as fsSafe from "@openclaw/fs-safe/advanced";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  capturePluginSnapshotGeneration,
  capturePluginSourceSnapshot,
} from "./plugin-generation-capture.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import {
  acquirePluginSharedSourceSnapshot,
  acquirePluginSharedSourceSnapshotSync,
  acquirePluginSourceSnapshot,
  collectPluginSourceSnapshots,
  pluginSourceSnapshotClosureDigest,
  stagePluginSharedSourceSnapshot,
  stagePluginSourceSnapshot,
} from "./plugin-source-snapshot-artifact.js";

vi.mock("@openclaw/fs-safe/advanced", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/advanced")>()),
}));

const temporary = createTempDirTracker();
const collectors: Array<() => Promise<unknown>> = [];
const releases: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const release of releases.splice(0).toReversed()) {
    await release();
  }
  for (const collect of collectors.splice(0)) {
    await collect();
  }
  temporary.cleanup();
});
const assertCurrent = () => {};
async function fixture(options: { files?: number; shared?: boolean; large?: boolean } = {}) {
  const stateDir = temporary.make("snapshot-shared-");
  const source = path.join(stateDir, "installed");
  fs.mkdirSync(path.join(source, "assets"), { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(source, "index.mjs"), "export const value = 1;");
  fs.writeFileSync(path.join(source, "helper.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.writeFileSync(path.join(source, "empty.txt"), "");
  fs.writeFileSync(path.join(source, "tsconfig.json"), '{"extends":"./base.json"}');
  fs.writeFileSync(path.join(source, "base.json"), '{"compilerOptions":{"baseUrl":"."}}');
  for (let index = 0; index < (options.files ?? 1); index++) {
    fs.writeFileSync(
      path.join(source, "assets", `${index}.txt`),
      options.large ? "x".repeat(128 * 1024) : "asset",
    );
  }
  const capture = withPluginSourceCaptureStorage({ stateDir, placement: "state" }, () =>
    capturePluginSourceSnapshot(source),
  );
  releases.push(() => capture.disposeAsync());
  const stage =
    options.shared === false ? stagePluginSourceSnapshot : stagePluginSharedSourceSnapshot;
  const descriptor = {
    ...(await stage({
      stateDir,
      capture,
      assertCurrent,
      binding: {
        installRecordHash: "record",
        contentDigest: capture.sourceDigest,
        dependencyClosureDigest: pluginSourceSnapshotClosureDigest(capture),
        buildResolutionDigest: "resolution",
      },
    }).then((pending) => pending.publish())),
    installedRevision: 1,
  };
  const acquire = () => acquirePluginSharedSourceSnapshot({ stateDir, descriptor, assertCurrent });
  const collect = () =>
    collectPluginSourceSnapshots({
      stateDir,
      retiredSnapshots: [descriptor],
      retainedPaths: new Set(),
      assertCurrent,
    });
  collectors.push(collect);
  return { stateDir, descriptor, acquire, collect };
}

it("keeps shared startup filesystem counts independent of unused file count", async () => {
  const small = await fixture({ files: 1 });
  const large = await fixture({ files: 180 });
  const measure = async (subject: typeof small, sync: boolean) => {
    const counters = ["openSync", "lstatSync", "fstatSync", "readSync", "readdirSync"] as const;
    const spies = counters.map((name) => vi.spyOn(fs, name));
    const reader = sync
      ? acquirePluginSharedSourceSnapshotSync({ ...subject, assertCurrent })
      : await subject.acquire();
    reader.assertCurrent();
    reader.assertCurrent();
    const counts = spies.map((spy) => spy.mock.calls.length);
    spies.forEach((spy) => spy.mockRestore());
    releases.push(() => reader.release());
    expect(reader.readVerifiedFile(path.join(reader.rootDir, "index.mjs")).toString()).toContain(
      "value = 1",
    );
    expect(reader.resolution.get(reader.rootDir)).toBe('{"type":"module"}');
    expect(reader.configuration.has(path.join(reader.rootDir, "tsconfig.json"))).toBe(true);
    expect(reader.configuration.has(path.join(reader.rootDir, "base.json"))).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(reader.rootDir).mode & 0o222).toBe(0);
    }
    return counts;
  };
  for (const sync of [false, true]) {
    expect(await measure(large, sync)).toEqual(await measure(small, sync));
  }
});

it.each(["native", "fallback"] as const)(
  "settles %s batch descriptors through publication, reading, and scrub shutdown",
  async (mode) => {
    const createBatch = fsSafe.createRootFileOpenBatchSync;
    const closeFd = fs.closeSync.bind(fs);
    const active = new Set<number>();
    const records: Array<{ closeCalls: number }> = [];
    let rawCloses = 0;
    vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
      if (active.delete(fd)) {
        rawCloses++;
      }
      closeFd(fd);
    });
    vi.spyOn(fsSafe, "createRootFileOpenBatchSync").mockImplementation(() => {
      const batch = createBatch();
      return {
        ...batch,
        openFile(params) {
          const opened =
            mode === "native" ? batch.openFile(params) : fsSafe.openRootFileSync(params);
          if (!opened.ok) {
            return opened;
          }
          const record = { closeCalls: 0 };
          records.push(record);
          active.add(opened.fd);
          const owned: typeof opened & { close?: () => void } = opened;
          return mode === "fallback"
            ? opened
            : {
                ...opened,
                close() {
                  record.closeCalls++;
                  active.delete(opened.fd);
                  if (owned.close) {
                    owned.close();
                  } else {
                    closeFd(opened.fd);
                  }
                },
              };
        },
      };
    });
    const subject = await fixture({ large: true });
    const reader = await subject.acquire();
    releases.push(() => reader.release());
    const entry = path.join(reader.rootDir, "index.mjs");
    expect(reader.readVerifiedFile(entry).toString()).toContain("value = 1");
    const read = fs.readSync;
    const readFailure = vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      if (active.has(args[0])) {
        throw new Error("descriptor read failed");
      }
      return Reflect.apply(read, fs, args);
    });
    expect(() => reader.readVerifiedFile(entry)).toThrow("descriptor read failed");
    readFailure.mockRestore();
    const fstat = fs.fstatSync;
    const statFailure = vi.spyOn(fs, "fstatSync").mockImplementation((...args) => {
      if (active.has(args[0])) {
        throw new Error("descriptor identity failed");
      }
      return Reflect.apply(fstat, fs, args);
    });
    expect(() => reader.readVerifiedFile(entry)).toThrow("descriptor identity failed");
    statFailure.mockRestore();
    const complete = reader.createScrub();
    while (!(await complete.step({ maxFiles: 16, maxBytes: 256 * 1024 })).done) {}
    const cancelled = reader.createScrub();
    while (active.size === 0) {
      expect((await cancelled.step({ maxFiles: 1, maxBytes: 1 })).done).toBe(false);
    }
    const abort = new AbortController();
    abort.abort(new Error("shutdown"));
    await expect(
      cancelled.step({ maxFiles: 1, maxBytes: 1, signal: abort.signal }),
    ).rejects.toThrow("shutdown");
    expect(active.size).toBe(0);
    expect(records.length).toBeGreaterThan(10);
    expect(rawCloses).toBe(mode === "fallback" ? records.length : 0);
    expect(records.map((record) => record.closeCalls)).toEqual(
      records.map(() => (mode === "native" ? 1 : 0)),
    );
  },
);

it("releases synchronous child custody if authority is lost after manifest validation", async () => {
  const subject = await fixture();
  const lost = new Error("installation changed");
  const revokedAuthority = vi
    .fn()
    .mockImplementationOnce(() => {})
    .mockImplementation(() => {
      throw lost;
    });
  expect(() =>
    acquirePluginSharedSourceSnapshotSync({ ...subject, assertCurrent: revokedAuthority }),
  ).toThrow(lost);
  expect(revokedAuthority).toHaveBeenCalledTimes(2);
  expect((await subject.collect()).removed).toEqual([subject.descriptor.artifact.path]);
});

it("defers unused corruption to scrub and rejects changed used bytes before returning them", async () => {
  const subject = await fixture();
  const initial = await subject.acquire();
  const asset = path.join(initial.rootDir, "assets", "0.txt");
  fs.chmodSync(asset, 0o600);
  fs.writeFileSync(asset, "changed");
  initial.release();
  const reader = await subject.acquire();
  releases.push(() => reader.release());
  const used = path.join(reader.rootDir, "index.mjs");
  expect(reader.readVerifiedFile(used).toString()).toContain("value = 1");
  const scrub = reader.createScrub();
  await expect(
    (async () => {
      while (!(await scrub.step({ maxFiles: 2, maxBytes: 16 })).done) {}
    })(),
  ).rejects.toThrow(asset);
  fs.chmodSync(used, 0o600);
  fs.writeFileSync(used, "export const value = 2;");
  expect(() => reader.readVerifiedFile(used)).toThrow(used);
  await expect(acquirePluginSourceSnapshot({ ...subject, assertCurrent })).rejects.toThrow(
    /payload/,
  );
});

it("bounds a large-file scrub, holds its reader, and releases all pins on cancellation", async () => {
  const subject = await fixture({ large: true });
  const reader = await subject.acquire();
  const scrub = reader.createScrub();
  reader.release();
  for (let index = 0; index < 4; index++) {
    const report = await scrub.step({ maxFiles: 2, maxBytes: 31 });
    expect(report.bytes).toBeLessThanOrEqual(31);
    expect(report.entries).toBeLessThanOrEqual(2);
    expect(report.done).toBe(false);
  }
  expect((await subject.collect()).removed).toEqual([]);
  const controller = new AbortController();
  controller.abort(new Error("shutdown"));
  await expect(
    scrub.step({ maxFiles: 2, maxBytes: 31, signal: controller.signal }),
  ).rejects.toThrow("shutdown");
  expect((await subject.collect()).removed).toEqual([subject.descriptor.artifact.path]);
});

it("separates incompatible old format from corrupt shared format and preserves full v1 validation", async () => {
  const legacy = await fixture({ shared: false });
  await expect(legacy.acquire()).rejects.toMatchObject({
    code: "PLUGIN_SOURCE_SNAPSHOT_INCOMPATIBLE",
    artifactPath: legacy.descriptor.artifact.path,
  });
  const reader = await acquirePluginSourceSnapshot({ ...legacy, assertCurrent });
  const filename = path.join(reader.rootDir, "index.mjs");
  reader.release();
  fs.writeFileSync(filename, "changed");
  await expect(acquirePluginSourceSnapshot({ ...legacy, assertCurrent })).rejects.toMatchObject({
    code: "PLUGIN_SOURCE_SNAPSHOT_INVALID",
  });
  const shared = await fixture();
  fs.writeFileSync(path.join(shared.descriptor.artifact.path, "manifest.json"), "{}");
  await expect(shared.acquire()).rejects.toMatchObject({ code: "PLUGIN_SOURCE_SNAPSHOT_INVALID" });
});

it("restores original normalized modes when a shared source needs private capture", async () => {
  const subject = await fixture();
  const reader = await subject.acquire();
  releases.push(() => reader.release());
  expect(reader.readVerifiedFile(path.join(reader.rootDir, "empty.txt"))).toHaveLength(0);
  const privateCapture = withPluginSourceCaptureStorage(
    { stateDir: subject.stateDir, placement: "state" },
    () => capturePluginSnapshotGeneration(reader),
  );
  releases.push(privateCapture.disposeAsync);
  expect(privateCapture.sourceDigest).toBe(subject.descriptor.contentDigest);
  if (process.platform !== "win32") {
    expect(fs.statSync(path.join(reader.rootDir, "helper.sh")).mode & 0o777).toBe(0o500);
    expect(fs.statSync(path.join(privateCapture.rootDir, "helper.sh")).mode & 0o777).toBe(0o700);
  }
});

it("retirement does not follow a foreign subtree link", async () => {
  const subject = await fixture();
  const outside = temporary.make("snapshot-outside-");
  const sentinel = path.join(outside, "keep.txt");
  fs.writeFileSync(sentinel, "keep");
  fs.symlinkSync(outside, path.join(subject.descriptor.artifact.path, "foreign"), "junction");
  expect((await subject.collect()).removed).toEqual([subject.descriptor.artifact.path]);
  expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
});
