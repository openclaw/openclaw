import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { capturePluginSourceSnapshot } from "./plugin-generation-capture.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import {
  acquirePluginSharedSourceSnapshot,
  collectPluginSourceSnapshots,
  pluginSourceSnapshotClosureDigest,
  stagePluginSharedSourceSnapshot,
} from "./plugin-source-snapshot-artifact.js";
import { createPluginSharedSnapshotNativeLoader } from "./plugin-source-snapshot-native.js";

const temporary = createTempDirTracker();
const disposers: Array<() => void | Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of disposers.splice(0).toReversed()) {
    await dispose();
  }
  temporary.cleanup();
});

async function fixture(nativeOwner: "dependency" | "plugin" = "dependency") {
  const stateDir = temporary.make("shared-native-");
  const source = path.join(stateDir, "installed");
  const addon = nativeOwner === "plugin" ? source : path.join(source, "node_modules", "addon");
  const companion = path.join(source, "node_modules", "companion");
  fs.mkdirSync(path.join(addon, "lib"), { recursive: true });
  fs.mkdirSync(companion, { recursive: true });
  fs.writeFileSync(
    path.join(source, "package.json"),
    nativeOwner === "plugin"
      ? '{"dependencies":{"companion":"1"}}'
      : '{"dependencies":{"addon":"1"}}',
  );
  fs.writeFileSync(path.join(source, "index.cjs"), "module.exports = 1");
  fs.writeFileSync(path.join(source, "unrelated.txt"), "not a native companion");
  if (nativeOwner === "dependency") {
    fs.writeFileSync(path.join(addon, "package.json"), '{"dependencies":{"companion":"1"}}');
  }
  fs.writeFileSync(path.join(addon, "lib", "addon.node"), "synthetic native bytes");
  fs.writeFileSync(path.join(addon, "lib", "data.txt"), "addon companion");
  fs.writeFileSync(path.join(companion, "package.json"), '{"name":"companion"}');
  fs.writeFileSync(path.join(companion, "library.so"), "synthetic companion bytes");
  const capture = withPluginSourceCaptureStorage({ stateDir, placement: "state" }, () =>
    capturePluginSourceSnapshot(source),
  );
  const descriptor = {
    ...(await stagePluginSharedSourceSnapshot({
      stateDir,
      capture,
      assertCurrent() {},
      binding: {
        installRecordHash: "record",
        contentDigest: capture.sourceDigest,
        dependencyClosureDigest: pluginSourceSnapshotClosureDigest(capture),
        buildResolutionDigest: "resolution",
      },
    }).then((pending) => pending.publish())),
    installedRevision: 1,
  };
  disposers.push(() =>
    collectPluginSourceSnapshots({
      stateDir,
      retiredSnapshots: [descriptor],
      retainedPaths: new Set(),
      assertCurrent() {},
    }),
  );
  disposers.push(capture.disposeAsync);
  const snapshot = await acquirePluginSharedSourceSnapshot({
    stateDir,
    descriptor,
    assertCurrent() {},
  });
  disposers.push(() => snapshot.releaseAsync());
  const addonFile = [...snapshot.entries.keys()].find((filename) =>
    filename.endsWith(`${path.sep}addon.node`),
  )!;
  const companionFile = [...snapshot.entries.keys()].find((filename) =>
    filename.endsWith(`${path.sep}library.so`),
  )!;
  const load = () => {
    const native = createPluginSharedSnapshotNativeLoader(snapshot);
    disposers.push(() => native.disposeAsync());
    return native;
  };
  return { snapshot, addonFile, companionFile, load };
}

function fakeNativeLoader() {
  let evaluations = 0;
  return vi.spyOn(process, "dlopen").mockImplementation((module, filename) => {
    (module as NodeJS.Module).exports = { filename, evaluation: ++evaluations };
  });
}

it("scrubs authenticated dependency links without following them during enumeration", async () => {
  const { snapshot } = await fixture();
  const scrub = snapshot.createScrub();
  let report;
  do {
    report = await scrub.step({ maxFiles: 3, maxBytes: 256 });
  } while (!report.done);
  expect(report.totalFiles).toBeGreaterThan(4);
  expect(report.totalEntries).toBe(snapshot.entries.size);
});

it("gives each native instance a private verified namespace without copying unrelated source", async () => {
  const subject = await fixture();
  const dlopen = fakeNativeLoader();
  const links = vi.spyOn(fs, "linkSync");
  const first = subject.load();
  const second = subject.load();
  const a = first.load(subject.addonFile) as { filename: string; evaluation: number };
  const b = second.load(subject.addonFile) as { filename: string; evaluation: number };
  expect(a.filename).not.toBe(b.filename);
  expect([a.evaluation, b.evaluation]).toEqual([1, 2]);
  expect(first.load(subject.addonFile)).toBe(a);
  expect(dlopen).toHaveBeenCalledTimes(2);
  expect(links).not.toHaveBeenCalled();
  const nativePackage = path.dirname(path.dirname(a.filename));
  expect(fs.readFileSync(path.join(nativePackage, "lib", "data.txt"), "utf8")).toBe(
    "addon companion",
  );
  expect(
    fs.readFileSync(path.join(nativePackage, "node_modules", "companion", "library.so"), "utf8"),
  ).toBe("synthetic companion bytes");
  expect(fs.existsSync(path.join(nativePackage, "unrelated.txt"))).toBe(false);
});

it("keeps every plugin-root companion private and verifies it again before dlopen", async () => {
  const subject = await fixture("plugin");
  const dlopen = fakeNativeLoader();
  const first = subject.load();
  const a = first.load(subject.addonFile) as { filename: string };
  const b = subject.load().load(subject.addonFile) as { filename: string };
  const asset = (filename: string) =>
    path.join(path.dirname(path.dirname(filename)), "unrelated.txt");
  expect(a.filename).not.toBe(b.filename);
  expect(fs.readFileSync(asset(a.filename), "utf8")).toBe("not a native companion");
  expect(fs.statSync(asset(a.filename), { bigint: true }).ino).not.toBe(
    fs.statSync(asset(b.filename), { bigint: true }).ino,
  );
  fs.writeFileSync(asset(a.filename), "changed private companion");
  expect(() => first.load(subject.addonFile)).toThrow();
  expect(dlopen).toHaveBeenCalledTimes(2);
  expect(fs.readFileSync(asset(b.filename), "utf8")).toBe("not a native companion");
});

it.each(["changed", "removed"])(
  "rejects a %s native dependency companion before dlopen",
  async (change) => {
    const subject = await fixture();
    const dlopen = fakeNativeLoader();
    fs.chmodSync(path.dirname(subject.companionFile), 0o700);
    if (change === "removed") {
      fs.unlinkSync(subject.companionFile);
    } else {
      fs.chmodSync(subject.companionFile, 0o600);
      fs.writeFileSync(subject.companionFile, "changed companion");
    }
    expect(() => subject.load().load(subject.addonFile)).toThrow();
    expect(dlopen).not.toHaveBeenCalled();
  },
);

it("rejects an added companion before dlopen", async () => {
  const subject = await fixture();
  const dlopen = fakeNativeLoader();
  const directory = path.dirname(subject.addonFile);
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(path.join(directory, "injected.so"), "untrusted");
  expect(() => subject.load().load(subject.addonFile)).toThrow();
  expect(dlopen).not.toHaveBeenCalled();
});
