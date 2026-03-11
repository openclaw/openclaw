import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { HarnessConfig, OperatorRole, SpecPacket, TaskPacket } from "./types.js";

const DEFAULT_BRANCH_PREFIX = "codex";
const PACKET_DIRNAME = ".openclaw-operator";

type PreparedWorkspace = {
  cwd: string;
  branchName: string;
  packetDir: string;
  specPacketPath: string;
  taskPacketPath: string;
  artifactDir: string;
  repoRelativeArtifactDir: string;
};

function normalizeSlugPart(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function defaultWorkspaceRoot(config: HarnessConfig) {
  return (
    config.workspace.ticketWorkspaceRootDir ??
    path.join(config.workspace.repoCwd, ".local/operator-harness/workspaces")
  );
}

export function buildTicketBranchName(config: HarnessConfig, ticketKey: string, title: string) {
  const prefix = normalizeSlugPart(config.workspace.branchPrefix ?? DEFAULT_BRANCH_PREFIX);
  const slug = normalizeSlugPart(title);
  const suffix = slug ? `-${slug}` : "";
  return `${prefix}/${ticketKey.toLowerCase()}${suffix}`;
}

export function buildWorkspacePath(config: HarnessConfig, ticketKey: string, role: OperatorRole) {
  return path.join(defaultWorkspaceRoot(config), ticketKey, role);
}

export function buildRepoRelativeArtifactDir(ticketKey: string, role: OperatorRole) {
  return path.join("operator-harness", "evidence", ticketKey, role);
}

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

async function pathExists(target: string) {
  return fs
    .stat(target)
    .then(() => true)
    .catch(() => false);
}

async function runCommand(command: string, args: string[], cwd: string) {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    new Promise<number | null>((resolve) => child.once("close", resolve)),
  ]);
  if ((exitCode ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed in ${cwd}: ${stderr || stdout}`);
  }
  return stdout.trim();
}

function readStream(stream: NodeJS.ReadableStream) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function runGit(args: string[], cwd: string) {
  return runCommand("git", args, cwd);
}

async function ensureClone(config: HarnessConfig, cwd: string) {
  const gitDir = path.join(cwd, ".git");
  if (await pathExists(gitDir)) {
    return;
  }
  if (await pathExists(cwd)) {
    throw new Error(`Workspace path exists but is not a git repo: ${cwd}`);
  }
  await ensureDir(path.dirname(cwd));
  await runCommand("git", ["clone", config.workspace.repoCwd, cwd], process.cwd());
  if (config.workspace.repoUrl) {
    await runGit(["remote", "set-url", "origin", config.workspace.repoUrl], cwd);
  }
}

function parseNullDelimitedPaths(output: string) {
  return output
    .split("\0")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function shouldSkipMirrorPath(relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return (
    parts.includes(".git") ||
    parts.includes(".local") ||
    parts.includes(".artifacts") ||
    parts.includes("node_modules") ||
    parts.includes("dist") ||
    parts.includes("coverage") ||
    parts.includes("__screenshots__") ||
    parts.includes(".openclaw-operator") ||
    parts.at(-1) === ".DS_Store"
  );
}

async function mirrorWorkingTreeDelta(config: HarnessConfig, cwd: string) {
  const sourceCwd = config.workspace.repoCwd;
  const modified = parseNullDelimitedPaths(
    await runGit(["diff", "--name-only", "-z", "HEAD"], sourceCwd),
  );
  const deleted = parseNullDelimitedPaths(
    await runGit(["diff", "--name-only", "--diff-filter=D", "-z", "HEAD"], sourceCwd),
  );
  const untracked = parseNullDelimitedPaths(
    await runGit(["ls-files", "--others", "--exclude-standard", "-z"], sourceCwd),
  );
  const toCopy = Array.from(new Set([...modified, ...untracked])).filter(
    (relativePath) => !shouldSkipMirrorPath(relativePath),
  );
  const toDelete = deleted.filter((relativePath) => !shouldSkipMirrorPath(relativePath));

  for (const relativePath of toCopy) {
    const sourcePath = path.join(sourceCwd, relativePath);
    const destinationPath = path.join(cwd, relativePath);
    await ensureDir(path.dirname(destinationPath));
    await fs.cp(sourcePath, destinationPath, { force: true, recursive: true });
  }

  for (const relativePath of toDelete) {
    await fs.rm(path.join(cwd, relativePath), { force: true, recursive: true });
  }
}

async function currentBranch(cwd: string) {
  return runGit(["branch", "--show-current"], cwd);
}

async function isDirty(cwd: string) {
  const status = await runGit(["status", "--short"], cwd);
  const meaningfulLines = status
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) => !line.endsWith(".openclaw-operator/") && !line.includes(" .openclaw-operator/"),
    );
  return meaningfulLines.length > 0;
}

async function hasRemoteBranch(cwd: string, branchName: string) {
  try {
    const output = await runGit(["ls-remote", "--heads", "origin", branchName], cwd);
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

async function ensureBuilderBranch(
  config: HarnessConfig,
  cwd: string,
  branchName: string,
  baseBranch: string,
) {
  const dirty = await isDirty(cwd);
  const branch = await currentBranch(cwd);
  if (dirty) {
    if (branch !== branchName) {
      throw new Error(
        `Builder workspace is dirty on unexpected branch (${branch}); expected ${branchName}`,
      );
    }
    // Keep long-lived task clones up to date with operator-side harness changes.
    await mirrorWorkingTreeDelta(config, cwd);
    return;
  }
  await runGit(["fetch", "origin", "--prune"], cwd);
  if (await hasRemoteBranch(cwd, branchName)) {
    await runGit(["checkout", "-B", branchName, `origin/${branchName}`], cwd);
    await mirrorWorkingTreeDelta(config, cwd);
    return;
  }
  try {
    await runGit(["checkout", "-B", branchName, `origin/${baseBranch}`], cwd);
  } catch {
    await runGit(["checkout", "-B", branchName, baseBranch], cwd);
  }
  await mirrorWorkingTreeDelta(config, cwd);
}

async function ensureReviewBranch(cwd: string, branchName: string) {
  const dirty = await isDirty(cwd);
  const branch = await currentBranch(cwd);
  if (dirty) {
    if (branch !== branchName) {
      throw new Error(
        `Review workspace is dirty on unexpected branch (${branch}); expected ${branchName}`,
      );
    }
    return;
  }
  await runGit(["fetch", "origin", "--prune"], cwd);
  if (!(await hasRemoteBranch(cwd, branchName))) {
    throw new Error(`Remote branch is not available yet: ${branchName}`);
  }
  await runGit(["checkout", "-B", branchName, `origin/${branchName}`], cwd);
}

export async function prepareRoleWorkspace(input: {
  config: HarnessConfig;
  ticketKey: string;
  title: string;
  role: OperatorRole;
}) {
  const cwd = buildWorkspacePath(input.config, input.ticketKey, input.role);
  const branchName = buildTicketBranchName(input.config, input.ticketKey, input.title);
  await ensureClone(input.config, cwd);
  if (input.role === "builder") {
    await ensureBuilderBranch(input.config, cwd, branchName, input.config.workspace.baseBranch);
  } else {
    await ensureReviewBranch(cwd, branchName);
  }
  const packetDir = path.join(cwd, PACKET_DIRNAME);
  const specPacketPath = path.join(packetDir, "spec-packet.json");
  const taskPacketPath = path.join(packetDir, `task-${input.role}.json`);
  const repoRelativeArtifactDir = buildRepoRelativeArtifactDir(input.ticketKey, input.role);
  const artifactDir = path.join(cwd, repoRelativeArtifactDir);
  return {
    cwd,
    branchName,
    packetDir,
    specPacketPath,
    taskPacketPath,
    artifactDir,
    repoRelativeArtifactDir,
  } satisfies PreparedWorkspace;
}

export async function writeWorkspacePackets(input: {
  workspace: PreparedWorkspace;
  specPacket: SpecPacket;
  taskPacket: TaskPacket;
}) {
  await ensureDir(input.workspace.packetDir);
  await fs.writeFile(
    input.workspace.specPacketPath,
    `${JSON.stringify(input.specPacket, null, 2)}\n`,
  );
  await fs.writeFile(
    input.workspace.taskPacketPath,
    `${JSON.stringify(input.taskPacket, null, 2)}\n`,
  );
}
