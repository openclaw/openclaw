import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import {
  createPluginGenerationFileCapture,
  createPluginSourceLinkCapture,
} from "./plugin-generation-file-capture.js";
import { createPluginGenerationReceipt } from "./plugin-generation-receipt.js";
import type { PreparedPluginGenerationArtifact } from "./plugin-generation-worker.js";
import {
  isPluginSourceAcquisitionError,
  markPluginSourceAcquisitionError,
} from "./plugin-instance-error.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
import { createPluginNativeAdmission } from "./plugin-native-admission.js";
import {
  createPluginPackageMetadataCapture,
  withPluginSourceCaptureDirectory,
} from "./plugin-package-metadata-capture.js";
import {
  getPluginSetupModuleLoader,
  preparePluginSetupModuleLoader,
} from "./plugin-setup-module.js";
import {
  copyPluginSourceFile,
  createPluginSourceDirectoryCapture,
  hashPluginSourceFile,
  inspectPluginCaptureSource,
  readPluginCapturedCode,
} from "./plugin-source-file.js";
import { writeArtifacts } from "./public-surface.test-support.js";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), bind: vi.fn() }));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  isMainThread: true,
}));
vi.mock("./plugin-generation-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-generation-worker.js")>()),
  preparePluginGenerationArtifact: mocks.prepare,
}));
vi.mock("./plugin-instance-module-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-instance-module-loader.js")>()),
  bindPluginInstanceModuleLoader: mocks.bind,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  mocks.prepare.mockReset();
  mocks.bind.mockReset();
});
const record = createPluginManifestRecordFixture({ id: "broken", origin: "config" });

it("preserves a settled source failure for synchronous consumers without retry", async () => {
  const failure = markPluginSourceAcquisitionError(
    Object.assign(new Error("source unavailable"), { code: "EACCES" }),
  );
  mocks.prepare.mockRejectedValue(failure);
  await using cache = createPluginCache();
  await withPluginCache(cache, async () => {
    await preparePluginSetupModuleLoader(record, record.source, record.rootDir);
    await preparePluginSetupModuleLoader(record, record.source, record.rootDir);
    expect(() => getPluginSetupModuleLoader(record, record.source, record.rootDir)).toThrow(
      failure,
    );
  });
  expect(mocks.prepare).toHaveBeenCalledOnce();
  expect(mocks.bind).not.toHaveBeenCalled();
});

it.each(["worker", "cleanup", "custody"])("propagates an unmarked %s failure", async (kind) => {
  const failure = new Error(`${kind} unavailable`);
  mocks.prepare.mockRejectedValue(failure);
  await using cache = createPluginCache();
  await expect(
    withPluginCache(cache, () =>
      preparePluginSetupModuleLoader(record, record.source, record.rootDir),
    ),
  ).rejects.toBe(failure);
  expect(cache.setupModules.size).toBe(0);
});

it.each(["cancel", "authority"])("rechecks %s after a failed source await", async (kind) => {
  const pending = createDeferred<PreparedPluginGenerationArtifact>();
  const entered = createDeferred();
  const controller = new AbortController();
  const failure = new Error(`${kind} lost`);
  let current = true;
  mocks.prepare.mockImplementation(() => {
    entered.resolve();
    return pending.promise;
  });
  await using cache = createPluginCache();
  const result = withPluginCache(cache, () =>
    preparePluginSetupModuleLoader(record, record.source, record.rootDir, {
      signal: controller.signal,
      assertCurrent() {
        if (!current) {
          throw failure;
        }
      },
    }),
  ).catch((error: unknown) => error);
  await entered.promise;
  if (kind === "cancel") {
    controller.abort(failure);
  } else {
    current = false;
  }
  pending.reject(markPluginSourceAcquisitionError(new Error("source unavailable")));
  expect(await result).toBe(failure);
  expect(cache.setupModules.size).toBe(0);
});

it("keeps private validation opens distinct from an original copy failure using the same error", () => {
  const root = dirs.make("setup-open-provenance-");
  const source = path.join(root, "source");
  const failure = new Error("open failed");
  const openFile = () => {
    throw failure;
  };
  const copy = (preserveSourceMode = false) =>
    copyPluginSourceFile(source, root, path.join(root, "target"), { openFile, preserveSourceMode });
  expect(() => copy()).toThrow(failure);
  expect(isPluginSourceAcquisitionError(failure)).toBe(true);
  expect(() => hashPluginSourceFile(source, root, undefined, undefined, openFile)).toThrow(failure);
  expect(isPluginSourceAcquisitionError(failure)).toBe(false);
  expect(() => copy()).toThrow(failure);
  expect(() => copy(true)).toThrow(failure);
  expect(isPluginSourceAcquisitionError(failure)).toBe(false);
});

it("does not mark actual capture cleanup failure as source unavailability", () => {
  const root = dirs.make("setup-preparation-cleanup-");
  const missing = path.join(root, "missing");
  const failure = markPluginSourceAcquisitionError(new Error("capture cleanup failed"));
  const remove = fs.rmSync;
  const spy = vi.spyOn(fs, "rmSync").mockImplementation((filename, options) => {
    if (String(filename).includes("openclaw-plugin-build-")) {
      throw failure;
    }
    remove(filename, options);
  });
  let caught: unknown;
  try {
    withPluginSourceCaptureDirectory(root, () => capturePluginGenerationArtifact(missing));
  } catch (error) {
    caught = error;
  } finally {
    spy.mockRestore();
  }
  expect(caught).toBe(failure);
  expect(isPluginSourceAcquisitionError(caught)).toBe(false);
});

it("clears earlier source provenance from private descriptor-read failures", () => {
  const root = dirs.make("private-descriptor-read-");
  const filename = path.join(root, "entry.cjs");
  fs.writeFileSync(filename, "module.exports = {};");
  const failure = markPluginSourceAcquisitionError(new Error("descriptor read failed"));
  vi.spyOn(fs, "readSync").mockImplementation(() => {
    throw failure;
  });
  expect(() => hashPluginSourceFile(filename, root)).toThrow(failure);
  expect(isPluginSourceAcquisitionError(failure)).toBe(false);
});

it.for(["readdirSync", "lstatSync", "realpathSync", "escape", "cycle", "nonregular"] as const)(
  "keeps private native-directory %s failures distinct from original source failures",
  async (operation, context) => {
    const linked = ["realpathSync", "escape", "cycle"].includes(operation);
    if (process.platform === "win32" && linked) {
      context.skip();
    }
    const root = dirs.make("native-directory-provenance-");
    const original = path.join(root, "original");
    const retained = path.join(root, "retained");
    writeArtifacts(original, { "entry.cjs": "module.exports = {};" });
    writeArtifacts(retained, { "entry.cjs": "module.exports = {};" });
    if (linked) {
      for (const directory of [original, retained]) {
        fs.renameSync(path.join(directory, "entry.cjs"), path.join(directory, "target.cjs"));
        const target = operation === "cycle" ? "." : operation === "escape" ? root : "target.cjs";
        fs.symlinkSync(target, path.join(directory, "entry.cjs"));
      }
    }
    const failure = new Error("directory unavailable");
    await using cache = createPluginCache();
    withPluginCache(cache, () => {
      const directory = path.join(root, "capture");
      const native = createPluginNativeAdmission(original, directory);
      const copy = (prepared: boolean) =>
        createPluginGenerationFileCapture({
          boundary: original,
          destination: directory,
          directory,
          packageKind: "package",
          capturedPaths: new Map(),
          capturedDirectories: new Set(),
          originalSources: new Map(),
          hardlinkedSources: new Set(),
          sourceCapture: { additions: new Set() },
          sourceLinks: createPluginSourceLinkCapture(),
          deferExternalLinks: operation !== "escape",
          nativeAdmission: {
            ...native,
            resolvePreparedSource: (source) =>
              prepared
                ? { path: path.join(retained, path.relative(original, source)), boundary: retained }
                : undefined,
          },
          receipt: createPluginGenerationReceipt(),
          onPackageMetadata() {},
        })(original, directory);
      const realpath = fs.realpathSync;
      const special = fs.statSync(original, { bigint: true });
      special.isDirectory = special.isFile = () => false;
      const spy =
        operation === "escape" || operation === "cycle"
          ? undefined
          : operation === "nonregular"
            ? vi.spyOn(fs, "statSync").mockReturnValue(special)
            : operation === "realpathSync"
              ? vi.spyOn(fs, "realpathSync").mockImplementation((filename) => {
                  if (path.basename(String(filename)) === "entry.cjs") {
                    throw failure;
                  }
                  return realpath(filename);
                })
              : vi.spyOn(fs, operation).mockImplementation(() => {
                  throw failure;
                });
      const captureFailure = (prepared: boolean) => {
        try {
          copy(prepared);
        } catch (error) {
          return error;
        }
        throw new Error("Capture unexpectedly succeeded");
      };
      try {
        const originalFailure = captureFailure(false);
        expect(originalFailure).toBeInstanceOf(Error);
        expect(isPluginSourceAcquisitionError(originalFailure)).toBe(true);
        const privateFailure = captureFailure(true);
        expect(privateFailure).toBeInstanceOf(Error);
        if (spy && operation !== "nonregular") {
          expect(originalFailure).toBe(failure);
          expect(privateFailure).toBe(failure);
        }
        expect(isPluginSourceAcquisitionError(privateFailure)).toBe(false);
      } finally {
        spy?.mockRestore();
      }
    });
  },
);

it.skipIf(process.platform === "win32").each([false, true])(
  "keeps dependency staging cleanup fatal (cleanup fails: %s)",
  (cleanup) => {
    const scratch = dirs.make("dependency-staging-cleanup-");
    const root = path.join(scratch, "plugin");
    writeArtifacts(root, {
      "package.json": { dependencies: { dependency: "*" } },
      "index.cjs": "module.exports = {};",
      "node_modules/dependency/package.json": { name: "dependency", main: "index.cjs" },
      "node_modules/dependency/index.cjs": "module.exports = {};",
    });
    const permission = Object.assign(new Error("link unavailable"), { code: "EACCES" });
    const disposal = new Error("dependency staging cleanup failed");
    const link = fs.symlinkSync;
    const remove = fs.rmSync;
    const staged = (filename: fs.PathLike) =>
      String(filename).includes("openclaw-plugin-build-") &&
      path.basename(String(filename)).startsWith("dependency.");
    vi.spyOn(fs, "symlinkSync").mockImplementation((target, filename, type) => {
      if (staged(filename)) {
        throw permission;
      }
      link(target, filename, type);
    });
    vi.spyOn(fs, "rmSync").mockImplementation((filename, options) => {
      if (cleanup && staged(filename)) {
        throw disposal;
      }
      remove(filename, options);
    });
    let failure: unknown;
    try {
      withPluginSourceCaptureDirectory(scratch, () => capturePluginGenerationArtifact(root));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      name: "PluginDependencyLinkError",
      cause: cleanup ? disposal : permission,
    });
    expect(isPluginSourceAcquisitionError(failure)).toBe(!cleanup);
  },
);

it.for(["inspect", "scan", "metadata"] as const)(
  "keeps private %s validation fatal",
  (operation, context) => {
    if (operation === "metadata" && process.platform === "win32") {
      context.skip();
    }
    const root = dirs.make("private-validation-");
    const original = path.join(root, "original");
    const retained = path.join(root, "retained");
    fs.mkdirSync(original);
    fs.mkdirSync(retained);
    if (operation === "metadata") {
      fs.symlinkSync(".", path.join(original, "loop"));
      fs.symlinkSync(".", path.join(retained, "loop"));
    }
    const run = (prepared: boolean) => {
      if (operation === "inspect") {
        return inspectPluginCaptureSource(
          original,
          root + "-outside",
          prepared ? { path: retained, boundary: root + "-outside" } : undefined,
          () => false,
          undefined,
        );
      }
      if (operation === "scan") {
        const input = prepared ? retained : original;
        return createPluginSourceDirectoryCapture(() => {})(
          input,
          input,
          input,
          new Set([input]),
          !prepared,
        );
      }
      const metadata = path.join(root, "package.json");
      const capture = createPluginPackageMetadataCapture({
        sourceForCaptured: () => path.join(original, "package.json"),
        packageForFile: () => ({ sourceRoot: original, state: "entry", captureTarget() {} }),
        resolveSource: (source) =>
          prepared
            ? { path: path.join(retained, path.relative(original, source)), boundary: retained }
            : undefined,
      });
      capture.record(metadata, () => {});
      capture.setManifest(metadata, { exports: { "./*": "./*.js" } });
      capture.prepare();
    };
    for (const prepared of [false, true]) {
      let failure: unknown;
      try {
        run(prepared);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(isPluginSourceAcquisitionError(failure)).toBe(!prepared);
    }
  },
);

it("keeps an unexpected private code-directory replacement fatal", () => {
  const directory = dirs.make("private-code-directory-");
  const filename = path.join(directory, "entry.cjs");
  fs.writeFileSync(filename, "module.exports = {};");
  fs.unlinkSync(filename);
  fs.mkdirSync(filename);
  let failure: unknown;
  try {
    readPluginCapturedCode(filename);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: "EISDIR" });
  expect(isPluginSourceAcquisitionError(failure)).toBe(false);
});

it("retains invalid-directory selection facts through recovery forks and repeated preparation", async () => {
  const root = dirs.make("captured-directory-facts-");
  const selected = path.join(root, "invalid.cjs");
  writeArtifacts(root, {
    "index.cjs": "module.exports = {};",
    "invalid.cjs/child.cjs": "module.exports = {};",
  });
  await using cache = createPluginCache();
  withPluginCache(cache, () => {
    const artifact = capturePluginGenerationArtifact(root, undefined, (run) => run());
    const recovery = artifact.captureRecoverySource();
    const fork = recovery.fork();
    try {
      for (const source of [recovery, fork]) {
        const filename = source.resolve(selected);
        expect(source.directories.has(filename)).toBe(true);
        let failure: unknown;
        try {
          readPluginCapturedCode(filename, source.directories.has(filename));
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject({ name: "Error", code: "EISDIR" });
        expect(isPluginSourceAcquisitionError(failure)).toBe(true);
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        let failure: unknown;
        try {
          artifact.prepareModule(artifact.resolve(selected));
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject({ name: "Error", code: "EISDIR" });
        expect(isPluginSourceAcquisitionError(failure)).toBe(true);
      }
    } finally {
      fork.dispose();
      recovery.dispose();
      artifact.dispose();
    }
  });
});
