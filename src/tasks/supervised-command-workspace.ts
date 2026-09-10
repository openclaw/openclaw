import { createHash } from "node:crypto";
import { closeSync, fstatSync, read } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { openRootFile } from "../infra/boundary-file-read.js";
import {
  step,
  mount,
  isWithin,
  assertDirectory,
  copyManifest,
  copySelectedDirectories,
  type AssertCurrent,
} from "./supervised-private-workspace.js";
import type {
  SupervisedWorkflowContract,
  SupervisedWorkflowProfile,
} from "./supervised-workflow.types.js";
import {
  captureSupervisedWorkspace,
  resolveSupervisedWorkspaceFile,
  type SupervisedWorkspaceSnapshot,
} from "./supervised-workspace.js";

const MIB = 1024 * 1024;
/** This separate tmpfs is charged to the SAME operation memory cgroup. The
 * memory budget must include these 384 MiB, the working cap, and process overhead. */
export const SUPERVISED_COMMAND_INPUT_BYTES = 384 * MIB;
const INPUT_INODES = 128;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
type Command = Extract<SupervisedWorkflowProfile, { kind: "command" }>;
type BindMount = { source: string; target: string; writable: boolean };

async function copyFrozenInput(params: {
  source: string;
  destination: string;
  sha256: string;
  maxBytes: number;
  executable: boolean;
  assertCurrent: AssertCurrent;
}) {
  const { source, destination, sha256, maxBytes, executable, assertCurrent } = params;
  assertCurrent();
  const opened = await openRootFile({
    rootPath: path.dirname(source),
    absolutePath: source,
    maxBytes,
    rejectHardlinks: true,
    boundaryLabel: "accepted command input",
  });
  if (!opened.ok) {
    throw new Error("Accepted command input fails its regular-file boundary");
  }
  // The handle needs cleanup even if authority disappeared during its open.
  try {
    assertCurrent();
    const before = fstatSync(opened.fd);
    const destinationFile = await fs.open(destination, "wx", executable ? 0o500 : 0o400);
    try {
      assertCurrent();
      const digest = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let size = 0;
      while (true) {
        const count = await step(
          assertCurrent,
          () =>
            new Promise<number>((resolve, reject) => {
              read(
                opened.fd,
                buffer,
                0,
                Math.min(buffer.length, maxBytes - size + 1),
                size,
                (error, bytesRead) => (error ? reject(error) : resolve(bytesRead)),
              );
            }),
        );
        if (!count) {
          break;
        }
        size += count;
        if (size > maxBytes) {
          throw new Error("Accepted command input exceeds its byte budget");
        }
        digest.update(buffer.subarray(0, count));
        let written = 0;
        while (written < count) {
          const result = await step(assertCurrent, () =>
            destinationFile.write(buffer, written, count - written),
          );
          if (result.bytesWritten <= 0) {
            throw new Error("Frozen command input write made no progress");
          }
          written += result.bytesWritten;
        }
      }
      const after = fstatSync(opened.fd);
      const selected = await step(assertCurrent, () => fs.lstat(source));
      if (
        selected.isSymbolicLink() ||
        selected.dev !== before.dev ||
        selected.ino !== before.ino ||
        before.nlink !== 1 ||
        after.nlink !== 1 ||
        before.size !== size ||
        after.size !== size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        digest.digest("hex") !== sha256
      ) {
        throw new Error("Accepted command input changed or does not match its pinned digest");
      }
    } finally {
      await destinationFile.close();
    }
    assertCurrent();
  } finally {
    closeSync(opened.fd);
  }
}

export type PreparedSupervisedCommandWorkspace = {
  reservedRoot: string;
  allocationId: string;
  reservationIdentity: { dev: number; ino: number };
  mountNamespace: string;
  workspace: string;
  inputRoot: string;
  before: SupervisedWorkspaceSnapshot;
  sourcePaths: string[];
  bindMounts: BindMount[];
  cwd: string;
  commandInputHash: string;
  inputBytes: number;
  workingBytes: number;
  workingInodes: number;
};

/** Trusted namespace-custodian only. The host must first reserve this allocation
 * for the exact live execution, create its empty 0700 directory, and put this
 * custodian in the verified bounded scope. No untrusted payload may yet exist.
 * Failure requires closing the entire custodian namespace; never retry a mount
 * or fall back to a host bind. This helper does not own scope teardown. */
export async function prepareSupervisedCommandWorkspace(params: {
  contract: SupervisedWorkflowContract;
  profile: Command;
  allocationId: string;
  reservedRoot: string;
  parentMountNamespace: string;
  workingBytes: number;
  workingInodes: number;
  assertCurrent: AssertCurrent;
}): Promise<PreparedSupervisedCommandWorkspace> {
  const { contract, profile, allocationId, reservedRoot, assertCurrent } = params;
  if (
    process.platform !== "linux" ||
    !UUID.test(allocationId) ||
    path.basename(reservedRoot) !== allocationId ||
    !path.isAbsolute(reservedRoot) ||
    path.resolve(reservedRoot) !== reservedRoot ||
    !Number.isSafeInteger(params.workingBytes) ||
    params.workingBytes < 4096 ||
    !Number.isSafeInteger(params.workingInodes) ||
    params.workingInodes < 16 ||
    !/^mnt:\[\d+\]$/.test(params.parentMountNamespace)
  ) {
    throw new Error("Invalid bounded command workspace reservation");
  }
  const mountNamespace = await step(assertCurrent, () => fs.readlink("/proc/self/ns/mnt"));
  if (mountNamespace === params.parentMountNamespace || !/^mnt:\[\d+\]$/.test(mountNamespace)) {
    throw new Error("Bounded command setup requires a private mount namespace");
  }
  const source = await step(assertCurrent, () => fs.realpath(contract.workspace));
  if (isWithin(source, reservedRoot) || isWithin(reservedRoot, source)) {
    throw new Error("Command allocation overlaps the host input workspace");
  }
  const reservationStat = await assertDirectory(reservedRoot, assertCurrent);
  const directory = await fs.opendir(reservedRoot);
  try {
    assertCurrent();
    if (await step(assertCurrent, () => directory.read())) {
      throw new Error("Command allocation was already used");
    }
  } finally {
    await directory.close();
  }
  assertCurrent();
  // Reject namespace equality BEFORE even the propagation-changing syscall.
  await mount(["--make-rprivate", "/"], assertCurrent);
  const workingRoot = path.join(reservedRoot, "working");
  const inputRoot = path.join(reservedRoot, "inputs");
  for (const [root, bytes, inodes] of [
    [workingRoot, params.workingBytes, params.workingInodes],
    [inputRoot, SUPERVISED_COMMAND_INPUT_BYTES, INPUT_INODES],
  ] as const) {
    await step(assertCurrent, () => fs.mkdir(root, { mode: 0o700 }));
    await mount(
      [
        "-t",
        "tmpfs",
        "-o",
        `size=${bytes},nr_inodes=${inodes},mode=0700,nosuid,nodev`,
        "tmpfs",
        root,
      ],
      assertCurrent,
    );
  }
  const workspace = path.join(workingRoot, "work");
  const bindMounts: BindMount[] = [];
  for (const [name, target] of [
    ["work", "/work"],
    ["tmp", "/tmp"],
    ["home", "/home"],
    ["shm", "/dev/shm"],
  ] as const) {
    const root = path.join(workingRoot, name);
    await step(assertCurrent, () => fs.mkdir(root, { mode: 0o700 }));
    bindMounts.push({ source: root, target, writable: target !== "/work" || profile.writable });
  }
  await step(assertCurrent, () =>
    fs.mkdir(path.join(workingRoot, "home", "worker"), { mode: 0o700 }),
  );
  const sourceContract = { workspace: source, sourcePaths: contract.sourcePaths };
  const before = await step(assertCurrent, () => captureSupervisedWorkspace(sourceContract));
  await copyManifest({ source, destination: workspace, snapshot: before, assertCurrent });
  // Keep explicitly selected empty directories usable without recursive copying.
  await copySelectedDirectories(source, workspace, contract.sourcePaths, assertCurrent);
  if (
    (await step(assertCurrent, () => captureSupervisedWorkspace(sourceContract))).hash !==
      before.hash ||
    (await step(assertCurrent, () => captureSupervisedWorkspace({ ...sourceContract, workspace })))
      .hash !== before.hash
  ) {
    throw new Error("Private command workspace does not match accepted source");
  }
  const inputs = [
    {
      path: profile.executable,
      sha256: profile.executableSha256,
      maxBytes: 256 * MIB,
      target: "/runtime/command",
    },
    ...profile.readOnlyPaths.map((input) => ({ ...input, maxBytes: 8 * MIB, target: input.path })),
  ];
  if (profile.readOnlyPaths.length > 16) {
    throw new Error("Accepted command input count exceeds its budget");
  }
  for (const [index, input] of inputs.entries()) {
    if (
      !path.isAbsolute(input.path) ||
      path.resolve(input.path) !== input.path ||
      input.path.includes("\0") ||
      !/^[a-f0-9]{64}$/.test(input.sha256) ||
      isWithin(source, input.path) ||
      isWithin(reservedRoot, input.path) ||
      ["/work", "/runtime", "/proc", "/dev"].some((root) => isWithin(root, input.path)) ||
      ["/", "/tmp", "/home", "/usr", "/lib", "/lib64", "/bin", "/sbin"].includes(input.path) ||
      inputs.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          (isWithin(input.target, other.target) || isWithin(other.target, input.target)),
      )
    ) {
      throw new Error("Accepted command input overlaps a reserved sandbox boundary");
    }
    const destination = path.join(inputRoot, String(index));
    await copyFrozenInput({
      source: input.path,
      destination,
      sha256: input.sha256,
      maxBytes: input.maxBytes,
      executable: index === 0,
      assertCurrent,
    });
    bindMounts.push({ source: destination, target: input.target, writable: false });
  }
  await mount(["-o", "remount,bind,ro,nosuid,nodev", inputRoot], assertCurrent);
  const cwd = await step(assertCurrent, () =>
    resolveSupervisedWorkspaceFile(workspace, profile.cwd),
  );
  if (!(await step(assertCurrent, () => fs.lstat(cwd))).isDirectory()) {
    throw new Error("Accepted command cwd is not a directory");
  }
  return {
    reservedRoot,
    allocationId,
    reservationIdentity: { dev: reservationStat.dev, ino: reservationStat.ino },
    mountNamespace,
    workspace,
    inputRoot,
    before,
    sourcePaths: [...contract.sourcePaths],
    bindMounts,
    cwd: path.posix.join("/work", path.relative(workspace, cwd)),
    commandInputHash: createHash("sha256")
      .update(
        JSON.stringify(
          inputs.map(({ path: inputPath, sha256 }) => ({ path: inputPath, hash: sha256 })),
        ),
      )
      .digest("hex"),
    inputBytes: SUPERVISED_COMMAND_INPUT_BYTES,
    workingBytes: params.workingBytes,
    workingInodes: params.workingInodes,
  };
}

/** Caller constructs bwrap with --unshare-all, --cap-drop ALL, cleared env,
 * readonly system roots, --proc /proc and --dev /dev BEFORE these ingredients.
 * No inherited control/export FDs, host export mount, other writable tmpfs, or
 * remaining writable root are allowed. Root/dev remounts must be LAST mounts. */
export function supervisedCommandWorkspaceMountArgs(
  prepared: PreparedSupervisedCommandWorkspace,
): string[] {
  return [
    ...prepared.bindMounts.flatMap(({ source, target, writable }) => [
      writable ? "--bind" : "--ro-bind",
      source,
      target,
    ]),
    "--remount-ro",
    "/dev",
    "--remount-ro",
    "/",
  ];
}

/** Remain in the exact custodian namespace until this finishes. The caller
 * proves payload extinction (not whole-scope extinction: custodian is alive)
 * before harvest. A fresh manifest-only host export preserves file deletions;
 * no writes target the original host workspace or a pre-existing draft. */
export async function harvestSupervisedCommandWorkspace(params: {
  prepared: PreparedSupervisedCommandWorkspace;
  assertPayloadExtinct: () => Promise<void>;
  assertCurrent: AssertCurrent;
}): Promise<{ workspace: string; snapshot: SupervisedWorkspaceSnapshot }> {
  const { prepared, assertCurrent } = params;
  await step(assertCurrent, params.assertPayloadExtinct);
  const namespace = await step(assertCurrent, () => fs.readlink("/proc/self/ns/mnt"));
  if (namespace !== prepared.mountNamespace) {
    throw new Error("Command workspace custodian namespace changed");
  }
  const reservationStat = await assertDirectory(prepared.reservedRoot, assertCurrent);
  if (
    reservationStat.dev !== prepared.reservationIdentity.dev ||
    reservationStat.ino !== prepared.reservationIdentity.ino
  ) {
    throw new Error("Command allocation directory identity changed");
  }
  // Stop all writes through the custodian's mount, too, before reading output.
  await mount(
    ["-o", "remount,bind,ro,nosuid,nodev", path.dirname(prepared.workspace)],
    assertCurrent,
  );
  const contract = { workspace: prepared.workspace, sourcePaths: prepared.sourcePaths };
  const snapshot = await step(assertCurrent, () => captureSupervisedWorkspace(contract));
  const workspace = path.join(prepared.reservedRoot, "export");
  await step(assertCurrent, () => fs.mkdir(workspace, { mode: 0o700 }));
  await copyManifest({
    source: prepared.workspace,
    destination: workspace,
    snapshot,
    assertCurrent,
  });
  await copySelectedDirectories(prepared.workspace, workspace, prepared.sourcePaths, assertCurrent);
  // Capture the WHOLE export, so excluded caches cannot ride along. Selected
  // empty directories carry no bytes and need no recursive artifact copy.
  const exported = await step(assertCurrent, () =>
    captureSupervisedWorkspace({ workspace, sourcePaths: ["."] }),
  );
  if (exported.hash !== snapshot.hash) {
    throw new Error("Command export differs from the accepted output manifest");
  }
  return { workspace, snapshot };
}
