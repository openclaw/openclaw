import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as census from "../infra/openclaw-process-census.js";
import * as coordinator from "../infra/sqlite-coordinator.js";
import {
  createPluginSourceCaptureRoot,
  retainPluginSourceCaptureInstance,
  sweepPluginSourceCaptureDirectories,
} from "./plugin-source-capture-directory.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
const hour = 60 * 60 * 1_000;
const locked = Object.assign(new Error("Fixture Windows sharing violation"), { code: "EPERM" });

beforeEach(() => {
  const temporary = temp.make("capture-recovery-temp-");
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    vi.stubEnv(key, temporary);
  }
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each(["sync", "async"])("preserves custody after partial %s disposal", async (mode) => {
  const stateDir = temp.make("capture-recovery-state-");
  const instance = mode === "sync" ? retainPluginSourceCaptureInstance(stateDir) : undefined;
  const worker =
    mode === "async"
      ? createPluginSourceCaptureRoot(stateDir, "openclaw-model-catalog-")
      : undefined;
  await sweepPluginSourceCaptureDirectories(stateDir);
  const directory = worker?.directory ?? instance!.createDirectory();
  const root = path.dirname(path.dirname(directory));
  const payload = path.join(directory, "source.js");
  fs.writeFileSync(payload, "export default 1");
  const removeSync = fs.rmSync.bind(fs);
  const remove = fsPromises.rm.bind(fsPromises);
  const interruptRemoval = (target: fs.PathLike) => {
    if (target === root) {
      // Recursive rm can unlink the coordinator before encountering a locked payload.
      removeSync(path.join(root, "owner.sqlite"), { force: true });
      throw locked;
    }
    if (target === directory || target === path.join(root, "captures")) {
      throw locked;
    }
  };
  vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
    interruptRemoval(target);
    removeSync(target, options);
  });
  vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
    interruptRemoval(target);
    await remove(target, options);
  });
  try {
    if (instance) {
      expect(() => instance.release()).toThrow(locked);
    } else {
      await worker!.release();
    }
    expect(fs.readFileSync(payload, "utf8")).toBe("export default 1");
    const tokenless = fs
      .readdirSync(path.dirname(root))
      .filter((name) => !fs.existsSync(path.join(path.dirname(root), name, "owner.sqlite")));
    expect(tokenless).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    instance?.release();
    await worker?.release();
  }
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 2 * hour);
  await sweepPluginSourceCaptureDirectories(stateDir);
  expect(fs.existsSync(root)).toBe(false);
});

it.each(["lease", "canonical path", "captures", "first capture"])(
  "leaves no tokenless roots when %s preparation fails",
  async (stage) => {
    const stateDir = temp.make("capture-recovery-allocation-");
    const instance = retainPluginSourceCaptureInstance(stateDir);
    await sweepPluginSourceCaptureDirectories(stateDir);
    const managed = path.join(stateDir, "tmp", "plugin-captures");
    const acquire = coordinator.tryAcquireExclusiveSqliteCoordinator;
    const realpath = fs.realpathSync.bind(fs);
    const mkdir = fs.mkdirSync.bind(fs);
    const mkdtemp = fs.mkdtempSync.bind(fs);
    if (stage === "lease") {
      vi.spyOn(coordinator, "tryAcquireExclusiveSqliteCoordinator").mockImplementation((file) => {
        if (file.startsWith(managed + path.sep)) {
          throw locked;
        }
        return acquire(file);
      });
    } else if (stage === "canonical path") {
      vi.spyOn(fs, "realpathSync").mockImplementation((file, options) => {
        if (String(file).startsWith(managed + path.sep)) {
          throw locked;
        }
        return realpath(file, options);
      });
    } else if (stage === "captures") {
      vi.spyOn(fs, "mkdirSync").mockImplementation((file, options) => {
        if (
          String(file).startsWith(managed + path.sep) &&
          path.basename(String(file)) === "captures"
        ) {
          throw locked;
        }
        return mkdir(file, options);
      });
    } else {
      vi.spyOn(fs, "mkdtempSync").mockImplementation((prefix, options) => {
        if (prefix.startsWith(managed + path.sep)) {
          throw locked;
        }
        return mkdtemp(prefix, options);
      });
    }
    try {
      const directory = instance.createDirectory();
      fs.writeFileSync(path.join(directory, "source.js"), "captured after fallback");
      expect(fs.readdirSync(managed)).toEqual([]);
      expect(fs.existsSync(path.join(path.dirname(path.dirname(directory)), "owner.sqlite"))).toBe(
        true,
      );
    } finally {
      vi.restoreAllMocks();
      await instance.releaseAsync();
    }
    expect(
      fs.readdirSync(tmpdir()).filter((name) => name.startsWith("openclaw-plugin-captures-")),
    ).toEqual([]);
  },
);

it("reclaims aged tokenless roots without a census and retries locked roots", async () => {
  const stateDir = temp.make("capture-recovery-legacy-");
  const stateTemp = path.join(stateDir, "tmp");
  fs.mkdirSync(stateTemp);
  vi.spyOn(census, "inspectOtherOpenClawProcesses").mockReturnValue({
    error: "Exact process command census is unavailable on win32.",
  });
  const create = (parent: string, name: string) => {
    const directory = path.join(parent, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "source.js"), Buffer.alloc(1024));
    return directory;
  };
  const old = Array.from({ length: 87 }, (_, index) =>
    create(tmpdir(), `openclaw-plugin-build-${index}`),
  );
  const catalog = create(stateTemp, "openclaw-model-catalog-old");
  const busy = create(tmpdir(), "openclaw-plugin-build-locked");
  const tokened = create(tmpdir(), "openclaw-plugin-build-owned");
  fs.writeFileSync(path.join(tokened, "owner.sqlite"), "");
  const unrelated = create(tmpdir(), "unrelated");
  const link = path.join(tmpdir(), "openclaw-plugin-build-link");
  fs.symlinkSync(unrelated, link, "junction");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 2 * hour);
  const fresh = create(tmpdir(), "openclaw-plugin-build-fresh");
  // Filesystem timestamps use the real clock even when Date is faked.
  fs.utimesSync(fresh, new Date(), new Date());
  const rename = fsPromises.rename.bind(fsPromises);
  const probe = vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
    if (from === busy) {
      throw locked;
    }
    await rename(from, to);
  });
  await sweepPluginSourceCaptureDirectories(stateDir);
  expect(old.filter((directory) => fs.existsSync(directory))).toHaveLength(0);
  expect(fs.existsSync(catalog)).toBe(false);
  for (const kept of [fresh, busy, tokened, unrelated, link]) {
    expect(fs.existsSync(kept)).toBe(true);
  }
  // Renaming alone must not count as reclaiming the payload.
  expect(fs.readdirSync(stateTemp)).toEqual([]);
  const retainedNames = () =>
    fs
      .readdirSync(tmpdir())
      .filter((name) => name.startsWith("openclaw-"))
      .toSorted();
  expect(retainedNames()).toEqual(
    [fresh, busy, tokened, link].map((file) => path.basename(file)).toSorted(),
  );
  probe.mockRestore();
  await sweepPluginSourceCaptureDirectories(stateDir);
  expect(fs.existsSync(busy)).toBe(false);
  expect(retainedNames()).toEqual(
    [fresh, tokened, link].map((file) => path.basename(file)).toSorted(),
  );
});

it("retries partial tokenless removal without exhausting directory name limits", async () => {
  const stateDir = temp.make("capture-recovery-retry-");
  const managed = path.join(stateDir, "tmp", "plugin-captures");
  const directory = path.join(managed, "interrupted-instance");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "source.js"), "retained payload");
  vi.useFakeTimers({ toFake: ["Date"] });
  const fault = vi.spyOn(fsPromises, "rm").mockRejectedValue(locked);
  for (let cycle = 0; cycle < 8; cycle++) {
    vi.setSystemTime(Date.now() + 2 * hour);
    await sweepPluginSourceCaptureDirectories(stateDir);
  }
  fault.mockRestore();
  vi.setSystemTime(Date.now() + 2 * hour);
  await sweepPluginSourceCaptureDirectories(stateDir);
  expect(fs.readdirSync(managed)).toEqual([]);
});
