import fsSync from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  createImmutableInstallRecord,
  immutableInstallReadOperations,
  updateImmutableInstallRecord,
} from "./package-update-activation-immutable.js";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-paths.js";
import {
  syntheticImmutableServiceObservation,
  syntheticActivationCustody,
  syntheticImmutableProtection,
} from "./update-immutable-activation.test-support.js";
import type {
  ImmutableActivationOperation,
  ImmutableInstallRecord,
} from "./update-immutable-install-schema.js";
import { adoptImmutableInstall } from "./update-immutable-install.js";
import { immutableLayout, identity } from "./update-immutable-layout.test-support.js";

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
vi.mock("./update-immutable-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-immutable-service.js")>()),
  readImmutableService: async () => ({}),
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
const journal = () => resolvePackageActivationJournalPath(resolvePackageActivationAnchor(root));
const read = () =>
  immutableInstallReadOperations["immutableInstall.read"](
    { root },
    { path: journal(), env: process.env },
  );

function updateRecord(
  changes: Partial<Pick<ImmutableInstallRecord, "descriptor" | "prepared" | "activation">>,
) {
  original = updateImmutableInstallRecord(original, { ...original, ...changes }, () => {});
}

function writeReaderVersion(version?: number) {
  fsSync.writeFileSync(
    path.join(bridgePath, "package.json"),
    JSON.stringify({ openclaw: { immutableInstallDescriptorVersion: version } }),
  );
}

function preparedGeneration(sha: string, buildDigest: string) {
  const generationPath = path.join(root, "releases", sha);
  return {
    sha,
    path: generationPath,
    identity: identity(generationPath),
    buildDigest,
    preparedAtMs: 12,
  };
}

async function prepareRetentionUpgrade() {
  await adoptImmutableInstall(params);
  original = read();
  mocks.launcher.mockClear();
}

async function expectRetentionRejected(reason: string) {
  const before = fsSync.readFileSync(journal());
  await expect(adoptImmutableInstall({ ...params, inspectReleaseRetention: true })).rejects.toThrow(
    reason,
  );
  expect(fsSync.readFileSync(journal())).toEqual(before);
  expect(mocks.launcher).not.toHaveBeenCalled();
}

function retainPendingActivation() {
  const descriptor = {
    ...original.descriptor,
    version: 2 as const,
    activationEnabled: true as const,
  };
  const { authority, recovery } = syntheticActivationCustody(descriptor, ["1:3", "1:4"]);
  const operation: ImmutableActivationOperation = {
    version: 1,
    operationId: "b2a30aad-b116-4b9a-8984-679671ecfc66",
    authority,
    phase: "prepared",
    previous: descriptor.current,
    candidate: preparedGeneration(bridgeSha, bridgeDigest),
    serviceDigest: "3".repeat(64),
    startedAtMs: 12,
    protection: syntheticImmutableProtection(descriptor, {
      key: "synthetic",
      hash: "4".repeat(64),
      policyFingerprint: "5".repeat(64),
    }),
    recovery,
  };
  updateRecord({ descriptor, activation: { operation } });
}

describe.skipIf(process.platform !== "linux")("explicit immutable adoption after a bridge", () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    const parent = fsSync.realpathSync(dirs.make("immutable-bridge-adoption-"));
    const descriptor = immutableLayout(parent, {
      sha: previousSha,
      buildDigest: previousDigest,
      unit: "immutable-fixture.service",
      account: "synthetic",
      externalRuntime: true,
    });
    root = descriptor.root;
    const runtime = descriptor.runtime.path;
    bridgePath = path.join(root, "releases", bridgeSha);
    fsSync.mkdirSync(bridgePath, { mode: 0o755 });
    fsSync.writeFileSync(path.join(descriptor.current.path, "retained"), "previous sealed bytes");
    original = createImmutableInstallRecord(descriptor, () => {});
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
    mocks.inspect.mockImplementation(
      async ({ descriptor: selected, generationPath, assertCurrent }) => {
        assertCurrent();
        if (generationPath !== servingPath) {
          throw new Error("Bridge is not the serving physical generation");
        }
        return syntheticImmutableServiceObservation(selected, {
          pid: 42,
          generationPath: servingPath,
        });
      },
    );
    mocks.current.mockImplementation((observed) => {
      if (observed.generationPath !== servingPath) {
        throw new Error("Bridge process changed");
      }
    });
    mocks.launcher.mockImplementation(async ({ upgrade }) => {
      upgrade?.assertCurrent();
      return path.join(root, "bin/openclaw-gateway");
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
        updateRecord({
          prepared: preparedGeneration(
            sha,
            preparedKind === "selected" ? bridgeDigest : "3".repeat(64),
          ),
        });
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
        updateRecord({
          descriptor: { ...original.descriptor, version: 2, activationEnabled: true },
        });
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
    await prepareRetentionUpgrade();
    writeReaderVersion(3);
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
      expect.objectContaining({ upgrade: { version: 2, assertCurrent: expect.any(Function) } }),
    );
    expect(
      fsSync.readFileSync(path.join(original.activation!.previous!.path, "retained"), "utf8"),
    ).toBe("previous sealed bytes");
    expect(await adoptImmutableInstall({ ...params, inspectReleaseRetention: true })).toEqual(
      result,
    );
  });

  it.each([undefined, 2, 4, 3])(
    "refuses retention with reader %s or pending recovery",
    async (version) => {
      await prepareRetentionUpgrade();
      if (version === 3) {
        retainPendingActivation();
      }
      writeReaderVersion(version);
      await expectRetentionRejected(
        version === 3
          ? "Complete version-2 bridge activation and recovery"
          : "cannot read this control format",
      );
    },
  );
});
