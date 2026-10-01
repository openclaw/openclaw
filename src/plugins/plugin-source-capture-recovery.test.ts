import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as notes from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { noteLegacyPluginSourceCaptures } from "../commands/doctor-plugin-source-captures.js";
import * as temporaryDirectories from "../commands/doctor/shared/temporary-directories.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import * as census from "../infra/openclaw-process-census.js";
import * as sqliteDiagnostics from "../infra/sqlite-error-diagnostics.js";
import * as stagingOwner from "../infra/sqlite-snapshot-staging-owner.js";
import * as stagingToken from "../infra/sqlite-staging-token.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import * as captureDirectory from "./plugin-source-capture-directory.js";
import {
  createPluginNativeCaptureRoot,
  startPluginSourceCaptureRoot,
  retainPluginNativeCapturePath,
  retainPluginSourceCaptureInstance,
} from "./plugin-source-capture-directory.js";
import { sweepPluginSourceCapturesForTest } from "./plugin-source-capture-directory.test-support.js";
import {
  expectCaptureFinalRemovalRetry,
  expectReclamationRetryAfterTargetLoss,
} from "./plugin-source-capture-recovery-native.test-support.js";

const temp = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    clearPluginMetadataLifecycleCaches();
    await closeOpenClawStateDatabaseAsync();
    // Join the shared native broker before removing its temporary socket directory.
    await drainGlobalSingletonLifecycleState();
    cleanup();
  }),
);
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

it.each([
  "release",
  "preparation",
  "directory-replacement",
  "token-replacement",
  "root-absent",
] as const)("retains original authority through partial final removal (%s)", async (scenario) => {
  await expectCaptureFinalRemovalRetry(temp.make("capture-final-removal-"), scenario);
});

it("retries original non-destructive reclamation cleanup after target loss and sibling release", async () => {
  await expectReclamationRetryAfterTargetLoss(temp.make("capture-original-token-retry-"));
}, 30_000);

it("retains a capture without warning on real held-token contention, then reclaims after release", async () => {
  const stateDir = temp.make("capture-held-token-");
  const root = path.join(stateDir, "tmp", "plugin-captures", "held-producer");
  const captures = path.join(root, "captures");
  const payload = path.join(captures, "source.js");
  fs.mkdirSync(captures, { recursive: true });
  fs.writeFileSync(payload, "source held by the original producer");
  const producer = stagingToken.acquireSqliteStagingToken(root, "create");
  let held = true;
  const old = new Date(Date.now() - 2 * hour);
  fs.utimesSync(root, old, old);
  const admissions: Array<ReturnType<typeof stagingOwner.startWorkerOwnedSqliteStagingToken>> = [];
  const start = stagingOwner.startWorkerOwnedSqliteStagingToken;
  const observing = vi
    .spyOn(stagingOwner, "startWorkerOwnedSqliteStagingToken")
    .mockImplementation((...args) => {
      const admission = start(...args);
      if (args[0] === root && args[1] === "reclaim") {
        admissions.push(admission);
      }
      return admission;
    });
  const warning = vi.spyOn(process, "emitWarning");
  warning.mockClear();
  try {
    // Only stat the held token; closing another descriptor could drop its POSIX lock.
    await sweepPluginSourceCapturesForTest(stateDir);
    expect(admissions.length).toBe(1);
    const blocked = admissions[0];
    if (!blocked) {
      throw new Error("Expected an actual reclaim attempt against the held token");
    }
    const refusal = blocked.read();
    expect(refusal.status).toBe("rejected");
    if (refusal.status !== "rejected") {
      throw new Error("The original producer did not fence native reclamation");
    }
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.readFileSync(payload, "utf8")).toBe("source held by the original producer");
    expect(warning.mock.calls.length).toBe(0);
    expect(sqliteDiagnostics.sqliteErrorCode(refusal.error)).toBe("ERR_SQLITE_ERROR");
    expect(sqliteDiagnostics.sqliteExtendedResultCode(refusal.error)).toBe(5);
    await blocked.startClose().result;
    producer();
    held = false;
    fs.utimesSync(root, old, old);
    await sweepPluginSourceCapturesForTest(stateDir);
    expect(admissions.length).toBe(2);
    const resumed = admissions[1];
    if (!resumed) {
      throw new Error("Expected native reclamation after the producer released its token");
    }
    expect(resumed.read().status).toBe("fulfilled");
    expect(fs.existsSync(root)).toBe(false);
    expect(warning.mock.calls.length).toBe(0);
  } finally {
    observing.mockRestore();
    try {
      if (held) {
        producer();
      }
    } finally {
      const closed = await Promise.allSettled(
        admissions.map(async (admission) => await admission.startClose().result),
      );
      for (const outcome of closed) {
        expect(outcome.status).toBe("fulfilled");
      }
    }
  }
});

it.each(["failed removal", "maintenance failed removal", "identity-change return"] as const)(
  "preserves reclamation errors and closes the original token after %s",
  async (mode) => {
    const stateDir = temp.make("capture-reclaim-close-");
    const root = path.join(stateDir, "tmp", "plugin-captures", "released-producer");
    const captures = path.join(root, "captures");
    const payload = path.join(captures, "source.js");
    const tokenPath = path.join(root, stagingToken.SQLITE_STAGING_TOKEN_FILES[0]);
    const extraLink = path.join(stateDir, "token-hardlink.sqlite");
    fs.mkdirSync(captures, { recursive: true });
    fs.writeFileSync(payload, "retained source bytes");
    stagingToken.acquireSqliteStagingToken(root, "create")();
    const old = new Date(Date.now() - 2 * hour);
    fs.utimesSync(root, old, old);
    const primary = Object.assign(new Error("Fixture capture removal refused"), { code: "EACCES" });
    const cleanup = Object.assign(new Error("Fixture token close refused once"), {
      code: mode === "identity-change return" ? "EACCES" : "SQLITE_BUSY",
    });
    let closeRefused = false;
    let original: ReturnType<typeof stagingOwner.startWorkerOwnedSqliteStagingToken> | undefined;
    const start = stagingOwner.startWorkerOwnedSqliteStagingToken;
    const acquiring = vi
      .spyOn(stagingOwner, "startWorkerOwnedSqliteStagingToken")
      .mockImplementation((...args) => {
        const admission = start(...args);
        if (args[0] !== root || args[1] !== "reclaim") {
          return admission;
        }
        original = admission;
        return {
          ...admission,
          result: admission.result.then((token) => {
            if (mode === "identity-change return") {
              // A second link invalidates destructive custody without touching the held descriptor.
              fs.linkSync(tokenPath, extraLink);
            }
            return {
              ...token,
              async close() {
                if (!closeRefused) {
                  closeRefused = true;
                  throw cleanup;
                }
                await token.close();
              },
            };
          }),
        };
      });
    const remove = fsPromises.rm.bind(fsPromises);
    const removal = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
      if (mode !== "identity-change return" && target === captures) {
        throw primary;
      }
      await remove(target, options);
    });
    const classification = vi.spyOn(sqliteDiagnostics, "isSqliteLockError");
    const warning = vi.spyOn(process, "emitWarning");
    warning.mockClear();
    const collectWarnings = async () => {
      if (mode !== "maintenance failed removal") {
        await sweepPluginSourceCapturesForTest(stateDir);
        return warning.mock.calls.map(([message]) => String(message));
      }
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const lease = acquireGatewayStateOwner({ databasePath: resolveOpenClawStateSqlitePath(env) });
      const scope = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent: lease.assertCurrent,
        assertDatabaseAccess: lease.assertDatabaseAccess,
      });
      try {
        const result = await scope.run(() =>
          captureDirectory.prunePluginNativeCaptureDirectories(stateDir, new Set(), () =>
            scope.assertAdmission(),
          ),
        );
        return result.warnings;
      } finally {
        try {
          await scope.close();
        } finally {
          lease.release();
        }
      }
    };
    try {
      const messages = await collectWarnings();
      expect(closeRefused).toBe(true);
      expect(messages.length).toBe(1);
      expect(messages[0]?.includes(cleanup.message)).toBe(true);
      if (mode !== "identity-change return") {
        expect(messages[0]?.includes(primary.message)).toBe(true);
        const failure = classification.mock.calls.find(
          ([error]) => error instanceof AggregateError && error.cause === primary,
        )?.[0];
        if (!(failure instanceof AggregateError)) {
          throw new Error("Expected the original reclamation and cleanup failures");
        }
        expect(failure.cause === primary).toBe(true);
        expect(failure.errors.length).toBe(2);
        expect(failure.errors[0] === primary).toBe(true);
        expect(failure.errors[1] === cleanup).toBe(true);
      } else {
        expect(classification.mock.calls.some(([error]) => error === cleanup)).toBe(true);
        expect(fs.lstatSync(tokenPath).nlink).toBe(2);
      }
      expect(fs.readFileSync(payload, "utf8")).toBe("retained source bytes");
      expect(fs.existsSync(tokenPath)).toBe(true);
    } finally {
      removal.mockRestore();
      acquiring.mockRestore();
      classification.mockRestore();
      try {
        fs.rmSync(extraLink, { force: true });
      } finally {
        await original?.startRelease().result;
      }
    }
    fs.utimesSync(root, old, old);
    const after = await collectWarnings();
    expect(fs.existsSync(root)).toBe(false);
    expect(after.length).toBe(mode === "maintenance failed removal" ? 0 : 1);
  },
);

it.each(["sync", "async"] as const)(
  "preserves the original %s preparation failure when token cleanup also fails",
  async (mode) => {
    const stateDir = temp.make("capture-error-cause-");
    const instance = mode === "sync" ? retainPluginSourceCaptureInstance(stateDir) : undefined;
    await sweepPluginSourceCapturesForTest(stateDir);
    const primary = new Error("Fixture first capture refused");
    const cleanup = new Error("Fixture token retirement refused once");
    let ownedRoot: string | undefined;
    let refuseCleanup = true;
    let admission: ReturnType<typeof stagingOwner.startWorkerOwnedSqliteStagingToken> | undefined;
    let capture: ReturnType<typeof startPluginSourceCaptureRoot> | undefined;
    if (mode === "sync") {
      const acquire = stagingToken.acquireSqliteStagingToken;
      vi.spyOn(stagingToken, "acquireSqliteStagingToken").mockImplementation((...args) => {
        const token = acquire(...args);
        ownedRoot = args[0];
        return Object.assign((retiring?: boolean) => {
          if (retiring && refuseCleanup) {
            refuseCleanup = false;
            throw cleanup;
          }
          token(retiring);
        }, token);
      });
      const mkdtemp = fs.mkdtempSync.bind(fs);
      vi.spyOn(fs, "mkdtempSync").mockImplementation((...args) => {
        if (ownedRoot && args[0].startsWith(path.join(ownedRoot, "captures") + path.sep)) {
          throw primary;
        }
        return mkdtemp(...args);
      });
    } else {
      const start = stagingOwner.startWorkerOwnedSqliteStagingToken;
      vi.spyOn(stagingOwner, "startWorkerOwnedSqliteStagingToken").mockImplementation((...args) => {
        const started = start(...args);
        admission = started;
        ownedRoot = args[0];
        vi.spyOn(started, "startClose").mockImplementationOnce(() => {
          refuseCleanup = false;
          throw cleanup;
        });
        return started;
      });
      const mkdtemp = fsPromises.mkdtemp.bind(fsPromises);
      vi.spyOn(fsPromises, "mkdtemp").mockImplementation(async (...args) => {
        if (ownedRoot && args[0].startsWith(path.join(ownedRoot, "captures") + path.sep)) {
          throw primary;
        }
        return mkdtemp(...args);
      });
    }
    try {
      let failure: unknown;
      try {
        if (instance) {
          instance.createDirectory();
        } else {
          capture = startPluginSourceCaptureRoot(stateDir, "capture-error-");
          await capture.result;
        }
      } catch (error) {
        failure = error;
      }
      if (!(failure instanceof AggregateError)) {
        throw new Error("Expected the paired preparation and cleanup refusal", { cause: failure });
      }
      expect(failure.cause).toBe(primary);
      expect(failure.errors.length).toBe(2);
      expect(failure.errors[0]).toBe(primary);
      expect(failure.errors[1]).toBe(cleanup);
      expect(refuseCleanup).toBe(false);
      if (capture) {
        const blocked = startPluginSourceCaptureRoot(stateDir, "capture-blocked-");
        try {
          await expect(blocked.result).rejects.toThrow(
            "Plugin source instance cleanup is incomplete",
          );
        } finally {
          await blocked.release();
        }
        await expect(capture.release()).rejects.toBe(cleanup);
        await expect(capture.result).rejects.toBe(failure);
        expect(ownedRoot !== undefined && fs.existsSync(ownedRoot)).toBe(true);
      }
    } finally {
      vi.restoreAllMocks();
      try {
        await instance?.releaseAsync();
        await capture?.release();
      } finally {
        await admission?.startClose().result;
      }
    }
    expect(ownedRoot !== undefined && fs.existsSync(ownedRoot)).toBe(false);
    if (capture) {
      const recovered = startPluginSourceCaptureRoot(stateDir, "capture-recovered-");
      try {
        const root = await recovered.result;
        root.assertCurrent();
        expect(fs.existsSync(root.directory)).toBe(true);
      } finally {
        await recovered.release();
      }
    }
  },
);

it("recovers a removed captures directory without releasing a live instance", async () => {
  const stateDir = temp.make("capture-recovery-missing-");
  const first = startPluginSourceCaptureRoot(stateDir, "capture-first-");
  let worker: ReturnType<typeof startPluginSourceCaptureRoot> | undefined;
  let next: ReturnType<typeof startPluginSourceCaptureRoot> | undefined;
  try {
    const firstRoot = await first.result;
    const captures = path.dirname(firstRoot.directory);
    const root = path.dirname(captures);
    await sweepPluginSourceCapturesForTest(stateDir);
    fs.rmSync(captures, { recursive: true });
    worker = startPluginSourceCaptureRoot(stateDir, "openclaw-model-catalog-");
    const workerRoot = await worker.result;
    fs.writeFileSync(path.join(workerRoot.directory, "source.js"), "recovered capture");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * hour);
    await sweepPluginSourceCapturesForTest(stateDir);
    expect(fs.readFileSync(path.join(workerRoot.directory, "source.js"), "utf8")).toBe(
      "recovered capture",
    );
    await worker.release();
    expect(fs.existsSync(root)).toBe(true);
    next = startPluginSourceCaptureRoot(stateDir, "capture-next-");
    const nextRoot = await next.result;
    expect(fs.readdirSync(captures)).toEqual([path.basename(nextRoot.directory)]);
    await next.release();
    await first.release();
    expect(fs.existsSync(root)).toBe(false);
  } finally {
    try {
      await next?.release();
    } finally {
      try {
        await worker?.release();
      } finally {
        await first.release();
      }
    }
  }
});

it.each(["sync", "async"])(
  "keeps published native bytes across %s disposal and later ordinary sweeps",
  async (mode) => {
    const stateDir = temp.make("native-capture-retention-");
    const committed = createPluginNativeCaptureRoot(stateDir);
    const pending = createPluginNativeCaptureRoot(stateDir);
    const worker = startPluginSourceCaptureRoot(stateDir, "openclaw-model-catalog-");
    try {
      const workerRoot = await worker.result;
      const payload = path.join(committed.directory, "package", "bin", "native");
      fs.mkdirSync(path.dirname(payload), { recursive: true });
      fs.writeFileSync(payload, "retained native bytes");
      fs.writeFileSync(path.join(pending.directory, "native"), "unpublished bytes");
      committed.commit();
      if (mode === "sync") {
        committed.dispose();
        pending.dispose();
      } else {
        await committed.disposeAsync();
        await pending.disposeAsync();
      }
      await worker.release();
      expect(fs.existsSync(pending.directory)).toBe(false);
      expect(fs.existsSync(workerRoot.directory)).toBe(false);
      const instance = path.dirname(path.dirname(committed.directory));
      expect(fs.existsSync(path.join(instance, "owner.sqlite"))).toBe(true);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 2 * hour);
      await sweepPluginSourceCapturesForTest(stateDir);
      expect(fs.readFileSync(payload, "utf8")).toBe("retained native bytes");
      expect(fs.existsSync(path.join(instance, "owner.sqlite"))).toBe(true);
    } finally {
      try {
        await worker.release();
      } finally {
        if (mode === "sync") {
          try {
            committed.dispose();
          } finally {
            pending.dispose();
          }
        } else {
          try {
            await committed.disposeAsync();
          } finally {
            await pending.disposeAsync();
          }
        }
      }
    }
  },
);

it("preserves native bytes published after an unlocked missing-directory observation", async () => {
  const stateDir = temp.make("native-capture-publication-race-");
  const instance = path.join(stateDir, "tmp", "plugin-captures", "producer");
  const native = path.join(instance, "native");
  const payload = path.join(native, "admission", "module.node");
  fs.mkdirSync(instance, { recursive: true });
  const producer = stagingToken.acquireSqliteStagingToken(instance, "create");
  const old = new Date(Date.now() - 2 * hour);
  fs.utimesSync(instance, old, old);
  const lstat = fsPromises.lstat.bind(fsPromises);
  let published = false;
  const observe = vi.spyOn(fsPromises, "lstat").mockImplementation(async (target, options) => {
    try {
      return await lstat(target, options);
    } catch (error) {
      if (target === native && !published) {
        expect(error).toMatchObject({ code: "ENOENT" });
        fs.mkdirSync(path.dirname(payload), { recursive: true });
        fs.writeFileSync(payload, "published while the producer still held its token");
        producer(true);
        published = true;
      }
      throw error;
    }
  });
  try {
    await sweepPluginSourceCapturesForTest(stateDir);
    expect(published).toBe(true);
    expect(fs.readFileSync(payload, "utf8")).toBe(
      "published while the producer still held its token",
    );
  } finally {
    observe.mockRestore();
    producer();
  }
});

it.each(["sync", "async"])("preserves custody after partial %s disposal", async (mode) => {
  const stateDir = temp.make("capture-recovery-state-");
  const instance = mode === "sync" ? retainPluginSourceCaptureInstance(stateDir) : undefined;
  const worker =
    mode === "async"
      ? startPluginSourceCaptureRoot(stateDir, "openclaw-model-catalog-")
      : undefined;
  let retainedRoot: string | undefined;
  try {
    const workerRoot = await worker?.result;
    await sweepPluginSourceCapturesForTest(stateDir);
    const directory = workerRoot?.directory ?? instance!.createDirectory();
    const root = path.dirname(path.dirname(directory));
    retainedRoot = root;
    const payload = path.join(directory, "source.js");
    fs.writeFileSync(payload, "export default 1");
    const removeSync = fs.rmSync.bind(fs);
    const remove = fsPromises.rm.bind(fsPromises);
    const interruptRemoval = (target: fs.PathLike) => {
      if (target === root) {
        // Recursive rm can unlink the token before encountering a locked payload.
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
    if (instance) {
      expect(() => instance.release()).toThrow(locked);
    } else {
      await expect(worker!.release()).rejects.toBe(locked);
    }
    expect(fs.readFileSync(payload, "utf8")).toBe("export default 1");
    const tokenless = fs
      .readdirSync(path.dirname(root))
      .filter((name) => !fs.existsSync(path.join(path.dirname(root), name, "owner.sqlite")));
    expect(tokenless).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    try {
      instance?.release();
    } finally {
      await worker?.release();
    }
  }
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 2 * hour);
  await sweepPluginSourceCapturesForTest(stateDir);
  if (!retainedRoot) {
    throw new Error("Expected the original capture root for disposal verification");
  }
  expect(fs.existsSync(retainedRoot)).toBe(false);
});

it.each(["lease", "canonical path", "captures", "first capture"])(
  "leaves no tokenless roots when %s preparation fails",
  async (stage) => {
    const stateDir = temp.make("capture-recovery-allocation-");
    const instance = retainPluginSourceCaptureInstance(stateDir);
    await sweepPluginSourceCapturesForTest(stateDir);
    const managed = path.join(stateDir, "tmp", "plugin-captures");
    const acquire = stagingToken.acquireSqliteStagingToken;
    const realpath = fs.realpathSync.bind(fs);
    const mkdir = fs.mkdirSync.bind(fs);
    const mkdtemp = fs.mkdtempSync.bind(fs);
    if (stage === "lease") {
      vi.spyOn(stagingToken, "acquireSqliteStagingToken").mockImplementation(
        (directory, mode, options) => {
          if (directory.startsWith(managed + path.sep)) {
            throw locked;
          }
          return acquire(directory, mode, options);
        },
      );
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
  await sweepPluginSourceCapturesForTest(stateDir);
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
  await sweepPluginSourceCapturesForTest(stateDir);
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
    await sweepPluginSourceCapturesForTest(stateDir);
  }
  fault.mockRestore();
  vi.setSystemTime(Date.now() + 2 * hour);
  await sweepPluginSourceCapturesForTest(stateDir);
  expect(fs.readdirSync(managed)).toEqual([]);
});

it.each(["managed", "fallback"] as const)(
  "reclaims only unreferenced native roots under maintenance while preserving live custody (%s)",
  async (location) => {
    const stateDir = temp.make("native-capture-maintenance-");
    const otherStateDir = temp.make("native-capture-other-state-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    if (location === "fallback") {
      const mkdir = fs.mkdirSync.bind(fs);
      const blocked = new Set(
        [stateDir, otherStateDir].map((directory) =>
          path.join(directory, "tmp", "plugin-captures"),
        ),
      );
      vi.spyOn(fs, "mkdirSync").mockImplementation((target, options) => {
        if (blocked.has(String(target))) {
          throw locked;
        }
        return mkdir(target, options);
      });
    }
    const note = vi.spyOn(notes, "note").mockImplementation(() => {});
    const inspectProcesses = vi.spyOn(census, "inspectOtherOpenClawProcesses");
    vi.spyOn(temporaryDirectories, "inspectDoctorTemporaryDirectories").mockImplementation(
      async () => ({
        directories: [],
        warnings: [],
      }),
    );
    const realpath = fsPromises.realpath.bind(fsPromises);
    vi.spyOn(fsPromises, "realpath").mockImplementation(async (target) =>
      realpath(String(target) === "/tmp" ? tmpdir() : target),
    );
    const runCaptureReport = async () => {
      note.mockClear();
      await noteLegacyPluginSourceCaptures(env, true);
      return note.mock.calls.map(([message]) => String(message)).join("\n");
    };
    const duringMaintenance = async () => {
      const lease = acquireGatewayStateOwner({
        databasePath: resolveOpenClawStateSqlitePath(env),
      });
      const scope = createOpenClawDatabaseMaintenanceScope({
        schemaMaintenance: true,
        assertOwnerCurrent: lease.assertCurrent,
        assertDatabaseAccess: lease.assertDatabaseAccess,
      });
      try {
        return await scope.run(runCaptureReport);
      } finally {
        await scope.close();
        lease.release();
      }
    };
    const write = (root: string, filename: string, contents: string) => {
      const file = path.join(root, filename);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
      return file;
    };
    const referenced = createPluginNativeCaptureRoot(stateDir);
    const captured = write(referenced.directory, "content/bin/native", "published native bytes");
    referenced.commit();
    referenced.dispose();
    const orphan = createPluginNativeCaptureRoot(stateDir);
    write(orphan.directory, "package/bin/native", "superseded native bytes");
    orphan.commit();
    orphan.dispose();
    const warm = createPluginNativeCaptureRoot(stateDir);
    const warmFile = write(warm.directory, "package/bin/native", "warm generation bytes");
    warm.commit();
    warm.dispose();
    const releaseWarm = retainPluginNativeCapturePath(warmFile);
    const tokenless = createPluginNativeCaptureRoot(stateDir);
    const tokenlessFile = write(tokenless.directory, "package/bin/native", "unknown custody");
    tokenless.commit();
    tokenless.dispose();
    fs.rmSync(path.join(path.dirname(path.dirname(tokenless.directory)), "owner.sqlite"));
    const live = createPluginNativeCaptureRoot(stateDir);
    const liveFile = write(live.directory, "package/bin/native", "currently in use");
    const other = createPluginNativeCaptureRoot(otherStateDir);
    const otherFile = write(other.directory, "package/bin/native", "another state's payload");
    other.commit();
    other.dispose();
    const unknown = path.join(tmpdir(), "openclaw-plugin-captures-legacy");
    fs.mkdirSync(unknown);
    const legacyToken = stagingToken.acquireSqliteStagingToken(unknown, "create");
    let legacyFile: string;
    try {
      legacyFile = write(unknown, "native/legacy/module.node", "unqualified legacy payload");
    } finally {
      legacyToken(true);
    }
    await writePersistedInstalledPluginIndex(
      {
        version: 1,
        hostContractVersion: "fixture",
        compatRegistryVersion: "fixture",
        migrationVersion: 1,
        policyHash: "fixture",
        generatedAtMs: Date.now(),
        installRecords: {},
        plugins: [
          {
            pluginId: "fixture",
            manifestPath: "/fixture/openclaw.plugin.json",
            manifestHash: "fixture",
            rootDir: "/fixture",
            origin: "global",
            enabled: true,
            startup: { sidecar: false, memory: false, agentHarnesses: [] },
            compat: [],
            sourceAdmissions: {
              fixture: {
                signature: "fixture",
                sourceDigest: "a".repeat(64),
                nativeArtifacts: {
                  "bin/native": {
                    sourceIdentity: "fixture",
                    contentHash: "b".repeat(64),
                    sizeBytes: 22,
                    capturedPath: captured,
                    namespace: referenced.directory,
                    capturedIdentity: "fixture",
                  },
                },
                nativeNamespaces: {
                  [referenced.directory]: {
                    sourceDirectory: "/fixture",
                    capturedRoot: referenced.directory,
                    managed: false,
                    members: {
                      "bin/native": {
                        source: "/fixture/bin/native",
                        sourceIdentity: "fixture",
                        capturedIdentity: "fixture",
                        boundaryChecked: false,
                        contentHash: "b".repeat(64),
                        sizeBytes: 22,
                      },
                    },
                  },
                },
              },
            },
          },
        ],
        diagnostics: [],
      },
      { stateDir },
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1_000);
    try {
      inspectProcesses.mockReturnValue({ error: "fixture unreadable host argv" });
      const output = await duringMaintenance();
      expect(output).toContain("Removed 1 unreferenced native plugin capture root(s).");
      expect(fs.existsSync(orphan.directory)).toBe(false);
      expect(fs.readFileSync(captured, "utf8")).toBe("published native bytes");
      expect(fs.readFileSync(warmFile, "utf8")).toBe("warm generation bytes");
      expect(fs.readFileSync(liveFile, "utf8")).toBe("currently in use");
      expect(fs.readFileSync(otherFile, "utf8")).toBe("another state's payload");
      expect(fs.readFileSync(legacyFile, "utf8")).toBe("unqualified legacy payload");
      expect(fs.readFileSync(tokenlessFile, "utf8")).toBe("unknown custody");
      expect(inspectProcesses).not.toHaveBeenCalled();
      releaseWarm();
      await duringMaintenance();
      expect(fs.existsSync(warm.directory)).toBe(false);
      expect(fs.readFileSync(otherFile, "utf8")).toBe("another state's payload");
      expect(fs.readFileSync(legacyFile, "utf8")).toBe("unqualified legacy payload");
      expect(fs.readFileSync(tokenlessFile, "utf8")).toBe("unknown custody");
    } finally {
      releaseWarm();
      live.dispose();
    }
  },
);

it("preserves artifact setup failure and borrowed custody when partial removal fails", async () => {
  const stateDir = temp.make("capture-artifact-cleanup-");
  const source = temp.make("capture-artifact-source-");
  const owner = retainPluginSourceCaptureInstance(stateDir);
  const first = owner.createDirectory();
  const root = path.dirname(path.dirname(first));
  await sweepPluginSourceCapturesForTest(stateDir);
  const primary = new Error("Fixture artifact permissions refused");
  const cleanup = new Error("Fixture partial capture removal refused");
  let borrowed: ReturnType<typeof retainPluginSourceCaptureInstance> | undefined;
  let created: string | undefined;
  const retain = captureDirectory.retainPluginSourceCaptureInstance;
  vi.spyOn(captureDirectory, "retainPluginSourceCaptureInstance").mockImplementation((...args) => {
    borrowed = retain(...args);
    return borrowed;
  });
  const chmod = fs.chmodSync.bind(fs);
  vi.spyOn(fs, "chmodSync").mockImplementation((target, mode) => {
    if (typeof target === "string" && path.dirname(target) === path.dirname(first)) {
      created = target;
      throw primary;
    }
    return chmod(target, mode);
  });
  const remove = fs.rmSync.bind(fs);
  vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
    if (target === created) {
      throw cleanup;
    }
    return remove(target, options);
  });
  try {
    let failure: unknown;
    try {
      withPluginSourceCaptureStorage({ stateDir, placement: "state" }, () =>
        capturePluginGenerationArtifact(source),
      );
    } catch (error) {
      failure = error;
    }
    if (!(failure instanceof AggregateError)) {
      throw new Error("Expected the artifact setup and removal failures", { cause: failure });
    }
    expect(failure.cause).toBe(primary);
    expect(failure.errors.length).toBe(2);
    expect(failure.errors[0]).toBe(primary);
    expect(failure.errors[1]).toBe(cleanup);
    if (!borrowed) {
      throw new Error("Expected the artifact to borrow its capture instance");
    }
    const releasedBorrower = borrowed;
    expect(() => releasedBorrower.createDirectory()).toThrow(
      "Plugin source instance has been released",
    );
    expect(created !== undefined && fs.existsSync(created)).toBe(true);
  } finally {
    vi.restoreAllMocks();
    try {
      await borrowed?.releaseAsync();
    } finally {
      await owner.releaseAsync();
    }
  }
  expect(fs.existsSync(root)).toBe(false);
});
