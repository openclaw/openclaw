import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  assertDirectory,
  copyManifest,
  copySelectedDirectories,
  isWithin,
  mount,
  step,
  type AssertCurrent,
} from "./supervised-private-workspace.js";
import {
  captureSupervisedWorkspace,
  type SupervisedWorkspaceSnapshot,
} from "./supervised-workspace.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MIB = 1024 * 1024;

// Owner adapters validate their actual operation/attempt authority before mapping
// these filesystem-only facts. No attempt, command profile or runtime grant here.
const RuntimeWorkspacePlanSchema = z.strictObject({
  resourceId: z.uuid(),
  allocationId: z.uuid(),
  storage: z.strictObject({
    workingBytes: z
      .number()
      .int()
      .min(4096)
      .max(512 * 1024 * 1024),
    workingInodes: z.number().int().min(16).max(100_000),
  }),
  workspace: z
    .strictObject({
      sourceVersion: z.uuid(),
      sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .nullable(),
});
export type SupervisedRuntimeWorkspacePlan = z.infer<typeof RuntimeWorkspacePlanSchema>;

export type PreparedSupervisedRuntimeWorkspace = {
  resourceId: string;
  reservedRoot: string;
  allocationId: string;
  reservationIdentity: { dev: number; ino: number };
  artifactRoot: string;
  mountNamespace: string;
  userNamespace: string;
  hostUid: number;
  hostGid: number;
  workingRoot: string;
  workspace: string;
  sourceVersion: string | null;
  sourceWorkspace: string | null;
  before: SupervisedWorkspaceSnapshot;
  sourcePaths: string[];
  workingBytes: number;
  workingInodes: number;
};

/** Trusted custodian only, before any payload. The outer launcher must already
 * bind THIS process to the verified attempt cgroup. The guard must re-read SQL
 * attempt/source/allocation authority, not merely check a captured token.
 *
 * allocationId is independently reserved even for goal-definition attempts.
 * sourceWorkspace is the retained sourceVersion path, never the original input
 * workspace. No fallback or repeated setup after a partial mount is permitted.
 * Close the entire namespace on preparation failure. */
export async function prepareSupervisedRuntimeWorkspace(params: {
  plan: SupervisedRuntimeWorkspacePlan;
  allocationId: string;
  reservedRoot: string;
  sourceWorkspace: string | null;
  sourcePaths: string[];
  parentMountNamespace: string;
  parentUserNamespace: string;
  hostUid: number;
  hostGid: number;
  workingBytes: number;
  workingInodes: number;
  assertCurrent: AssertCurrent;
}): Promise<PreparedSupervisedRuntimeWorkspace> {
  const { assertCurrent, reservedRoot, allocationId } = params;
  const plan = RuntimeWorkspacePlanSchema.parse(params.plan);
  assertCurrent();
  if (
    process.platform !== "linux" ||
    !UUID.test(allocationId) ||
    allocationId !== plan.allocationId ||
    path.basename(reservedRoot) !== allocationId ||
    !path.isAbsolute(reservedRoot) ||
    path.resolve(reservedRoot) !== reservedRoot ||
    !Number.isSafeInteger(params.hostUid) ||
    params.hostUid < 1 ||
    !Number.isSafeInteger(params.hostGid) ||
    params.hostGid < 0 ||
    process.getuid?.() !== params.hostUid ||
    process.getgid?.() !== params.hostGid ||
    params.workingBytes !== plan.storage.workingBytes ||
    params.workingInodes !== plan.storage.workingInodes ||
    !Number.isSafeInteger(params.workingBytes) ||
    params.workingBytes < 4096 ||
    params.workingBytes > 512 * MIB ||
    !Number.isSafeInteger(params.workingInodes) ||
    params.workingInodes < 16 ||
    params.workingInodes > 100_000 ||
    !/^mnt:\[\d+\]$/.test(params.parentMountNamespace) ||
    !/^user:\[\d+\]$/.test(params.parentUserNamespace)
  ) {
    throw new Error("Invalid private attempt workspace or changed authentication owner");
  }
  const mountNamespace = await step(assertCurrent, () => fs.readlink("/proc/self/ns/mnt"));
  const userNamespace = await step(assertCurrent, () => fs.readlink("/proc/self/ns/user"));
  if (
    mountNamespace === params.parentMountNamespace ||
    !/^mnt:\[\d+\]$/.test(mountNamespace) ||
    userNamespace === params.parentUserNamespace ||
    !/^user:\[\d+\]$/.test(userNamespace)
  ) {
    throw new Error("Attempt setup requires private mount and user namespaces");
  }
  let source: string | null = null;
  if (plan.workspace) {
    if (
      !params.sourceWorkspace ||
      path.basename(params.sourceWorkspace) !== plan.workspace.sourceVersion ||
      !params.sourcePaths.length ||
      params.sourcePaths.length > 64
    ) {
      throw new Error("Attempt workspace does not match its accepted source reservation");
    }
    const selectedSource = params.sourceWorkspace;
    source = await step(assertCurrent, () => fs.realpath(selectedSource));
    if (
      source !== params.sourceWorkspace ||
      isWithin(source, reservedRoot) ||
      isWithin(reservedRoot, source)
    ) {
      throw new Error("Attempt allocation overlaps or aliases its retained source");
    }
  } else if (params.sourceWorkspace !== null || params.sourcePaths.length !== 0) {
    throw new Error("Goal-definition attempt cannot borrow an unowned workspace");
  }
  const artifactRoot = path.dirname(reservedRoot);
  if (path.basename(artifactRoot) !== "taskflow-workspaces") {
    throw new Error("Attempt must use the canonical artifact store");
  }
  await assertDirectory(artifactRoot, assertCurrent);
  const reservation = await assertDirectory(reservedRoot, assertCurrent);
  if (reservation.uid !== params.hostUid) {
    throw new Error("Attempt allocation belongs to another user");
  }
  const directory = await fs.opendir(reservedRoot);
  try {
    assertCurrent();
    if (await step(assertCurrent, () => directory.read())) {
      throw new Error("Attempt allocation was already used");
    }
  } finally {
    await directory.close();
  }

  // Only after private-namespace/identity checks. Never touches host mount
  // propagation or the host's user.max_user_namespaces setting.
  await mount(["--make-rprivate", "/"], assertCurrent);
  await step(assertCurrent, () => fs.writeFile("/proc/sys/user/max_user_namespaces", "1"));
  if (
    (
      await step(assertCurrent, () => fs.readFile("/proc/sys/user/max_user_namespaces", "utf8"))
    ).trim() !== "1"
  ) {
    throw new Error("Attempt descendant namespace limit was not installed");
  }
  const workingRoot = path.join(reservedRoot, "working");
  await step(assertCurrent, () => fs.mkdir(workingRoot, { mode: 0o700 }));
  await mount(
    [
      "-t",
      "tmpfs",
      "-o",
      `size=${params.workingBytes},nr_inodes=${params.workingInodes},mode=0700,nosuid,nodev`,
      "tmpfs",
      workingRoot,
    ],
    assertCurrent,
  );
  for (const name of ["work", "tmp", "var-tmp", "shm"]) {
    await step(assertCurrent, () => fs.mkdir(path.join(workingRoot, name), { mode: 0o700 }));
  }
  const workspace = path.join(workingRoot, "work");
  const sourcePaths = source ? [...params.sourcePaths] : ["."];
  const before = await step(assertCurrent, () =>
    captureSupervisedWorkspace({ workspace: source ?? workspace, sourcePaths }),
  );
  if (source && plan.workspace) {
    if (before.hash !== plan.workspace.sourceHash) {
      throw new Error("Retained attempt source digest changed");
    }
    await copyManifest({ source, destination: workspace, snapshot: before, assertCurrent });
    await copySelectedDirectories(source, workspace, sourcePaths, assertCurrent);
    if (
      (
        await step(assertCurrent, () =>
          captureSupervisedWorkspace({ workspace: source, sourcePaths }),
        )
      ).hash !== before.hash
    ) {
      throw new Error("Attempt source changed during private copy");
    }
  }
  if (
    (await step(assertCurrent, () => captureSupervisedWorkspace({ workspace, sourcePaths })))
      .hash !== before.hash
  ) {
    throw new Error("Private attempt workspace differs from its admitted source");
  }
  return {
    resourceId: plan.resourceId,
    reservedRoot,
    allocationId,
    artifactRoot,
    reservationIdentity: { dev: reservation.dev, ino: reservation.ino },
    mountNamespace,
    userNamespace,
    hostUid: params.hostUid,
    hostGid: params.hostGid,
    workingRoot,
    workspace,
    sourceVersion: plan.workspace?.sourceVersion ?? null,
    sourceWorkspace: source,
    before,
    sourcePaths,
    workingBytes: params.workingBytes,
    workingInodes: params.workingInodes,
  };
}

/** Complete bwrap prefix, excluding the trusted OpenClaw entrypoint/arguments.
 * No --clearenv, HOME/CODEX_HOME substitution, credential copy or network
 * namespace: canonical read-only authentication remains visible at its path.
 * The caller supplies its exact protected inherited environment unchanged.
 *
 * Runtime writable roots are explicit canonical host-owned directories required
 * by the accepted runtime (SQLite parent, session/transcript/cache roots). Their
 * writes are NOT bounded by workingBytes. Never describe this as an all-disk
 * quota. Keep the list narrow; never accept it from model output.
 *
 * bwrap consumes the sole descendant user namespace, then drops every capability.
 * The trusted payload must verify its UID and namespace/cgroup identity before
 * starting model/tool callbacks. --die-with-parent is not an extinction proof. */
export async function supervisedRuntimeWorkspacePayloadPrefix(params: {
  prepared: PreparedSupervisedRuntimeWorkspace;
  writableRuntimePaths: string[];
  readOnlyRuntimeFiles?: string[];
  assertCurrent: AssertCurrent;
}): Promise<string[]> {
  const { prepared, assertCurrent } = params;
  if (params.writableRuntimePaths.length > 32) {
    throw new Error("Too many attempt runtime write roots");
  }
  assertCurrent();
  if (
    process.getuid?.() !== prepared.hostUid ||
    process.getgid?.() !== prepared.hostGid ||
    (await step(assertCurrent, () => fs.readlink("/proc/self/ns/mnt"))) !==
      prepared.mountNamespace ||
    (await step(assertCurrent, () => fs.readlink("/proc/self/ns/user"))) !== prepared.userNamespace
  ) {
    throw new Error("Attempt payload recipe changed owner or namespace");
  }
  const argv = [
    // The UID-preserving custodian needs mount capabilities, but bwrap rejects
    // inherited non-root capabilities. Drop them on this exec handoff only;
    // bwrap obtains setup authority in its new namespace and drops it for payload.
    "/usr/bin/setpriv",
    "--inh-caps=-all",
    "--ambient-caps=-all",
    "--bounding-set=-all",
    "--",
    "/usr/bin/bwrap",
    "--unshare-user",
    "--uid",
    String(prepared.hostUid),
    "--gid",
    String(prepared.hostGid),
    "--die-with-parent",
    "--new-session",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/",
    "/",
  ];
  // The read-only host bind also applies nodev recursively. Native runtimes
  // still need entropy devices, and child stdio setup needs /dev/null. Restore
  // only these standard character devices, not the host /dev tree or another
  // writable tmpfs that would escape the shared working-storage quota.
  for (const device of ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom"]) {
    argv.push("--dev-bind", device, device);
  }
  // Overlay temporary roots first, then restore explicit runtime/source paths.
  // This order also supports isolated fixture state below host /tmp.
  for (const [name, target] of [
    ["tmp", "/tmp"],
    ["var-tmp", "/var/tmp"],
    ["shm", "/dev/shm"],
  ] as const) {
    argv.push("--bind", path.join(prepared.workingRoot, name), target);
  }
  const selected = new Set<string>();
  for (const root of params.writableRuntimePaths) {
    if (
      !path.isAbsolute(root) ||
      path.resolve(root) !== root ||
      ["/", "/tmp", "/var", "/var/tmp", "/dev", "/proc", "/sys", "/home", "/usr", "/run"].includes(
        root,
      ) ||
      ["/dev", "/proc", "/sys"].some((boundary) => isWithin(boundary, root)) ||
      isWithin(prepared.artifactRoot, root) ||
      selected.has(root)
    ) {
      throw new Error("Unsafe attempt runtime write root");
    }
    const canonical = await step(assertCurrent, () => fs.realpath(root));
    const stat = await step(assertCurrent, () => fs.lstat(root));
    if (
      canonical !== root ||
      !stat.isDirectory() ||
      stat.uid !== prepared.hostUid ||
      (stat.mode & 0o022) !== 0
    ) {
      throw new Error("Attempt runtime write root is not canonical and host-owned");
    }
    selected.add(root);
    argv.push("--bind", root, root);
  }
  // Files remain read-only even when their parent is a writable runtime root.
  for (const file of params.readOnlyRuntimeFiles ?? []) {
    if (
      (params.readOnlyRuntimeFiles?.length ?? 0) > 16 ||
      !path.isAbsolute(file) ||
      path.resolve(file) !== file
    ) {
      throw new Error("Invalid runtime configuration file");
    }
    const canonical = await step(assertCurrent, () => fs.realpath(file));
    const stat = await step(assertCurrent, () => fs.stat(canonical));
    if (!stat.isFile() || isWithin(prepared.artifactRoot, canonical)) {
      throw new Error("Runtime configuration must be a regular host file");
    }
    argv.push("--ro-bind", canonical, file);
  }
  // Runtime state SQLite/WAL may need the artifact store's parent writable.
  // Re-overlay the ENTIRE artifact store after every runtime write root, not
  // merely this attempt: accepted versions, other drafts and exports stay RO.
  // Only the current private working subtree is exposed writable below it.
  // No control/export descriptor is deliberately passed to the payload.
  argv.push(
    "--ro-bind",
    prepared.artifactRoot,
    prepared.artifactRoot,
    "--ro-bind",
    prepared.reservedRoot,
    prepared.reservedRoot,
    "--bind",
    prepared.workspace,
    prepared.workspace,
  );
  argv.push("--chdir", prepared.workspace, "--");
  assertCurrent();
  return argv;
}

/** Same custodian namespace only. The callback must join ALL tool-serving
 * payload/model descendants, not only observe the model executable exit. The
 * SQL candidate owner separately validates exported bytes and closes the full
 * physical scope before committing accepted source/decision state. */
export async function harvestSupervisedRuntimeWorkspace(params: {
  prepared: PreparedSupervisedRuntimeWorkspace;
  assertPayloadExtinct: () => Promise<void>;
  assertCurrent: AssertCurrent;
}): Promise<{ workspace: string; snapshot: SupervisedWorkspaceSnapshot }> {
  const { prepared, assertCurrent } = params;
  await step(assertCurrent, params.assertPayloadExtinct);
  if (
    (await step(assertCurrent, () => fs.readlink("/proc/self/ns/mnt"))) !==
      prepared.mountNamespace ||
    (await step(assertCurrent, () => fs.readlink("/proc/self/ns/user"))) !== prepared.userNamespace
  ) {
    throw new Error("Attempt workspace custodian namespace changed");
  }
  const reservation = await assertDirectory(prepared.reservedRoot, assertCurrent);
  if (
    reservation.dev !== prepared.reservationIdentity.dev ||
    reservation.ino !== prepared.reservationIdentity.ino ||
    reservation.uid !== prepared.hostUid
  ) {
    throw new Error("Attempt allocation directory identity changed");
  }
  await mount(["-o", "remount,bind,ro,nosuid,nodev", prepared.workingRoot], assertCurrent);
  const snapshot = await step(assertCurrent, () =>
    captureSupervisedWorkspace({
      workspace: prepared.workspace,
      sourcePaths: prepared.sourcePaths,
    }),
  );
  const workspace = path.join(prepared.reservedRoot, "export");
  await step(assertCurrent, () => fs.mkdir(workspace, { mode: 0o700 }));
  await copyManifest({
    source: prepared.workspace,
    destination: workspace,
    snapshot,
    assertCurrent,
  });
  await copySelectedDirectories(prepared.workspace, workspace, prepared.sourcePaths, assertCurrent);
  const exported = await step(assertCurrent, () =>
    captureSupervisedWorkspace({ workspace, sourcePaths: ["."] }),
  );
  if (snapshot.hash !== exported.hash) {
    throw new Error("Attempt export differs from its bounded manifest");
  }
  return { workspace, snapshot };
}
