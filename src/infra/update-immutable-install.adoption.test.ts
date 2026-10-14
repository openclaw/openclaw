import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createImmutableInstallRecord,
  immutableInstallReadOperations,
  updateImmutableInstallRecord,
} from "./package-update-activation-immutable.js";
import {
  packageActivationRuntimeIdentity,
  resolvePackageActivationAnchor,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-paths.js";
import { syntheticImmutableServiceObservation } from "./update-immutable-activation.test-support.js";
import type {
  ImmutableActivationOperation,
  ImmutableInstallRecord,
} from "./update-immutable-install-schema.js";
import { adoptImmutableInstall } from "./update-immutable-install.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  verify: vi.fn(),
  launcher: vi.fn(),
  inspect: vi.fn(),
  current: vi.fn(),
}));
vi.mock("./update-immutable-install-record.js", () => ({ readImmutableInstallRecord: mocks.read }));
vi.mock("./update-immutable-owner.js", () => ({
  withImmutableUpdateOwner: async (_root: string, run: (assertCurrent: () => void) => unknown) =>
    run(() => {}),
}));
vi.mock("../daemon/service-operation-lock.js", () => ({
  withGatewayServiceOperationLock: async (
    _env: unknown,
    run: (assertCurrent: () => void) => unknown,
  ) => run(() => {}),
}));
vi.mock("./update-immutable-generation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-immutable-generation.js")>()),
  verifyImmutableGeneration: mocks.verify,
  installImmutableLauncher: mocks.launcher,
}));
vi.mock("./update-immutable-service.js", () => ({
  verifyImmutableService: async () => {},
  inspectImmutableActivationService: mocks.inspect,
  assertImmutableServiceProcessCurrent: mocks.current,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const previousSha = "a".repeat(40);
const bridgeSha = "b".repeat(40);
const previousDigest = "1".repeat(64);
const bridgeDigest = "2".repeat(64);
let root: string;
let bridgePath: string;
let servingPath: string;
let original: ImmutableInstallRecord;
let params: Parameters<typeof adoptImmutableInstall>[0];
const identity = (file: string) => {
  const stat = fsSync.lstatSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};
const journal = () => resolvePackageActivationJournalPath(resolvePackageActivationAnchor(root));
const read = () =>
  immutableInstallReadOperations["immutableInstall.read"](
    { root },
    { path: journal(), env: process.env },
  );

function retainPendingActivation() {
  const descriptor = {
    ...original.descriptor,
    version: 2 as const,
    activationEnabled: true as const,
  };
  const file = { dev: "1", ino: "2", mode: 0o600, nlink: 1 as const, uid: 0, gid: 0 };
  const statePath = path.join(descriptor.service.stateDir, "openclaw.db");
  const operation: ImmutableActivationOperation = {
    version: 1,
    operationId: "b2a30aad-b116-4b9a-8984-679671ecfc66",
    authority: {
      databasePath: journal(),
      databaseIdentity: identity(journal()),
      parentIdentity: identity(path.dirname(journal())),
      installKey: root,
      owner: "synthetic-executor",
    },
    phase: "prepared",
    previous: descriptor.current,
    candidate: {
      sha: bridgeSha,
      path: bridgePath,
      identity: identity(bridgePath),
      buildDigest: bridgeDigest,
      preparedAtMs: 12,
    },
    serviceDigest: "3".repeat(64),
    startedAtMs: 12,
    protection: {
      capturedAtMs: 1,
      auditBoundary: null,
      state: {
        path: statePath,
        identity: file,
        pathProof: { targetPath: statePath, entries: [] },
        key: "synthetic",
      },
      config: [
        {
          path: descriptor.service.configPath,
          identity: file,
          pathProof: { targetPath: descriptor.service.configPath, entries: [] },
          hash: "4".repeat(64),
          fingerprint: {},
          policyFingerprint: "5".repeat(64),
        },
      ],
    },
    recovery: {
      root,
      path: path.join(path.dirname(journal()), `recovery-${previousSha}`),
      sha: previousSha,
      identity: "1:3",
      buildDigest: previousDigest,
      helperPath: path.join(path.dirname(journal()), "recovery.mjs"),
      helperIdentity: "1:4",
      helperDigest: "6".repeat(64),
    },
  };
  original = updateImmutableInstallRecord(
    original,
    { ...original, descriptor, activation: { operation } },
    () => {},
  );
}

describe.skipIf(process.platform !== "linux")("explicit immutable adoption after a bridge", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const parent = fsSync.realpathSync(dirs.make("immutable-bridge-adoption-"));
    root = path.join(parent, "installation");
    const previousPath = path.join(root, "releases", previousSha);
    bridgePath = path.join(root, "releases", bridgeSha);
    fsSync.mkdirSync(previousPath, { recursive: true, mode: 0o755 });
    fsSync.mkdirSync(bridgePath, { mode: 0o755 });
    fsSync.writeFileSync(path.join(previousPath, "retained"), "previous sealed bytes");
    fsSync.symlinkSync(`releases/${previousSha}`, path.join(root, "current"));
    const runtime = path.join(parent, "node");
    fsSync.writeFileSync(runtime, "synthetic external runtime", { mode: 0o755 });
    const runtimeParents = new Set<string>();
    for (let entry = parent; ; entry = path.dirname(entry)) {
      runtimeParents.add(entry);
      if (entry === path.dirname(entry)) {
        break;
      }
    }
    // Project privileged fixture ownership while preserving actual inodes,
    // bytes, SQLite transactions, and the external runtime path hierarchy.
    const lstat = fsSync.lstatSync;
    vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
      const stat = lstat(...args);
      const file = String(args[0]);
      if (stat && (runtimeParents.has(file) || file.startsWith(`${parent}${path.sep}`))) {
        Object.defineProperty(stat, "uid", { value: typeof stat.uid === "bigint" ? 0n : 0 });
        if (runtimeParents.has(file)) {
          Object.defineProperty(stat, "mode", {
            value: typeof stat.mode === "bigint" ? stat.mode & ~0o022n : stat.mode & ~0o022,
          });
        }
      }
      return stat;
    });
    const lstatAsync = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await lstatAsync(...args);
      if (String(args[0]) === runtime) {
        Object.defineProperty(stat, "uid", { value: typeof stat.uid === "bigint" ? 0n : 0 });
      }
      return stat;
    });
    if (process.geteuid) {
      vi.spyOn(process, "geteuid").mockReturnValue(0);
    }
    original = createImmutableInstallRecord(
      {
        version: 1,
        kind: "immutable",
        root,
        rootIdentity: identity(root),
        releasesIdentity: identity(path.join(root, "releases")),
        current: {
          sha: previousSha,
          path: previousPath,
          identity: identity(previousPath),
          pointerIdentity: identity(path.join(root, "current")),
          buildDigest: previousDigest,
        },
        service: {
          unit: "immutable-fixture.service",
          scope: "system",
          account: "synthetic",
          stateDir: path.join(parent, "state"),
          configPath: path.join(parent, "state", "openclaw.json"),
          profile: null,
        },
        runtime: { path: runtime, identity: packageActivationRuntimeIdentity(runtime) },
        source: "https://github.com/openclaw/openclaw.git",
      },
      () => {},
    );
    params = {
      root,
      service: original.descriptor.service,
      runtime,
      previousUpdaterStopped: true,
      enableActivation: true,
    };
    fsSync.symlinkSync(`releases/${bridgeSha}`, path.join(root, "bridge-current"));
    fsSync.renameSync(path.join(root, "bridge-current"), path.join(root, "current"));
    servingPath = bridgePath;
    mocks.read.mockImplementation(async () => read());
    mocks.verify.mockImplementation(async (generation: string) => ({
      identity: identity(generation),
      buildDigest: generation === bridgePath ? bridgeDigest : previousDigest,
    }));
    mocks.inspect.mockImplementation(async ({ descriptor, generationPath, assertCurrent }) => {
      assertCurrent();
      if (generationPath !== servingPath) {
        throw new Error("Bridge is not the serving physical generation");
      }
      return syntheticImmutableServiceObservation(descriptor, {
        pid: 42,
        generationPath: servingPath,
      });
    });
    mocks.current.mockImplementation((observed) => {
      if (observed.generationPath !== servingPath) {
        throw new Error("Bridge process changed");
      }
    });
    mocks.launcher.mockImplementation(async ({ upgrade }) => {
      upgrade?.assertCurrent();
      return path.join(root, "bin", "openclaw-gateway");
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["selected", "changed-receipt", "unrelated", "none"] as const)(
    "enables the verified bridge, retains its predecessor, and handles a %s prepared receipt",
    async (preparedKind) => {
      if (preparedKind !== "none") {
        const sha = preparedKind === "unrelated" ? "c".repeat(40) : bridgeSha;
        const candidatePath = path.join(root, "releases", sha);
        if (preparedKind === "unrelated") {
          fsSync.mkdirSync(candidatePath, { mode: 0o755 });
        }
        original = updateImmutableInstallRecord(
          original,
          {
            ...original,
            prepared: {
              sha,
              path: candidatePath,
              identity: identity(candidatePath),
              buildDigest: preparedKind === "selected" ? bridgeDigest : "3".repeat(64),
              preparedAtMs: 12,
            },
          },
          () => {},
        );
      }
      const pointerIdentity = identity(path.join(root, "current"));
      const result = await adoptImmutableInstall(params);
      expect(result).toMatchObject({
        activationEnabled: true,
        currentSha: bridgeSha,
        currentPath: bridgePath,
      });
      const stored = read();
      expect(stored.descriptor).toMatchObject({
        ...original.descriptor,
        version: 2,
        activationEnabled: true,
        current: {
          sha: bridgeSha,
          path: bridgePath,
          identity: identity(bridgePath),
          pointerIdentity,
          buildDigest: bridgeDigest,
        },
      });
      const { pointerIdentity: _oldPointer, ...previous } = original.descriptor.current;
      expect(stored.activation).toEqual({ previous });
      expect(stored.prepared).toEqual(preparedKind === "selected" ? null : original.prepared);
      expect(identity(path.join(root, "current"))).toBe(pointerIdentity);
      expect(fsSync.readFileSync(path.join(previous.path, "retained"), "utf8")).toBe(
        "previous sealed bytes",
      );
      expect(mocks.launcher).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ upgrade: { version: 1, assertCurrent: expect.any(Function) } }),
      );
    },
  );

  it.each([
    "service",
    "runtime",
    "releases",
    "previous-tree",
    "previous-digest",
    "not-serving",
    "enabled",
    "disabled",
    "pending",
  ] as const)(
    "refuses %s drift without rewriting the launcher or adoption record",
    async (change) => {
      if (change === "service") {
        params.service = { ...params.service, account: "another-account" };
      }
      if (change === "runtime") {
        fsSync.appendFileSync(params.runtime, "changed");
      }
      if (change === "releases") {
        fsSync.renameSync(path.join(root, "releases"), path.join(root, "retained-releases"));
        fsSync.mkdirSync(bridgePath, { recursive: true, mode: 0o755 });
      }
      if (change === "previous-tree") {
        fsSync.renameSync(
          original.descriptor.current.path,
          `${original.descriptor.current.path}.retained`,
        );
        fsSync.mkdirSync(original.descriptor.current.path, { mode: 0o755 });
      }
      if (change === "previous-digest") {
        mocks.verify.mockImplementation(async (generation: string) => ({
          identity: identity(generation),
          buildDigest: generation === bridgePath ? bridgeDigest : "9".repeat(64),
        }));
      }
      if (change === "not-serving") {
        servingPath = original.descriptor.current.path;
      }
      if (change === "enabled") {
        original = updateImmutableInstallRecord(
          original,
          {
            ...original,
            descriptor: { ...original.descriptor, version: 2, activationEnabled: true },
          },
          () => {},
        );
      }
      if (change === "disabled") {
        params.enableActivation = false;
      }
      if (change === "pending") {
        retainPendingActivation();
      }
      await expect(adoptImmutableInstall(params)).rejects.toThrow(
        ["previous-tree", "previous-digest"].includes(change)
          ? "Previous sealed immutable generation changed"
          : change === "not-serving"
            ? "not the serving physical generation"
            : change === "pending"
              ? "Immutable activation recovery is pending"
              : "Existing immutable adoption differs",
      );
      expect(read()).toEqual(original);
      expect(fsSync.readlinkSync(path.join(root, "current"))).toBe(`releases/${bridgeSha}`);
      expect(mocks.launcher).not.toHaveBeenCalled();
    },
  );

  it("adopts retention inspection only after the serving version-2 bridge and launcher settle", async () => {
    await adoptImmutableInstall(params);
    original = read();
    mocks.launcher.mockClear();
    fsSync.writeFileSync(
      path.join(bridgePath, "package.json"),
      JSON.stringify({
        openclaw: { immutableInstallDescriptorVersion: 3 },
      }),
    );
    const result = await adoptImmutableInstall({ ...params, inspectReleaseRetention: true });
    expect(read()).toMatchObject({
      descriptor: {
        version: 3,
        releaseRetention: { version: 1, mode: "inspect", keepVerifiedGenerations: 3, pins: [] },
      },
      releases: [],
    });
    expect(result.releaseRetention).toMatchObject({ mode: "inspect", generations: [] });
    expect(mocks.launcher).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        upgrade: { version: 2, assertCurrent: expect.any(Function) },
      }),
    );
    expect(
      fsSync.readFileSync(path.join(original.activation!.previous!.path, "retained"), "utf8"),
    ).toBe("previous sealed bytes");
    expect(await adoptImmutableInstall({ ...params, inspectReleaseRetention: true })).toEqual(
      result,
    );
  });

  it.each([undefined, 2, 4])(
    "refuses a serving reader marker of %s before adopting retention",
    async (version) => {
      await adoptImmutableInstall(params);
      const before = fsSync.readFileSync(journal());
      mocks.launcher.mockClear();
      fsSync.writeFileSync(
        path.join(bridgePath, "package.json"),
        JSON.stringify({
          openclaw: { immutableInstallDescriptorVersion: version },
        }),
      );
      await expect(
        adoptImmutableInstall({ ...params, inspectReleaseRetention: true }),
      ).rejects.toThrow("cannot read this control format");
      expect(fsSync.readFileSync(journal())).toEqual(before);
      expect(mocks.launcher).not.toHaveBeenCalled();
    },
  );

  it("preserves pending recovery before any retention-format upgrade", async () => {
    await adoptImmutableInstall(params);
    original = read();
    retainPendingActivation();
    const before = fsSync.readFileSync(journal());
    mocks.launcher.mockClear();
    fsSync.writeFileSync(
      path.join(bridgePath, "package.json"),
      JSON.stringify({
        openclaw: { immutableInstallDescriptorVersion: 3 },
      }),
    );
    await expect(
      adoptImmutableInstall({ ...params, inspectReleaseRetention: true }),
    ).rejects.toThrow("Complete version-2 bridge activation and recovery");
    expect(fsSync.readFileSync(journal())).toEqual(before);
    expect(mocks.launcher).not.toHaveBeenCalled();
  });
});
