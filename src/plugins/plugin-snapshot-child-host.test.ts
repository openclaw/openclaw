import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { capturePluginSourceSnapshot } from "./plugin-generation-capture.js";
import { createPluginSnapshotChildHost } from "./plugin-snapshot-child-host.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import {
  acquirePluginSharedSourceSnapshot,
  collectPluginSourceSnapshots,
  pluginSourceSnapshotClosureDigest,
  stagePluginSharedSourceSnapshot,
} from "./plugin-source-snapshot-artifact.js";
import { createPluginSharedSnapshotModuleLoader } from "./plugin-source-snapshot-loader.js";

const temporary = createTempDirTracker();
const releases: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const release of releases.splice(0).toReversed()) {
    await release();
  }
  temporary.cleanup();
});

async function fixture() {
  const stateDir = temporary.make("snapshot-children-");
  const root = path.join(stateDir, "installed");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(root, "dependency.cjs"), "exports.value = 'verified';");
  fs.writeFileSync(path.join(root, "preload.cjs"), "globalThis.preloadValue = 'verified-preload';");
  fs.writeFileSync(
    path.join(root, "child.cjs"),
    `
    const {parentPort, workerData} = require('node:worker_threads');
    const value = require('./dependency.cjs').value;
    const result = {value, data: workerData, filename: __filename, main: require.main === module, preload: globalThis.preloadValue, argv: process.argv.slice(2)};
    if (parentPort) parentPort.postMessage(result);
    else process.send(result);
  `,
  );
  fs.writeFileSync(
    path.join(root, "child.mjs"),
    `
    import {parentPort, workerData} from 'node:worker_threads';
    import dependency from './dependency.cjs';
    const result = {value: dependency.value, data: workerData, filename: import.meta.filename, main: import.meta.main, preload: globalThis.preloadValue, argv: process.argv.slice(2)};
    if (parentPort) parentPort.postMessage(result);
    else process.send(result);
  `,
  );
  const capture = withPluginSourceCaptureStorage({ stateDir, placement: "state" }, () =>
    capturePluginSourceSnapshot(root),
  );
  releases.push(capture.disposeAsync);
  const pending = await stagePluginSharedSourceSnapshot({
    stateDir,
    capture,
    assertCurrent() {},
    binding: {
      installRecordHash: "record",
      contentDigest: capture.sourceDigest,
      dependencyClosureDigest: pluginSourceSnapshotClosureDigest(capture),
      buildResolutionDigest: "resolution",
    },
  });
  const descriptor = { ...(await pending.publish()), installedRevision: 1 };
  releases.push(async () => {
    await collectPluginSourceSnapshots({
      stateDir,
      retiredSnapshots: [descriptor],
      retainedPaths: new Set(),
      assertCurrent() {},
    });
  });
  const snapshot = await acquirePluginSharedSourceSnapshot({
    stateDir,
    descriptor,
    assertCurrent() {},
  });
  releases.push(() => snapshot.release());
  const warnings: Array<{ artifactPath: string; message: string }> = [];
  const host = createPluginSnapshotChildHost({
    snapshot,
    onInvalidSnapshot: (failure) => {
      warnings.push(failure);
    },
  });
  releases.push(() => host.disposeAsync());
  const loader = createPluginSharedSnapshotModuleLoader({
    snapshot,
    loadBuiltin: (specifier) => host.loadBuiltin(specifier),
    loadNativeModule() {
      throw new Error("fixture does not contain native files");
    },
  });
  releases.push(() => loader.dispose());
  const require = loader.requireFor(path.join(snapshot.rootDir, "controller.cjs"));
  const { Worker } = require("node:worker_threads") as typeof import("node:worker_threads");
  const { fork } = require("node:child_process") as typeof import("node:child_process");
  const launch = (kind: "worker" | "fork", filename: string, preload = false) => {
    const entry = path.join(snapshot.rootDir, filename);
    const execArgv = preload ? ["--require", path.join(snapshot.rootDir, "preload.cjs")] : [];
    const child =
      kind === "worker"
        ? new Worker(entry, { workerData: { marker: "payload" }, argv: [7, false], execArgv })
        : fork(entry, ["user-argument"], { silent: true, execArgv });
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code) {
          reject(new Error(`child exit ${code}: ${stderr}`));
        }
      });
    });
  };
  return { snapshot, descriptor, stateDir, launch, host, warnings };
}

it.each(["child.cjs", "child.mjs"])(
  "verifies %s in independent workers and forks",
  async (filename) => {
    const subject = await fixture();
    for (const kind of ["worker", "fork"] as const) {
      const result = await subject.launch(kind, filename);
      expect(result.value).toBe("verified");
      expect(result.filename).toBe(path.join(subject.snapshot.rootDir, filename));
      expect(result.main).toBe(true);
      if (kind === "worker") {
        expect(result.data).toEqual({ marker: "payload" });
        expect(result.argv).toEqual(["7", "false"]);
      }
    }
    const dependency = path.join(subject.snapshot.rootDir, "dependency.cjs");
    fs.chmodSync(dependency, 0o600);
    fs.writeFileSync(dependency, "exports.value = 'tampered';");
    for (const kind of ["worker", "fork"] as const) {
      await expect(subject.launch(kind, filename)).rejects.toThrow(/dependency.cjs/);
    }
    expect(subject.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactPath: subject.descriptor.artifact.path,
          message: expect.stringContaining("dependency.cjs"),
        }),
      ]),
    );
    await subject.host.disposeAsync();
    subject.snapshot.release();
    expect(
      (
        await collectPluginSourceSnapshots({
          stateDir: subject.stateDir,
          retiredSnapshots: [subject.descriptor],
          retainedPaths: new Set(),
          assertCurrent() {},
        })
      ).removed,
    ).toEqual([subject.descriptor.artifact.path]);
  },
  30_000,
);

it("installs verification before user preloads", async () => {
  const subject = await fixture();
  for (const kind of ["worker", "fork"] as const) {
    expect((await subject.launch(kind, "child.cjs", true)).preload).toBe("verified-preload");
  }
  const preload = path.join(subject.snapshot.rootDir, "preload.cjs");
  fs.chmodSync(preload, 0o600);
  fs.writeFileSync(preload, "globalThis.preloadValue = 'tampered';");
  for (const kind of ["worker", "fork"] as const) {
    await expect(subject.launch(kind, "child.cjs", true)).rejects.toThrow(/preload.cjs/);
  }
}, 30_000);
