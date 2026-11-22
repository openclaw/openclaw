import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FileLockHandle } from "@openclaw/fs-safe/file-lock";
import { afterEach, expect, it, vi } from "vitest";
import type { CommandRunner } from "./update-runner-types.js";

const runtime = vi.hoisted(() => ({
  errors: vi.fn(async () => [] as string[]),
  identity: vi.fn<() => Promise<{ commit: string; distDigest: string }>>(),
}));
vi.mock("./update-git-runtime.js", () => ({
  collectGitRuntimeErrors: runtime.errors,
  readGitRuntimeArtifactIdentity: runtime.identity,
}));

const ID = "b6200cb5-d21c-4f45-a2f4-fae117a554f9";
const OPERATION = "db30234a-7833-45f8-8684-13d1fbbda8ef";
const SHA = "1".repeat(40);
const DIGEST = "2".repeat(64);
let control = "";

afterEach(async () => {
  if (control) {
    await fs.rm(control, { recursive: true, force: true });
    control = "";
  }
  vi.clearAllMocks();
});

async function fixture() {
  control = await fs.mkdtemp(path.join(os.tmpdir(), "backup-cli-candidate-"));
  await fs.mkdir(path.join(control, ".git"));
  const root = path.join(control, ".artifacts", "backup-cli-candidates", ID);
  await fs.mkdir(path.join(root, ".git"), { recursive: true });
  await fs.writeFile(path.join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
  const stat = await fs.lstat(root, { bigint: true });
  const receipt = {
    kind: "prepared-backup-cli" as const,
    version: 1 as const,
    id: ID,
    operationId: OPERATION,
    sha: SHA,
    root,
    rootIdentity: { dev: String(stat.dev), ino: String(stat.ino) },
    buildDigest: DIGEST,
    preparedAtMs: 1,
  };
  await fs.writeFile(path.join(root, ".git", "openclaw-backup-cli.json"), JSON.stringify(receipt));
  runtime.identity.mockResolvedValue({ commit: SHA, distDigest: DIGEST });
  const runCommand: CommandRunner = vi.fn(async (argv) => ({
    code: 0,
    stdout: argv.includes("rev-parse") ? `${SHA}\n` : "",
    stderr: "",
  }));
  return { root, receipt, runCommand };
}

it("binds verification to operation, physical root and built digest", async () => {
  const { receipt, runCommand } = await fixture();
  const { verifyBackupCliCandidate } = await import("./update-backup-cli-candidate.js");
  await expect(
    verifyBackupCliCandidate({
      controlRoot: control,
      id: ID,
      operationId: OPERATION,
      runCommand,
    }),
  ).resolves.toEqual(receipt);
  expect(runCommand).toHaveBeenCalledTimes(2);
  await expect(
    verifyBackupCliCandidate({
      controlRoot: control,
      id: ID,
      operationId: "e0000000-0000-4000-8000-000000000000",
      runCommand,
    }),
  ).rejects.toThrow(/selected owner/u);
  runtime.identity.mockResolvedValue({ commit: SHA, distDigest: "3".repeat(64) });
  await expect(
    verifyBackupCliCandidate({
      controlRoot: control,
      id: ID,
      operationId: OPERATION,
      runCommand,
    }),
  ).rejects.toThrow(/build changed/u);
});

it("preserves the receipt when a candidate holder refuses retirement", async () => {
  const { root, runCommand } = await fixture();
  const { retireBackupCliCandidate } = await import("./update-backup-cli-candidate.js");
  await expect(
    retireBackupCliCandidate({
      controlRoot: control,
      id: ID,
      operationId: OPERATION,
      runCommand,
      acquireOwnership: async () => {
        throw new Error("candidate holder active");
      },
    }),
  ).rejects.toThrow("candidate holder active");
  await expect(
    fs.access(path.join(root, ".git", "openclaw-backup-cli.json")),
  ).resolves.toBeUndefined();
});

it("retires the selected candidate only after its artifact holder releases", async () => {
  const { root, runCommand } = await fixture();
  const release = vi.fn(async () => {});
  const { retireBackupCliCandidate } = await import("./update-backup-cli-candidate.js");
  await retireBackupCliCandidate({
    controlRoot: control,
    id: ID,
    operationId: OPERATION,
    runCommand,
    acquireOwnership: async () => ({ release }) as unknown as FileLockHandle,
  });
  expect(release).toHaveBeenCalledOnce();
  await expect(fs.access(root)).rejects.toThrow();
});
