import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { packageActivationRuntimeIdentity } from "./package-update-activation-paths.js";
import type { ImmutableInstallRecord } from "./update-immutable-install-schema.js";
import { inspectImmutableInstall, prepareImmutableUpdate } from "./update-immutable-install.js";

const mocks = vi.hoisted(() => ({
  read: vi.fn<typeof import("./update-immutable-install-record.js").readImmutableInstallRecord>(),
  record:
    vi.fn<
      typeof import("./package-update-activation-immutable.js").recordImmutablePreparedGeneration
    >(),
  command: vi.fn<import("./update-runner-types.js").CommandRunner>(),
  preflight: vi.fn<typeof import("./update-runner-git-preflight.js").runGitCandidatePreflight>(),
  verify: vi.fn<typeof import("./update-immutable-generation.js").verifyImmutableGeneration>(),
  seal: vi.fn<typeof import("./update-immutable-generation.js").sealImmutableGeneration>(),
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
  installImmutableLauncher: vi.fn(),
}));
vi.mock("./update-immutable-service.js", () => ({ verifyImmutableService: async () => {} }));
vi.mock("./update-git-runtime.js", () => ({ collectGitRuntimeErrors: async () => [] }));
vi.mock("./update-runner-git-preflight.js", () => ({ runGitCandidatePreflight: mocks.preflight }));
vi.mock("./update-runner-git-target.js", () => ({
  readGitTargetSchemaVersions: async () => ({ status: "ok", schemaVersions: { state: 1 } }),
}));
vi.mock("./update-runner-command.js", async (original) => ({
  ...(await original<typeof import("./update-runner-command.js")>()),
  buildUpdateCommandRunner: async () => ({
    runCommand: mocks.command,
    defaultCommandEnv: {},
  }),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const currentSha = "a".repeat(40);
const nextSha = "b".repeat(40);
const buildDigest = "c".repeat(64);
let root: string;
let record: ImmutableInstallRecord;
const pointer = () => fs.readlink(path.join(root, "current"));
const identity = (file: string) => {
  const stat = fsSync.lstatSync(file);
  return `${stat.dev}:${stat.ino}`;
};

beforeEach(async () => {
  vi.resetAllMocks();
  const parent = await fs.realpath(dirs.make("openclaw-immutable-adapter-"));
  root = path.join(parent, "installation");
  const currentPath = path.join(root, "releases", currentSha);
  await fs.mkdir(currentPath, { recursive: true, mode: 0o755 });
  await fs.writeFile(path.join(currentPath, "serving"), "previous Gateway bytes");
  await fs.symlink(`releases/${currentSha}`, path.join(root, "current"));
  const runtime = await fs.realpath(process.execPath);
  // The Testbox runner is unprivileged; preserve real inode, mode, and pointer
  // observations while projecting the installation's required root ownership.
  const lstat = fsSync.lstatSync;
  vi.spyOn(fsSync, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    if (stat && String(args[0]).startsWith(`${parent}${path.sep}`)) {
      Object.defineProperty(stat, "uid", { value: typeof stat.uid === "bigint" ? 0n : 0 });
    }
    return stat;
  });
  if (process.geteuid) {
    vi.spyOn(process, "geteuid").mockReturnValue(0);
  }
  record = {
    revision: 0,
    descriptor: {
      version: 1,
      kind: "immutable",
      root,
      rootIdentity: identity(root),
      releasesIdentity: identity(path.join(root, "releases")),
      current: {
        sha: currentSha,
        path: currentPath,
        identity: identity(currentPath),
        pointerIdentity: identity(path.join(root, "current")),
        buildDigest,
      },
      service: {
        unit: "openclaw-fixture.service",
        scope: "system",
        account: "openclaw-fixture",
        stateDir: path.join(parent, "state"),
        configPath: path.join(parent, "state", "openclaw.json"),
        profile: null,
      },
      runtime: { path: runtime, identity: packageActivationRuntimeIdentity(runtime) },
      source: "https://github.com/openclaw/openclaw.git",
    },
    prepared: null,
  };
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
  mocks.command.mockImplementation(async (argv) => {
    if (argv.includes("clone")) {
      const destination = argv.at(-1)!;
      await fs.mkdir(path.join(destination, ".git"), { recursive: true, mode: 0o755 });
    }
    return {
      code: 0,
      stdout: argv.includes("ls-remote") ? `${nextSha}\trefs/heads/main\n` : "",
      stderr: "",
    };
  });
  mocks.preflight.mockImplementation(async (params) => {
    const selected = params.targetRevision!;
    await params.beforeCandidate(selected);
    const built = path.join(params.artifactRoot, "built");
    await fs.mkdir(path.join(built, "dist"), { recursive: true, mode: 0o755 });
    await fs.writeFile(path.join(built, "dist", "index.js"), `candidate ${selected}`);
    await params.validateCandidate(built);
    await params.prepareCandidate?.(built, params.artifactRoot);
    return {
      status: "ok",
      candidateSha: selected,
      selectedDevUpstream: null,
      localDevBranchExists: null,
    };
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

it("refuses a replaced pointer without changing the adopted generation", async () => {
  await fs.mkdir(path.join(root, "releases", nextSha), { mode: 0o755 });
  await fs.unlink(path.join(root, "current"));
  await fs.symlink(`releases/${nextSha}`, path.join(root, "current"));
  await expect(inspectImmutableInstall(root)).rejects.toThrow("changed since adoption");
  expect(await pointer()).toBe(`releases/${nextSha}`);
  expect(mocks.record).not.toHaveBeenCalled();
});

it("recognizes an adopted absolute pointer to the same contained generation", async () => {
  const current = path.join(root, "current");
  await fs.unlink(current);
  await fs.symlink(record.descriptor.current.path, current);
  record.descriptor.current.pointerIdentity = identity(current);

  await expect(inspectImmutableInstall(root)).resolves.toMatchObject({
    root,
    currentSha,
    currentPath: record.descriptor.current.path,
  });
  expect(await pointer()).toBe(record.descriptor.current.path);
  expect(mocks.record).not.toHaveBeenCalled();
});

it.each(["relative", "absolute"])("refuses a %s current pointer outside releases", async (form) => {
  const foreign = path.join(path.dirname(root), "foreign", currentSha);
  await fs.mkdir(foreign, { recursive: true, mode: 0o755 });
  const current = path.join(root, "current");
  const target = form === "absolute" ? foreign : path.relative(root, foreign);
  await fs.unlink(current);
  await fs.symlink(target, current);
  record.descriptor.current.pointerIdentity = identity(current);

  await expect(inspectImmutableInstall(root)).rejects.toThrow(/current must|contained/u);
  expect(await pointer()).toBe(target);
  expect(mocks.record).not.toHaveBeenCalled();
});

it.each([undefined, nextSha])(
  "resolves a dry-run target without filesystem or receipt changes (%s)",
  async (sha) => {
    const before = await fs.readdir(root);
    const result = await prepareImmutableUpdate({ root, sha, dryRun: true });
    expect(result).toMatchObject({ status: "dry-run", targetSha: nextSha });
    expect(result.coverage?.target).toEqual({ sha: nextSha, preparation: "unknown" });
    expect(await fs.readdir(root)).toEqual(before);
    expect(await pointer()).toBe(`releases/${currentSha}`);
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.command.mock.calls.filter(([argv]) => argv.includes("ls-remote"))).toHaveLength(
      sha ? 0 : 1,
    );
  },
);

it("refuses abbreviated targets before fetching or building", async () => {
  expect(await prepareImmutableUpdate({ root, sha: "abcdef", dryRun: true })).toMatchObject({
    status: "error",
    reason: expect.stringContaining("full lowercase 40-hex"),
  });
  expect(mocks.command).not.toHaveBeenCalled();
  expect(await pointer()).toBe(`releases/${currentSha}`);
});

it.skipIf(process.platform !== "linux")(
  "refuses a different Node executable before touching a candidate",
  async () => {
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
    expect(await pointer()).toBe(`releases/${currentSha}`);
    expect(await fs.readdir(path.join(root, "releases"))).toEqual([currentSha]);
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.command).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform !== "linux")(
  "does no candidate work when the exact target is already current",
  async () => {
    expect(await prepareImmutableUpdate({ root, sha: currentSha })).toMatchObject({
      status: "already-current",
      targetSha: currentSha,
    });
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual(["current", "releases"]);
  },
);

it.skipIf(process.platform !== "linux").each([undefined, nextSha])(
  "freezes the exact candidate, seals and records it without selecting it (%s)",
  async (sha) => {
    const result = await prepareImmutableUpdate({ root, sha });
    const destination = path.join(root, "releases", nextSha);
    expect(result).toMatchObject({
      status: "prepared",
      targetSha: nextSha,
      installation: { currentSha, prepared: { sha: nextSha, path: destination, buildDigest } },
    });
    expect(await pointer()).toBe(`releases/${currentSha}`);
    expect(await fs.readFile(path.join(destination, "dist", "index.js"), "utf8")).toBe(
      `candidate ${nextSha}`,
    );
    expect(await fs.readFile(path.join(record.descriptor.current.path, "serving"), "utf8")).toBe(
      "previous Gateway bytes",
    );
    expect(mocks.command.mock.calls.filter(([argv]) => argv.includes("ls-remote"))).toHaveLength(
      sha ? 0 : 1,
    );
    expect(mocks.seal).toHaveBeenCalledOnce();
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(await fs.readdir(root)).toEqual(["current", "releases"]);
  },
);

it.skipIf(process.platform !== "linux").each(["build", "fallback"] as const)(
  "keeps the serving generation and omits a receipt on %s failure",
  async (failure) => {
    mocks.preflight.mockImplementationOnce(async (params) => {
      if (failure === "fallback") {
        await params.beforeCandidate("d".repeat(40));
      }
      return { status: "error", reason: "build-failed" };
    });
    const result = await prepareImmutableUpdate({ root, sha: nextSha });
    expect(result).toMatchObject({
      status: "error",
      targetSha: nextSha,
      reason: failure === "build" ? "build-failed" : expect.stringContaining("cannot fall back"),
    });
    expect(await pointer()).toBe(`releases/${currentSha}`);
    expect(await fs.readdir(path.join(root, "releases"))).toEqual([currentSha]);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(mocks.seal).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform !== "linux")(
  "preserves an existing generation without a matching preparation receipt",
  async () => {
    const destination = path.join(root, "releases", nextSha);
    await fs.mkdir(destination, { mode: 0o755 });
    await fs.writeFile(path.join(destination, "incomplete"), "retain for inspection");

    const result = await prepareImmutableUpdate({ root, sha: nextSha });

    expect(result).toMatchObject({
      status: "error",
      reason: expect.stringContaining("without a matching preparation receipt"),
    });
    expect(await fs.readFile(path.join(destination, "incomplete"), "utf8")).toBe(
      "retain for inspection",
    );
    expect(await pointer()).toBe(`releases/${currentSha}`);
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  },
);
