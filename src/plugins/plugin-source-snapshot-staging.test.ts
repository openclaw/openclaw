import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { acquireSqliteStagingToken } from "../infra/sqlite-staging-token.js";
import { capturePluginSourceSnapshot } from "./plugin-generation-capture.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import { prunePluginNativeCaptureDirectories } from "./plugin-source-capture-directory.js";
import { resolvePluginSourceCapturesDirectory } from "./plugin-source-capture-path.js";
import {
  acquirePluginSourceSnapshot,
  pluginSourceSnapshotClosureDigest,
  stagePluginSourceSnapshot,
} from "./plugin-source-snapshot-artifact.js";
import { pluginProcessRuntimeEntrypoints } from "./process-runtime.test-support.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

it("reclaims an interrupted snapshot publisher only after its token releases", async () => {
  const stateDir = temp.make("snapshot-staging-");
  const source = path.join(stateDir, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "package.json"),
    '{"name":"staging-fixture","main":"index.cjs"}',
  );
  fs.writeFileSync(path.join(source, "index.cjs"), "exports.value = 1;");
  const artifact = resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.sourceSnapshot);
  const capture = resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.sourceCapture);
  const child = spawn(
    process.execPath,
    [
      ...resolveRuntimeWorkerArgv(artifact).slice(0, -1),
      "--input-type=module",
      "-e",
      `import { capturePluginSourceSnapshot } from ${JSON.stringify(capture.href)};
     import { stagePluginSourceSnapshot, pluginSourceSnapshotClosureDigest } from ${JSON.stringify(artifact.href)};
     process.stdin.resume();
     process.env.OPENCLAW_STATE_DIR = process.argv[1];
     const capture = capturePluginSourceSnapshot(process.argv[2]);
     let checks = 0;
     await stagePluginSourceSnapshot({stateDir: process.argv[1], capture,
       binding: {installRecordHash:"record", contentDigest:capture.sourceDigest,
         dependencyClosureDigest:pluginSourceSnapshotClosureDigest(capture), buildResolutionDigest:"options"},
       assertCurrent: async () => { if (++checks === 2) { process.stdout.write("staged\\n"); await new Promise(() => {}); } }
     }).then((staged) => staged.publish());`,
      stateDir,
      source,
    ],
    { stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 },
  );
  const exited = once(child, "close");
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await exited;
    lines.close();
  };
  cleanups.push(stop);
  expect(await lines[Symbol.asyncIterator]().next(), stderr).toEqual({
    value: "staged",
    done: false,
  });
  const parent = resolvePluginSourceCapturesDirectory(stateDir);
  const stage = path.join(
    parent,
    fs.readdirSync(parent).find((name) => name.startsWith("snapshot-v1-staging-"))!,
  );
  const published = path.join(parent, "snapshot-v1-published-control");
  fs.mkdirSync(published, { mode: 0o700 });
  acquireSqliteStagingToken(published, "create")();
  const prune = () =>
    prunePluginNativeCaptureDirectories(stateDir, new Set(), () => {}, { startup: true });
  await prune();
  expect(fs.existsSync(stage)).toBe(true);
  await stop();
  expect(fs.existsSync(path.join(stage, "payload"))).toBe(true);
  const external = path.join(stateDir, "external");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "sentinel"), "outside the stage");
  fs.symlinkSync(external, path.join(stage, "payload", "external"), "junction");
  await prune();
  expect(fs.existsSync(stage)).toBe(false);
  expect(fs.existsSync(published)).toBe(true);
  expect(fs.readFileSync(path.join(external, "sentinel"), "utf8")).toBe("outside the stage");
});

it("retains tokenless snapshot stages even after the capture grace period", async () => {
  const stateDir = temp.make("snapshot-tokenless-");
  const stage = path.join(
    resolvePluginSourceCapturesDirectory(stateDir),
    "snapshot-v1-staging-unowned",
  );
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stage, "sentinel"), "no custody token");
  const old = new Date(Date.now() - 2 * 60 * 60 * 1_000);
  fs.utimesSync(stage, old, old);
  await prunePluginNativeCaptureDirectories(stateDir, new Set(), () => {}, { startup: true });
  expect(fs.readFileSync(path.join(stage, "sentinel"), "utf8")).toBe("no custody token");
});

it("never acquires a staging namespace even with a complete valid receipt", async () => {
  const stateDir = temp.make("snapshot-stage-admission-");
  const source = path.join(stateDir, "source");
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "package.json"),
    '{"name":"stage-admission","main":"index.cjs"}',
  );
  fs.writeFileSync(path.join(source, "index.cjs"), "exports.value = 1;");
  const capture = withPluginSourceCaptureStorage({ stateDir, placement: "state" }, () =>
    capturePluginSourceSnapshot(source),
  );
  try {
    const published = await stagePluginSourceSnapshot({
      stateDir,
      capture,
      binding: {
        installRecordHash: "record",
        contentDigest: capture.sourceDigest,
        dependencyClosureDigest: pluginSourceSnapshotClosureDigest(capture),
        buildResolutionDigest: "options",
      },
      assertCurrent() {},
    }).then((staged) => staged.publish());
    const stage = path.join(path.dirname(published.artifact.path), "snapshot-v1-staging-complete");
    fs.renameSync(published.artifact.path, stage);
    const descriptor = {
      ...published,
      installedRevision: 1,
      artifact: { ...published.artifact, path: stage },
    };
    await expect(
      acquirePluginSourceSnapshot({ stateDir, descriptor, assertCurrent() {} }).then((reader) =>
        reader.release(),
      ),
    ).rejects.toThrow("unfinished snapshot staging namespace");
  } finally {
    await capture.disposeAsync();
  }
});
