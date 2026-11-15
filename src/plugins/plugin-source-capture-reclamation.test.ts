import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { acquireSqliteStagingToken } from "../infra/sqlite-staging-token.js";
import * as command from "../process/exec-runner.js";
import { observeMainThreadFs } from "../test-utils/main-thread-fs-spies.test-support.js";
import {
  isPluginSourceCaptureRetained,
  retainPluginNativeCapturePath,
} from "./plugin-source-capture-directory.js";
import {
  interceptPluginCaptureReclamation,
  sweepPluginSourceCapturesForTest,
} from "./plugin-source-capture-directory.test-support.js";

const temp = createTempDirTracker();
let stateDir: string;
let managed: string;

beforeEach(async () => {
  const scratch = temp.make("plugin-hourly-");
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    vi.stubEnv(key, scratch);
  }
  stateDir = temp.make("plugin-hourly-state-");
  managed = path.join(stateDir, "tmp", "plugin-captures");
  await sweepPluginSourceCapturesForTest(stateDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  temp.cleanup();
});

function age(root: string) {
  const old = new Date(Date.now() - 2 * 60 * 60 * 1_000);
  fs.utimesSync(root, old, old);
}

function orphan(name: string, keepCreator = false) {
  const root = path.join(managed, name);
  const file = path.join(root, "captures", "index.cjs");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "captured source");
  const release = acquireSqliteStagingToken(root, "create");
  if (!keepCreator) {
    release();
  }
  age(root);
  return { root, file, release };
}

it("reclaims a batch off main without disturbing a live host creator lock or native bytes", async () => {
  const spawned = vi.spyOn(command, "runCommandBuffersWithTimeout");
  await sweepPluginSourceCapturesForTest(stateDir);
  expect(spawned).not.toHaveBeenCalled();
  const busy = orphan("busy", true);
  const discarded = orphan("discarded");
  const retained = orphan("native");
  const native = path.join(retained.root, "native", "content", "addon.node");
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.writeFileSync(native, "retained native bytes");
  age(retained.root);
  const releaseNative = retainPluginNativeCapturePath(native);
  try {
    const observed = observeMainThreadFs();
    let ownerCalls: ReturnType<typeof observed.stacks>;
    try {
      await sweepPluginSourceCapturesForTest(stateDir);
      ownerCalls = observed
        .stacks()
        .filter((entry) =>
          /plugin-source-capture-(?:directory|native-loads|path)\.[cm]?[jt]s[:)]/.test(entry.stack),
        );
    } finally {
      observed[Symbol.dispose]();
    }
    expect(ownerCalls).toEqual([]);
    expect(spawned).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(discarded.root)).toBe(false);
    expect(fs.existsSync(retained.file)).toBe(false);
    expect(fs.readFileSync(native, "utf8")).toBe("retained native bytes");
    expect(fs.readFileSync(busy.file, "utf8")).toBe("captured source");
    // A second independent collector still cannot acquire the host creator's lock.
    await sweepPluginSourceCapturesForTest(stateDir);
    expect(fs.readFileSync(busy.file, "utf8")).toBe("captured source");
  } finally {
    releaseNative();
    busy.release();
  }
  age(busy.root);
  await sweepPluginSourceCapturesForTest(stateDir);
  expect(fs.existsSync(busy.root)).toBe(false);
});

it("continues the batch after a physical failure and refuses a replaced selected directory", async () => {
  const failed = orphan("failed");
  const replaced = orphan("replaced");
  const clean = orphan("clean");
  const fault = interceptPluginCaptureReclamation(`
    import fs from 'node:fs';
    import promises from 'node:fs/promises';
    const remove = promises.rm.bind(promises);
    promises.rm = async (target, options) => {
      if (target === ${JSON.stringify(path.dirname(failed.file))}) {
        throw Object.assign(new Error('Synthetic removal refusal'), { code: 'EACCES' });
      }
      return remove(target, options);
    };
    fs.renameSync(${JSON.stringify(replaced.root)}, ${JSON.stringify(replaced.root + "-original")});
    fs.mkdirSync(${JSON.stringify(replaced.root)});
    fs.writeFileSync(${JSON.stringify(path.join(replaced.root, "successor"))}, 'new root');
  `);
  try {
    await sweepPluginSourceCapturesForTest(stateDir);
    expect(fs.readFileSync(failed.file, "utf8")).toBe("captured source");
    expect(fs.readFileSync(path.join(replaced.root, "successor"), "utf8")).toBe("new root");
    expect(fs.existsSync(path.join(replaced.root, "owner.sqlite"))).toBe(false);
    expect(fs.existsSync(clean.root)).toBe(false);
  } finally {
    fault.mockRestore();
  }
  age(failed.root);
  await sweepPluginSourceCapturesForTest(stateDir);
  expect(fs.existsSync(failed.root)).toBe(false);
});

it("retains deletion custody after the child's reply until its actual exit", async () => {
  const retained = orphan("joined");
  const native = path.join(retained.root, "native", "content", "addon.node");
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.writeFileSync(native, "kept");
  age(retained.root);
  const barrier = temp.make("plugin-child-exit-");
  const replied = createDeferred();
  const hold = interceptPluginCaptureReclamation(
    `
    import fs from 'node:fs';
    const watcher = fs.watch(${JSON.stringify(barrier)}, (_event, name) => {
      if (String(name) === 'release') watcher.close();
    });
  `,
    () => replied.resolve(),
  );
  const sweep = sweepPluginSourceCapturesForTest(stateDir);
  let settled = false;
  void sweep.then(() => {
    settled = true;
  });
  try {
    await replied.promise;
    expect(settled).toBe(false);
    expect(isPluginSourceCaptureRetained(retained.root)).toBe(true);
    expect(() => retainPluginNativeCapturePath(retained.file)).toThrow("being reclaimed");
    expect(fs.readFileSync(native, "utf8")).toBe("kept");
  } finally {
    await fsPromises.writeFile(path.join(barrier, "release"), "exit");
    await sweep;
    hold.mockRestore();
  }
  const release = retainPluginNativeCapturePath(retained.file);
  release();
  expect(isPluginSourceCaptureRetained(retained.root)).toBe(false);
});
