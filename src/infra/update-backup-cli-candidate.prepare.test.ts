import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import type { runGitCandidatePreflight } from "./update-runner-git-preflight.js";

const git = promisify(execFile);
const durability = vi.hoisted(() => ({ failParent: false }));
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  inspect: vi.fn(),
  preflight: vi.fn(),
  errors: vi.fn(async () => [] as string[]),
  identity: vi.fn(),
}));
vi.mock("./update-runner-git-target.js", () => ({
  fetchGitUpdateTarget: mocks.fetch,
  withGitTargetInspectionRoot: mocks.inspect,
}));
vi.mock("./update-runner-git-preflight.js", () => ({
  runGitCandidatePreflight: mocks.preflight,
}));
vi.mock("./update-git-runtime.js", () => ({
  collectGitRuntimeErrors: mocks.errors,
  readGitRuntimeArtifactIdentity: mocks.identity,
}));
vi.mock("./directory-durability.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./directory-durability.js")>();
  return {
    ...original,
    syncDirectory: async (directory: string) =>
      durability.failParent && directory.endsWith("/backup-cli-candidates")
        ? { status: "unsupported" as const, code: "ENOTSUP" }
        : original.syncDirectory(directory),
  };
});

const OPERATION = "db30234a-7833-45f8-8684-13d1fbbda8ef";
const DIGEST = "2".repeat(64);
let fixtureRoot = "";

afterEach(async () => {
  if (fixtureRoot) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = "";
  }
  vi.clearAllMocks();
  durability.failParent = false;
});

async function setup(redirectArtifacts = false) {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "backup-cli-prepare-"));
  const control = path.join(fixtureRoot, "control");
  const inspection = path.join(fixtureRoot, "inspection.git");
  const built = path.join(fixtureRoot, "built");
  await fs.mkdir(control);
  await git("git", ["init", "-q", control]);
  await git("git", ["-C", control, "config", "user.name", "Fixture"]);
  await git("git", ["-C", control, "config", "user.email", "fixture@example.invalid"]);
  await fs.writeFile(path.join(control, "package.json"), "{}\n");
  await git("git", ["-C", control, "add", "package.json"]);
  await git("git", ["-C", control, "commit", "-qm", "fixture"]);
  const sha = (await git("git", ["-C", control, "rev-parse", "HEAD"])).stdout.trim();
  await git("git", ["clone", "--bare", "-q", control, inspection]);
  let artifactRoot = path.join(control, ".artifacts");
  if (redirectArtifacts) {
    artifactRoot = path.join(fixtureRoot, "redirected-artifacts");
    await fs.mkdir(artifactRoot);
    await fs.symlink(artifactRoot, path.join(control, ".artifacts"));
  }
  await fs.mkdir(path.join(built, "dist"), { recursive: true });
  await fs.writeFile(path.join(built, "dist", "entry.js"), "export {};\n");
  mocks.identity.mockResolvedValue({ commit: sha, distDigest: DIGEST });
  mocks.fetch.mockResolvedValue({ ok: true, refreshedRemotes: [] });
  mocks.inspect.mockImplementation(
    async (_params: unknown, inspect: (root: string, command: unknown) => Promise<unknown>) =>
      inspect(inspection, (await import("../process/exec.js")).runCommandWithTimeout),
  );
  return { control, built, sha, artifactRoot };
}

function prepareMock(params: {
  sha: string;
  built: string;
  cleanup?: boolean;
  afterCopy?: () => void;
}) {
  mocks.preflight.mockImplementation(
    async (owner: Parameters<typeof runGitCandidatePreflight>[0]) => {
      owner.retainCleanup?.(async () => params.cleanup !== false);
      await owner.prepareCandidate?.(params.built, path.dirname(params.built));
      params.afterCopy?.();
      return { status: "ok", candidateSha: params.sha };
    },
  );
}

it("materializes an exact independent candidate and removes its private staging", async () => {
  const { control, built, sha, artifactRoot } = await setup(true);
  prepareMock({ sha, built });
  const { prepareBackupCliCandidate, verifyBackupCliCandidate } =
    await import("./update-backup-cli-candidate.js");
  const receipt = await prepareBackupCliCandidate({
    controlRoot: control,
    sha,
    operationId: OPERATION,
  });
  expect(receipt.id).toBe(OPERATION);
  expect(receipt.root).toBe(path.join(artifactRoot, "backup-cli-candidates", OPERATION));
  await expect(
    fs.access(path.join(receipt.root, ".git", "objects", "info", "alternates")),
  ).rejects.toThrow();
  await expect(
    fs.access(path.join(artifactRoot, "backup-cli-candidates", `.prepare-${OPERATION}`)),
  ).rejects.toThrow();
  await expect(
    verifyBackupCliCandidate({ controlRoot: control, id: OPERATION, operationId: OPERATION }),
  ).resolves.toEqual(receipt);
});

it("does not publish after prepublication cancellation and retains uncertain cleanup", async () => {
  const { control, built, sha } = await setup();
  const controller = new AbortController();
  prepareMock({ sha, built, afterCopy: () => controller.abort() });
  const { prepareBackupCliCandidate } = await import("./update-backup-cli-candidate.js");
  await expect(
    prepareBackupCliCandidate({
      controlRoot: control,
      sha,
      operationId: OPERATION,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  const parent = path.join(control, ".artifacts", "backup-cli-candidates");
  await expect(fs.access(path.join(parent, OPERATION))).rejects.toThrow();
  await expect(fs.access(path.join(parent, `.prepare-${OPERATION}`))).rejects.toThrow();

  prepareMock({ sha, built, cleanup: false });
  await expect(
    prepareBackupCliCandidate({
      controlRoot: control,
      sha,
      operationId: OPERATION,
    }),
  ).rejects.toThrow(/cleanup/u);
  await expect(fs.access(path.join(parent, `.prepare-${OPERATION}`))).resolves.toBeUndefined();
});

it("returns a published receipt after a late signal", async () => {
  const { control, built, sha } = await setup();
  prepareMock({ sha, built });
  const { prepareBackupCliCandidate } = await import("./update-backup-cli-candidate.js");
  const controller = new AbortController();
  const receipt = await prepareBackupCliCandidate({
    controlRoot: control,
    sha,
    operationId: OPERATION,
    signal: controller.signal,
    onPublished: () => controller.abort(),
  });
  expect(receipt.root).toContain(OPERATION);
  await expect(fs.access(receipt.root)).resolves.toBeUndefined();
});

it("preserves a verifiable candidate when parent fsync fails after rename", async () => {
  const { control, built, sha } = await setup();
  prepareMock({ sha, built });
  const { prepareBackupCliCandidate, verifyBackupCliCandidate } =
    await import("./update-backup-cli-candidate.js");
  durability.failParent = true;
  await expect(
    prepareBackupCliCandidate({
      controlRoot: control,
      sha,
      operationId: OPERATION,
    }),
  ).rejects.toThrow(/directory synchronization/u);
  durability.failParent = false;
  const root = path.join(control, ".artifacts", "backup-cli-candidates", OPERATION);
  await expect(
    verifyBackupCliCandidate({ controlRoot: control, id: OPERATION, operationId: OPERATION }),
  ).resolves.toMatchObject({ root, sha });
});
