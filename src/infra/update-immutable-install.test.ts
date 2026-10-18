import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { CommandProcessCleanupError } from "../process/exec-result.js";
import type * as Activation from "./package-update-activation-immutable.js";
import { packageActivationRuntimeIdentity } from "./package-update-activation-paths.js";
import type { ImmutableInstallRecord } from "./update-immutable-install-schema.js";
import { inspectImmutableInstall, prepareImmutableUpdate } from "./update-immutable-install.js";
import {
  immutableLayout,
  identity,
  expectUncalled,
} from "./update-immutable-layout.test-support.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn<typeof import("./update-immutable-install-record.js").readImmutableInstallRecord>(),
  record: vi.fn<typeof Activation.recordImmutablePreparedGeneration>(),
  command: vi.fn<import("./update-runner-types.js").CommandRunner>(),
  build: vi.fn<typeof import("./update-immutable-build.js").runImmutableBuild>(),
  verify: vi.fn<typeof import("./update-immutable-generation.js").verifyImmutableGeneration>(),
  seal: vi.fn<typeof import("./update-immutable-generation.js").sealImmutableGeneration>(),
  copy: vi.fn<typeof import("./update-immutable-generation.js").copyImmutableGeneration>(),
}));
vi.mock("./update-immutable-owner.js", () => ({
  withImmutableUpdateOwner: async (_root: string, run: (assertCurrent: () => void) => unknown) =>
    run(() => {}),
}));
vi.mock("./update-immutable-install-record.js", () => ({ readImmutableInstallRecord: mocks.read }));
vi.mock("./package-update-activation-immutable.js", () => ({
  recordImmutablePreparedGeneration: mocks.record,
}));
vi.mock("./update-immutable-generation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-immutable-generation.js")>()),
  verifyImmutableGeneration: mocks.verify,
  sealImmutableGeneration: mocks.seal,
  copyImmutableGeneration: mocks.copy,
  installImmutableLauncher: vi.fn(),
}));
vi.mock("./update-immutable-service.js", () => ({ verifyImmutableService: async () => {} }));
vi.mock("./update-git-runtime.js", () => ({ collectGitRuntimeErrors: async () => [] }));
// mock-isolation: The synthetic installation cannot launch native systemd build services.
vi.mock("./update-immutable-build.js", () => ({ runImmutableBuild: mocks.build }));
vi.mock("./update-runner-git-schema.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-runner-git-schema.js")>()),
  readGitTargetSchemaVersions: async () => ({ status: "ok", schemaVersions: { state: 1 } }),
}));
vi.mock("./update-runner-command.js", async (original) => ({
  ...(await original<typeof import("./update-runner-command.js")>()),
  buildUpdateCommandRunner: async () => ({ runCommand: mocks.command, defaultCommandEnv: {} }),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const currentSha = "a".repeat(40);
const nextSha = "b".repeat(40);
const buildDigest = "c".repeat(64);
let root: string;
let record: ImmutableInstallRecord;
const pointer = () => fs.readlink(path.join(root, "current"));
const readRelease = (sha: string, file: string) =>
  fs.readFile(path.join(root, "releases", sha, file), "utf8");
async function expectUnchanged(...unused: Parameters<typeof expectUncalled>) {
  expect(await pointer()).toBe(`releases/${currentSha}`);
  expectUncalled(...unused);
}

beforeEach(async () => {
  vi.resetAllMocks();
  const parent = await fs.realpath(dirs.make("openclaw-immutable-adapter-"));
  const descriptor = immutableLayout(parent, {
    sha: currentSha,
    buildDigest,
    unit: "openclaw-fixture.service",
    account: "openclaw-fixture",
  });
  root = descriptor.root;
  await fs.writeFile(path.join(descriptor.current.path, "serving"), "previous Gateway bytes");
  record = { revision: 0, descriptor, prepared: null };
  mocks.read.mockImplementation(async () => record);
  mocks.record.mockImplementation((previous, prepared, assertCurrent) => {
    assertCurrent();
    record = { ...previous, revision: previous.revision + 1, prepared };
    return record;
  });
  mocks.verify.mockImplementation(async (generation) => ({
    buildDigest,
    identity: identity(generation),
  }));
  mocks.seal.mockResolvedValue(undefined);
  mocks.copy.mockImplementation(async (source, destination) => {
    expect((await fs.stat(path.dirname(destination))).mode & 0o077).toBe(0);
    await fs.cp(source, destination, { recursive: true, verbatimSymlinks: true });
  });
  mocks.command.mockImplementation(async (argv) => ({
    code: 0,
    stdout: argv.includes("ls-remote") ? `${nextSha}\trefs/heads/main\n` : "",
    stderr: "",
  }));
  mocks.build.mockImplementation(async ({ stage, sha }) => {
    const built = path.join(stage, "generation");
    await fs.mkdir(path.join(built, "dist"), { recursive: true, mode: 0o755 });
    await fs.writeFile(path.join(built, "dist/index.js"), `candidate ${sha}`);
  });
});
afterEach(() => vi.restoreAllMocks());

it("recognizes only an explicitly adopted release layout", async () => {
  mocks.read.mockResolvedValueOnce(null);
  await expect(inspectImmutableInstall(record.descriptor.current.path)).rejects.toThrow(
    "not adopted",
  );
  expect(await inspectImmutableInstall(path.join(root, "current"))).toEqual({
    root,
    currentSha,
    currentPath: record.descriptor.current.path,
  });
  expect(await inspectImmutableInstall(path.dirname(root))).toBeNull();
  expect(await pointer()).toBe(`releases/${currentSha}`);
});

it("leaves an ordinary checkout with an unrelated current file to its existing updater", async () => {
  const checkout = dirs.make("openclaw-ordinary-checkout-");
  await fs.mkdir(path.join(checkout, ".git"));
  await fs.writeFile(path.join(checkout, "current"), "operator notes");

  await expect(inspectImmutableInstall(checkout)).resolves.toBeNull();
  expect(mocks.read).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(checkout, "current"), "utf8")).toBe("operator notes");
});

it.each([
  ["replaced", "changed since adoption"],
  ["outside releases", /current must|contained/u],
] as const)("refuses a pointer %s without adopting it", async (kind, error) => {
  const destination =
    kind === "replaced"
      ? path.join(root, "releases", nextSha)
      : path.join(path.dirname(root), "foreign", currentSha);
  await fs.mkdir(destination, { recursive: true, mode: 0o755 });
  const current = path.join(root, "current");
  const target = path.relative(root, destination);
  await fs.unlink(current);
  await fs.symlink(target, current);
  if (kind === "outside releases") {
    record.descriptor.current.pointerIdentity = identity(current);
  }
  await expect(inspectImmutableInstall(root)).rejects.toThrow(error);
  expect(await pointer()).toBe(target);
  expectUncalled(mocks.record);
});

it("resolves a dry-run target without filesystem or receipt changes", async () => {
  const before = new Set(await fs.readdir(root));
  const result = await prepareImmutableUpdate({ root, dryRun: true });
  expect(result).toMatchObject({ status: "dry-run", targetSha: nextSha });
  expect(result.coverage?.target).toEqual({ sha: nextSha, preparation: "unknown" });
  expect(new Set(await fs.readdir(root))).toEqual(before);
  await expectUnchanged(mocks.build, mocks.record);
  expect(mocks.command.mock.calls.filter(([argv]) => argv.includes("ls-remote"))).toHaveLength(1);
});

it("refuses abbreviated targets before fetching or building", async () => {
  expect(await prepareImmutableUpdate({ root, sha: "abcdef", dryRun: true })).toMatchObject({
    status: "error",
    reason: expect.stringContaining("full lowercase 40-hex"),
  });
  await expectUnchanged(mocks.command);
});

describe.skipIf(process.platform !== "linux")("immutable preparation", () => {
  it("refuses a different Node executable before touching a candidate", async () => {
    const runtime = path.join(path.dirname(root), "node");
    await fs.writeFile(runtime, "synthetic external runtime", { mode: 0o755 });
    record.descriptor.runtime = {
      path: runtime,
      identity: packageActivationRuntimeIdentity(runtime),
    };

    const result = await prepareImmutableUpdate({ root, sha: nextSha });

    expect(result).toMatchObject({
      status: "error",
      reason: expect.stringContaining("Run preparation with the adopted Node executable"),
    });
    expect(await fs.readdir(path.join(root, "releases"))).toEqual([currentSha]);
    await expectUnchanged(mocks.build, mocks.record, mocks.command);
  });

  it("does no candidate work when the exact target is already current", async () => {
    expect(await prepareImmutableUpdate({ root, sha: currentSha })).toMatchObject({
      status: "already-current",
      targetSha: currentSha,
    });
    expectUncalled(mocks.command, mocks.build, mocks.record);
    expect(new Set(await fs.readdir(root))).toEqual(new Set(["current", "releases"]));
  });

  it("freezes the exact candidate, seals and records it without selecting it", async () => {
    const result = await prepareImmutableUpdate({ root });
    const destination = path.join(root, "releases", nextSha);
    expect(result).toMatchObject({
      status: "prepared",
      targetSha: nextSha,
      installation: { currentSha, prepared: { sha: nextSha, path: destination, buildDigest } },
    });
    expect(await pointer()).toBe(`releases/${currentSha}`);
    expect(await readRelease(nextSha, "dist/index.js")).toBe(`candidate ${nextSha}`);
    expect(await readRelease(currentSha, "serving")).toBe("previous Gateway bytes");
    expect(mocks.command.mock.calls.filter(([argv]) => argv.includes("ls-remote"))).toHaveLength(1);
    expect(mocks.seal).toHaveBeenCalledOnce();
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(new Set(await fs.readdir(root))).toEqual(new Set(["current", "releases"]));
  });

  it("retains build custody without sealing or publishing when descendants did not settle", async () => {
    mocks.build.mockRejectedValueOnce(new CommandProcessCleanupError());
    const result = await prepareImmutableUpdate({ root, sha: nextSha });
    expect(result.status).toBe("error");
    expect(result.warnings).toEqual([expect.stringContaining("processes did not settle")]);
    expect((await fs.readdir(root)).some((name) => name.startsWith(".openclaw-immutable-"))).toBe(
      true,
    );
    await expectUnchanged(mocks.seal, mocks.record);
  });

  it("preserves an existing generation without a matching preparation receipt", async () => {
    const destination = path.join(root, "releases", nextSha);
    await fs.mkdir(destination, { mode: 0o755 });
    await fs.writeFile(path.join(destination, "incomplete"), "retain for inspection");

    const result = await prepareImmutableUpdate({ root, sha: nextSha });

    expect(result).toMatchObject({
      status: "error",
      reason: expect.stringContaining("without a matching preparation receipt"),
    });
    expect(await readRelease(nextSha, "incomplete")).toBe("retain for inspection");
    await expectUnchanged(mocks.build, mocks.record);
  });
});
