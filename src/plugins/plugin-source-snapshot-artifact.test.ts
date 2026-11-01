import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  captureSqliteDatabaseAdmissions,
  retainSqliteDatabaseAdmissionLocation,
} from "../infra/sqlite-database-admission.js";
import {
  capturePluginSnapshotGeneration,
  capturePluginSourceSnapshot,
} from "./plugin-generation-capture.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import {
  hasPluginNativeCaptureCleanupCandidates,
  prunePluginNativeCaptureDirectories,
} from "./plugin-source-capture-directory.js";
import { resolvePluginSourceCapturesDirectory } from "./plugin-source-capture-path.js";
import {
  acquirePluginSourceSnapshot,
  collectPluginSourceSnapshots,
  pluginSourceSnapshotClosureDigest,
  stagePluginSourceSnapshot,
} from "./plugin-source-snapshot-artifact.js";
import type { PluginSourceSnapshotDescriptor } from "./plugin-source-snapshot.types.js";
import { pluginProcessRuntimeEntrypoints } from "./process-runtime.test-support.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const releases: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const release of releases.splice(0).toReversed()) {
    await release();
  }
});
const assertCurrent = () => {};
async function fixture(native = true, hardlinked = false, linkedDependency = false) {
  const stateDir = temp.make("plugin-snapshot-");
  const source = path.join(stateDir, "installed");
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({ name: "snapshot-fixture", main: "index.cjs", dependencies: { dep: "1" } }),
  );
  fs.writeFileSync(path.join(source, "index.cjs"), "exports.read = () => require('dep');");
  if (hardlinked) {
    fs.linkSync(path.join(source, "index.cjs"), path.join(source, "linked.cjs"));
  }
  if (native) {
    fs.writeFileSync(path.join(source, "binary.node"), Buffer.from([0, 1, 2, 3]));
  }
  const dependencyLink = path.join(source, "node_modules", "dep");
  const dep = linkedDependency ? path.join(stateDir, "dependency") : dependencyLink;
  fs.mkdirSync(dep, { recursive: true });
  if (linkedDependency) {
    fs.mkdirSync(path.dirname(dependencyLink), { recursive: true });
    fs.symlinkSync(dep, dependencyLink, "junction");
  }
  fs.writeFileSync(
    path.join(dep, "package.json"),
    JSON.stringify({ name: "dep", main: "index.cjs" }),
  );
  fs.writeFileSync(path.join(dep, "index.cjs"), "module.exports = 'original';");
  const capture = withPluginSourceCaptureStorage({ stateDir, placement: "state" }, () =>
    capturePluginSourceSnapshot(source),
  );
  releases.push(capture.disposeAsync);
  const binding = {
    installRecordHash: "record",
    contentDigest: capture.sourceDigest,
    dependencyClosureDigest: pluginSourceSnapshotClosureDigest(capture),
    buildResolutionDigest: "options",
  };
  const published = await stagePluginSourceSnapshot({
    stateDir,
    capture,
    binding,
    assertCurrent,
  }).then((staged) => staged.publish());
  const descriptor: PluginSourceSnapshotDescriptor = { ...published, installedRevision: 1 };
  return { stateDir, source, descriptor, capture, binding };
}

it("reuses independent source bytes after original package and dependency removal", async () => {
  const { stateDir, source, descriptor } = await fixture();
  const parent = fs.statSync(source);
  fs.writeFileSync(path.join(source, "index.cjs"), "changed child with retained parent times");
  fs.utimesSync(source, parent.atime, parent.mtime);
  const first = await acquirePluginSourceSnapshot({ stateDir, descriptor, assertCurrent });
  fs.rmSync(source, { recursive: true });
  const second = await acquirePluginSourceSnapshot({ stateDir, descriptor, assertCurrent });
  releases.push(first.release, second.release);
  expect(fs.readFileSync(path.join(first.rootDir, "index.cjs"), "utf8")).toContain(
    "require('dep')",
  );
  expect(
    fs.readFileSync(path.join(first.rootDir, "node_modules", "dep", "index.cjs"), "utf8"),
  ).toContain("original");
  expect(fs.statSync(path.join(first.rootDir, "binary.node")).nlink).toBe(1);
  expect(first.sourceAliases[source]).toBe(first.rootDir);
  expect(first.sourceDigest).toBe(descriptor.contentDigest);
});

it("keeps absolute dependency links valid across atomic publication", async () => {
  const { stateDir, capture, binding } = await fixture(false, false, true);
  const symlink = fs.symlinkSync.bind(fs);
  // Model Windows junctions on every host: their stored targets are absolute.
  vi.spyOn(fs, "symlinkSync").mockImplementation((target, link, type) =>
    symlink(path.resolve(path.dirname(String(link)), String(target)), link, type),
  );
  const published = await stagePluginSourceSnapshot({
    stateDir,
    capture,
    binding,
    assertCurrent,
  }).then((staged) => staged.publish());
  const descriptor = { ...published, installedRevision: 1 };
  const reader = await acquirePluginSourceSnapshot({ stateDir, descriptor, assertCurrent });
  releases.push(reader.release);
  expect(fs.readFileSync(path.join(reader.rootDir, "node_modules/dep/index.cjs"), "utf8")).toBe(
    "module.exports = 'original';",
  );
});

it("releases staging token descriptor custody before atomic rename", async () => {
  const { stateDir, capture, binding } = await fixture(false);
  const rename = fs.renameSync.bind(fs);
  let tokenDescriptor: number | undefined;
  let tokenIdentity: fs.BigIntStats | undefined;
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (path.basename(String(from)).startsWith("snapshot-v1-staging-")) {
      // Model Windows sharing: a retained token descriptor prevents its parent rename.
      let opened: fs.BigIntStats | undefined;
      try {
        opened = fs.fstatSync(tokenDescriptor!, { bigint: true });
      } catch (error) {
        if (!hasErrnoCode(error, "EBADF")) {
          throw error;
        }
      }
      if (opened && opened.dev === tokenIdentity?.dev && opened.ino === tokenIdentity?.ino) {
        throw Object.assign(new Error("Staging token still has descriptor custody"), {
          code: "EPERM",
        });
      }
    }
    rename(from, to);
  });
  let checks = 0;
  const published = await stagePluginSourceSnapshot({
    stateDir,
    capture,
    binding,
    assertCurrent() {
      if (++checks !== 2) {
        return;
      }
      const parent = resolvePluginSourceCapturesDirectory(stateDir);
      const stage = fs.readdirSync(parent).find((name) => name.startsWith("snapshot-v1-staging-"))!;
      // Exercise the physical-descriptor cache that Windows publication must release.
      const location = path.join(parent, stage, "owner.sqlite");
      retainSqliteDatabaseAdmissionLocation(location);
      tokenDescriptor = captureSqliteDatabaseAdmissions(undefined, { location })[0]?.descriptor;
      expect(tokenDescriptor).toBeDefined();
      tokenIdentity = fs.fstatSync(tokenDescriptor!, { bigint: true });
    },
  }).then((staged) => staged.publish());
  expect(fs.existsSync(published.artifact.path)).toBe(true);
});

it("keeps a current-process snapshot publisher out of capture maintenance", async () => {
  const { stateDir, capture, binding } = await fixture(false);
  let checks = 0;
  await stagePluginSourceSnapshot({
    stateDir,
    capture,
    binding,
    assertCurrent: async () => {
      if (++checks !== 2) {
        return;
      }
      const parent = resolvePluginSourceCapturesDirectory(stateDir);
      const stage = path.join(
        parent,
        fs.readdirSync(parent).find((name) => name.startsWith("snapshot-v1-staging-"))!,
      );
      expect(await hasPluginNativeCaptureCleanupCandidates(stateDir)).toBe(false);
      await prunePluginNativeCaptureDirectories(stateDir, new Set(), () => {}, { startup: true });
      expect(fs.existsSync(stage)).toBe(true);
    },
  }).then((staged) => staged.publish());
});

it.each(process.platform === "win32" ? [false] : [false, true])(
  "waits for a different process reader and rejects a replaced token (%s)",
  async (replaceToken) => {
    const { stateDir, descriptor } = await fixture(false);
    const moduleUrl = resolveRuntimeWorkerUrl(pluginProcessRuntimeEntrypoints.sourceSnapshot);
    const child = spawn(
      process.execPath,
      [
        ...resolveRuntimeWorkerArgv(moduleUrl).slice(0, -1),
        "--input-type=module",
        "-e",
        `import { acquirePluginSourceSnapshot } from ${JSON.stringify(moduleUrl.href)};
     const reader = await acquirePluginSourceSnapshot({ stateDir: process.argv[1], descriptor: JSON.parse(process.argv[2]), assertCurrent() {} });
     process.stdout.write("ready\\n");
     process.stdin.once("data", () => { reader.release(); process.stdin.pause(); });
     process.stdin.resume();`,
        stateDir,
        JSON.stringify(descriptor),
      ],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exited = once(child, "close");
    const lines = createInterface({ input: child.stdout });
    releases.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await exited;
      lines.close();
    });
    const ready = await lines[Symbol.asyncIterator]().next();
    expect(ready, stderr).toEqual({ value: "ready", done: false });
    const token = path.join(descriptor.artifact.path, "owner.sqlite");
    if (replaceToken) {
      fs.renameSync(token, `${token}.old`);
      fs.writeFileSync(token, "", { mode: 0o600 });
      const stat = fs.lstatSync(token, { bigint: true });
      const manifestPath = path.join(descriptor.artifact.path, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.tokenIdentity = `${stat.dev}:${stat.ino}:${stat.uid}:${stat.gid}:${stat.mode}`;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    }
    const collect = () =>
      collectPluginSourceSnapshots({
        stateDir,
        retainedPaths: new Set(),
        retiredSnapshots: [descriptor],
        assertCurrent,
      });
    expect((await collect()).removed).toEqual([]);
    expect(fs.existsSync(descriptor.artifact.path)).toBe(true);
    child.stdin.end("release\n");
    const [code] = await exited;
    expect(code, stderr).toBe(0);
    if (replaceToken) {
      const blocked = await collect();
      expect(blocked.removed).toEqual([]);
      expect(blocked.warnings).toEqual([expect.stringContaining("token identity changed")]);
      fs.unlinkSync(token);
      fs.renameSync(`${token}.old`, token);
    }
    expect((await collect()).removed).toEqual([descriptor.artifact.path]);
  },
);

it.each(["content", "permission", "identity", "extra", "incomplete", "format"] as const)(
  "rejects named snapshot %s damage",
  async (damage) => {
    const { stateDir, descriptor } = await fixture();
    const reader = await acquirePluginSourceSnapshot({ stateDir, descriptor, assertCurrent });
    const entry = path.join(reader.rootDir, "index.cjs");
    reader.release();
    if (damage === "content") {
      fs.writeFileSync(entry, "modified");
    } else if (damage === "permission") {
      if (process.platform === "win32") {
        return;
      }
      fs.chmodSync(entry, 0o666);
    } else if (damage === "identity") {
      const content = fs.readFileSync(entry);
      fs.unlinkSync(entry);
      fs.writeFileSync(entry, content, { mode: 0o600 });
    } else if (damage === "extra") {
      fs.writeFileSync(path.join(reader.rootDir, "extra.cjs"), "extra", { mode: 0o600 });
    } else if (damage === "incomplete") {
      fs.rmSync(path.join(descriptor.artifact.path, "manifest.json"));
    } else {
      descriptor.formatVersion++;
    }
    await expect(
      acquirePluginSourceSnapshot({ stateDir, descriptor, assertCurrent }),
    ).rejects.toMatchObject({
      code: "PLUGIN_SOURCE_SNAPSHOT_INVALID",
      artifactPath: descriptor.artifact.path,
    });
  },
);

it("keeps retired generations until the final source reader releases", async () => {
  const { stateDir, descriptor } = await fixture();
  const first = await acquirePluginSourceSnapshot({ stateDir, descriptor, assertCurrent });
  const second = await acquirePluginSourceSnapshot({ stateDir, descriptor, assertCurrent });
  releases.push(first.release, second.release);
  const collect = () =>
    collectPluginSourceSnapshots({
      stateDir,
      retainedPaths: new Set(),
      retiredSnapshots: [descriptor],
      assertCurrent,
    });
  expect((await collect()).removed).toEqual([]);
  first.release();
  expect((await collect()).removed).toEqual([]);
  second.release();
  expect((await collect()).removed).toEqual([descriptor.artifact.path]);
  await expect(
    acquirePluginSourceSnapshot({ stateDir, descriptor, assertCurrent }),
  ).rejects.toMatchObject({ code: "PLUGIN_SOURCE_SNAPSHOT_INVALID" });
});

it.runIf(Boolean(process.getuid))("rejects an artifact owned by another user", async () => {
  const { stateDir, descriptor } = await fixture();
  const root = descriptor.artifact.path;
  const actual = fs.lstatSync;
  const unsafe = actual(root, { bigint: true });
  unsafe.uid += 1n;
  vi.spyOn(fs, "lstatSync").mockImplementation((...args) =>
    args[0] === root ? unsafe : Reflect.apply(actual, fs, args),
  );
  await expect(
    acquirePluginSourceSnapshot({ stateDir, descriptor, assertCurrent }),
  ).rejects.toMatchObject({ code: "PLUGIN_SOURCE_SNAPSHOT_INVALID", artifactPath: root });
});

it("preserves original hardlink rejection after copying into an unlinked snapshot", async () => {
  const { stateDir, source, descriptor } = await fixture(false, true);
  const reader = await acquirePluginSourceSnapshot({ stateDir, descriptor, assertCurrent });
  releases.push(reader.release);
  const runtime = withPluginSourceCaptureStorage({ stateDir, placement: "state" }, () =>
    capturePluginSnapshotGeneration(reader, undefined, (run) => run()),
  );
  releases.push(runtime.disposeAsync);
  const entry = path.join(source, "index.cjs");
  const captured = runtime.resolve(entry);
  expect(fs.statSync(captured).nlink).toBe(1);
  expect(runtime.resolve(captured)).toBe(captured);
  expect(runtime.hasSource(captured)).toBe(true);
  expect(
    fs.readFileSync(runtime.resolve(path.join(source, "node_modules", "dep", "index.cjs")), "utf8"),
  ).toContain("original");
  expect(() => runtime.resolve(entry, true)).toThrow("Plugin source is hardlinked");
});

it("captures complete lazy files for install-time package import aliases", () => {
  const stateDir = temp.make("plugin-snapshot-imports-");
  const source = path.join(stateDir, "installed");
  const alias = path.join(source, "node_modules", "aliased");
  fs.mkdirSync(alias, { recursive: true });
  fs.writeFileSync(
    path.join(source, "package.json"),
    JSON.stringify({ name: "imports-fixture", imports: { "#alias": "aliased" } }),
  );
  fs.writeFileSync(path.join(source, "index.cjs"), "exports.read = () => require('#alias');");
  fs.writeFileSync(
    path.join(alias, "package.json"),
    JSON.stringify({ name: "aliased", main: "index.cjs" }),
  );
  fs.writeFileSync(path.join(alias, "index.cjs"), "exports.read = () => require('./lazy.cjs');");
  fs.writeFileSync(path.join(alias, "lazy.cjs"), "module.exports = 42;");
  const capture = withPluginSourceCaptureStorage({ stateDir, placement: "state" }, () =>
    capturePluginSourceSnapshot(source),
  );
  releases.push(capture.disposeAsync);
  expect(fs.readFileSync(path.join(capture.sourceAliases[alias]!, "lazy.cjs"), "utf8")).toBe(
    "module.exports = 42;",
  );
});

it("retains frozen logical aliases and closure restrictions through recovery forks", async () => {
  const { stateDir, source, descriptor } = await fixture(false);
  const reader = await acquirePluginSourceSnapshot({ stateDir, descriptor, assertCurrent });
  releases.push(reader.release);
  const capture = () =>
    withPluginSourceCaptureStorage({ stateDir, placement: "state" }, () =>
      capturePluginSnapshotGeneration(reader, undefined, (run) => run()),
    );
  const runtime = capture();
  releases.push(runtime.disposeAsync);
  const recovery = runtime.captureRecoverySource();
  releases.push(recovery.disposeAsync);
  const fork = recovery.fork();
  releases.push(fork.disposeAsync);
  fs.rmSync(source, { recursive: true });
  reader.release();
  runtime.dispose();
  const restored = withPluginSourceCaptureStorage({ stateDir, placement: "state" }, () =>
    capturePluginSnapshotGeneration(
      fork.frozenSource!,
      undefined,
      (run) => run(),
      undefined,
      fork.native,
    ),
  );
  releases.push(restored.disposeAsync);
  expect(restored.frozenSource).toBe(true);
  expect(restored.sourceDigest).toBe(descriptor.contentDigest);
  expect(fs.readFileSync(restored.resolve(path.join(source, "index.cjs")), "utf8")).toContain(
    "require('dep')",
  );
  expect(() => restored.assertFrozenModule!(path.join(stateDir, "outside.cjs"))).toThrow(
    "Declare the dependency",
  );
});

it("refuses publication when the capture no longer matches its installation binding", async () => {
  const { stateDir, capture, binding } = await fixture();
  await expect(
    stagePluginSourceSnapshot({
      stateDir,
      capture,
      binding: { ...binding, contentDigest: "changed" },
      assertCurrent,
    }).then((staged) => staged.publish()),
  ).rejects.toThrow("does not match the installation record");
});

it("binds stable closure layout and bytes without retaining ephemeral capture identities", async () => {
  const { stateDir, source, capture, binding } = await fixture();
  const recapture = () => {
    const next = withPluginSourceCaptureStorage({ stateDir, placement: "state" }, () =>
      capturePluginSourceSnapshot(source),
    );
    releases.push(next.disposeAsync);
    return pluginSourceSnapshotClosureDigest(next);
  };
  expect(recapture()).toBe(binding.dependencyClosureDigest);
  fs.mkdirSync(path.join(source, "empty"));
  expect(recapture()).not.toBe(pluginSourceSnapshotClosureDigest(capture));
});

it.each(["content", "link", "directory", "executable"] as const)(
  "rejects capture %s changes after its content receipt was recorded",
  async (change) => {
    if (change === "executable" && process.platform === "win32") {
      return;
    }
    const { stateDir, capture, binding } = await fixture(true, false, change === "link");
    if (change === "content") {
      fs.writeFileSync(path.join(capture.rootDir, "index.cjs"), "changed after capture");
    } else if (change === "link") {
      const dependency = path.join(capture.rootDir, "node_modules", "dep");
      expect(fs.lstatSync(dependency).isSymbolicLink()).toBe(true);
      fs.unlinkSync(dependency);
      fs.symlinkSync(capture.rootDir, dependency, "junction");
    } else if (change === "directory") {
      fs.mkdirSync(path.join(capture.rootDir, "extra-empty-directory"));
    } else {
      fs.chmodSync(path.join(capture.rootDir, "index.cjs"), 0o700);
    }
    await expect(
      stagePluginSourceSnapshot({ stateDir, capture, binding, assertCurrent }).then((staged) =>
        staged.publish(),
      ),
    ).rejects.toThrow("source changed after its installation receipt");
  },
);

it("revalidates payload identity after awaiting current installation authority", async () => {
  const { stateDir, descriptor } = await fixture();
  const first = await acquirePluginSourceSnapshot({ stateDir, descriptor, assertCurrent });
  const entry = path.join(first.rootDir, "index.cjs");
  first.release();
  let checks = 0;
  await expect(
    acquirePluginSourceSnapshot({
      stateDir,
      descriptor,
      assertCurrent: async () => {
        if (++checks === 2) {
          fs.writeFileSync(entry, "changed during authority check");
        }
      },
    }),
  ).rejects.toMatchObject({ code: "PLUGIN_SOURCE_SNAPSHOT_INVALID" });
});

it("does not misclassify lost installation authority as snapshot corruption", async () => {
  const { stateDir, descriptor } = await fixture();
  const changed = new Error("installation owner changed");
  let checks = 0;
  await expect(
    acquirePluginSourceSnapshot({
      stateDir,
      descriptor,
      assertCurrent: async () => {
        if (++checks === 2) {
          throw changed;
        }
      },
    }),
  ).rejects.toBe(changed);
  const acquired = await acquirePluginSourceSnapshot({ stateDir, descriptor, assertCurrent });
  releases.push(acquired.release);
});

it.runIf(process.platform !== "win32")(
  "detects replacement of the token that pins cross-process reader custody",
  async () => {
    const { stateDir, descriptor } = await fixture();
    const reader = await acquirePluginSourceSnapshot({ stateDir, descriptor, assertCurrent });
    releases.push(reader.release);
    const token = path.join(descriptor.artifact.path, "owner.sqlite");
    fs.renameSync(token, `${token}.old`);
    fs.writeFileSync(token, "", { mode: 0o600 });
    expect(reader.assertCurrent).toThrow("token identity changed");
  },
);

it.each(["authority", "staging-payload", "published-payload"] as const)(
  "does not expose an incomplete artifact after awaited %s changes",
  async (change) => {
    const { stateDir, capture, binding } = await fixture();
    let checks = 0;
    const parent = path.join(stateDir, "tmp", "plugin-captures");
    const rootsBefore = fs.readdirSync(parent);
    await expect(
      stagePluginSourceSnapshot({
        stateDir,
        capture,
        binding,
        assertCurrent: async () => {
          checks++;
          if (checks === 2 && change === "authority") {
            throw new Error("installation changed");
          }
          if (checks === (change === "staging-payload" ? 2 : 3)) {
            const root = fs.readdirSync(parent).find((name) => !rootsBefore.includes(name))!;
            fs.writeFileSync(
              path.join(
                parent,
                root,
                "payload",
                path.relative(capture.boundaryRoot, capture.rootDir),
                "index.cjs",
              ),
              "changed during authority check",
            );
          }
        },
      }).then((staged) => staged.publish()),
    ).rejects.toThrow(change === "authority" ? "installation changed" : "after source validation");
    expect(fs.readdirSync(parent)).toEqual(rootsBefore);
  },
);
