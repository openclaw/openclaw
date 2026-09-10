import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isMissingPathError } from "../infra/errno.js";
import {
  inspectNodeWorkerProcessIdentity,
  type NodeWorkerProcessIdentity,
} from "../node-host/node-worker-process-identity.js";
import { runCommandBuffered } from "../process/exec.js";

export type SupervisedProcessResourceLimits = { memoryBytes: number; tasks: number };

/** Persist this binding before releasing the custodian's payload start gate.
 * The execution ID must be host-generated, durably reserved and NEVER reused,
 * including after collection. A unit name is not authority to start or kill it. */
export type SupervisedProcessScopeIdentity = {
  resourceId: string;
  scopeName: string;
  invocationId: string;
  controlGroup: string;
  hostId: string;
  bootId: string;
  custodian: NodeWorkerProcessIdentity;
  cgroupDevice: string;
  cgroupInode: string;
  limits: SupervisedProcessResourceLimits;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOOT_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const MANAGER_TIMEOUT_MS = 2000;

export function validateSupervisedProcessResourceLimits(
  limits: SupervisedProcessResourceLimits,
): void {
  if (
    !Number.isSafeInteger(limits.memoryBytes) ||
    limits.memoryBytes < 64 * 1024 * 1024 ||
    limits.memoryBytes > 8 * 1024 * 1024 * 1024 ||
    limits.memoryBytes % 4096 !== 0 ||
    !Number.isSafeInteger(limits.tasks) ||
    limits.tasks < 16 ||
    limits.tasks > 512
  ) {
    throw new Error("Invalid supervised process resource limits");
  }
}

export function supervisedProcessScopeName(resourceId: string): string {
  if (!UUID.test(resourceId)) {
    throw new Error("A fresh host-generated execution UUID is required for a process scope");
  }
  return `openclaw-task-${resourceId}.scope`;
}

/** Only wrap the trusted, start-gated custodian, never the untrusted payload.
 * Caller must revalidate live execution authority immediately before spawning. */
export function buildSupervisedProcessScopeArgv(
  resourceId: string,
  limits: SupervisedProcessResourceLimits,
  trustedArgv: readonly string[],
): string[] {
  validateSupervisedProcessResourceLimits(limits);
  const scope = supervisedProcessScopeName(resourceId);
  if (
    !trustedArgv[0] ||
    !path.isAbsolute(trustedArgv[0]) ||
    trustedArgv.some((s) => s.includes("\0"))
  ) {
    throw new Error("A trusted absolute custodian invocation is required");
  }
  return [
    "/usr/bin/systemd-run",
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    `--unit=${scope}`,
    `--property=MemoryMax=${limits.memoryBytes}`,
    "--property=MemorySwapMax=0",
    `--property=TasksMax=${limits.tasks}`,
    "--",
    ...trustedArgv,
  ];
}

function readBootId(): string {
  if (process.platform !== "linux") {
    throw new Error("Bounded supervised process scopes require Linux cgroup v2");
  }
  const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!BOOT_UUID.test(boot)) {
    throw new Error("Process scope host boot identity unavailable");
  }
  return boot;
}

function readHostId(): string {
  if (process.platform !== "linux") {
    throw new Error("Bounded supervised process scopes require Linux cgroup v2");
  }
  const machineId = fs.readFileSync("/etc/machine-id", "utf8").trim();
  if (!/^[0-9a-f]{32}$/.test(machineId) || machineId === "0".repeat(32)) {
    throw new Error("Process scope host installation identity unavailable");
  }
  // Linux installation identity, not clone-proof hardware identity. Persist its
  // digest rather than the raw machine ID; copied installations must regenerate
  // machine-id before sharing recovery state.
  return createHash("sha256").update(machineId).digest("hex");
}

async function readScope(scopeName: string): Promise<Record<string, string>> {
  const result = await runCommandBuffered(
    [
      "/usr/bin/systemctl",
      "--user",
      "show",
      scopeName,
      "--property=Id,LoadState,ActiveState,InvocationID,ControlGroup",
    ],
    { timeoutMs: MANAGER_TIMEOUT_MS, maxOutputBytes: 8192, maxCombinedOutputBytes: 16384 },
  );
  const properties: Record<string, string> = {};
  for (const line of result.stdout.toString("utf8").trim().split("\n")) {
    const equals = line.indexOf("=");
    if (equals < 1 || Object.hasOwn(properties, line.slice(0, equals))) {
      throw new Error("Invalid process scope manager response");
    }
    properties[line.slice(0, equals)] = line.slice(equals + 1);
  }
  if (
    result.termination !== "exit" ||
    (result.code !== 0 && properties.LoadState !== "not-found") ||
    properties.Id !== scopeName
  ) {
    throw new Error("Process scope manager identity unavailable");
  }
  return properties;
}

/** Observe only an unbound plan whose exact, never-reused execution has already
 * been durably sealed against binding/payload admission AND whose launcher
 * transport is proven extinct. Without BOTH caller-owned facts, an absent unit
 * could still arrive later; this observation alone never authorizes replay. */
export async function isSealedSupervisedProcessScopeAbsent(resourceId: string): Promise<boolean> {
  const scopeName = supervisedProcessScopeName(resourceId);
  const scope = await readScope(scopeName);
  if (scope.LoadState === "not-found" && scope.InvocationID === "" && scope.ControlGroup === "") {
    return true;
  }
  // A bootstrap cancelled between `systemd-run` and scope binding can leave the
  // --collect unit loaded but never populated. That unit holds no kernel
  // processes, so the sealed plan's physical capacity is already free; without
  // this case the reservation is unreleasable and permanently consumes a slot.
  // Emptiness is NOT a live-process leak and never licenses signalling.
  if (scope.LoadState !== "loaded") {
    return false;
  }
  const invocationId = scope.InvocationID;
  const controlGroup = scope.ControlGroup;
  if (typeof invocationId !== "string" || !/^[0-9a-f]{32}$/.test(invocationId)) {
    throw new Error("Process scope is not an active, identified invocation");
  }
  if (typeof controlGroup !== "string") {
    throw new Error("Process scope control group is unavailable");
  }
  validateControlGroup(controlGroup, scopeName);
  const pinned = openCgroup(controlGroup);
  try {
    if (readRecursivePopulation(`/proc/self/fd/${pinned.fd}`)) {
      return false;
    }
    // Emptiness is evidence about THIS invocation only. Revalidate the manager
    // while the inode stays pinned, so a same-named replacement unit arriving
    // between the two observations cannot be read as the sealed one's absence.
    const current = await readScope(scopeName);
    if (
      current.LoadState !== "loaded" ||
      current.InvocationID !== invocationId ||
      current.ControlGroup !== controlGroup
    ) {
      throw new Error("Process scope invocation or cgroup changed; cleanup remains unknown");
    }
    const recheck = openCgroup(controlGroup);
    try {
      if (
        recheck.stat.dev.toString() !== pinned.stat.dev.toString() ||
        recheck.stat.ino.toString() !== pinned.stat.ino.toString()
      ) {
        throw new Error("Process cgroup kernel identity changed; cleanup remains unknown");
      }
      return !readRecursivePopulation(`/proc/self/fd/${recheck.fd}`);
    } finally {
      fs.closeSync(recheck.fd);
    }
  } finally {
    fs.closeSync(pinned.fd);
  }
}

function validateControlGroup(controlGroup: string, scopeName: string): void {
  const uid = process.getuid?.();
  const root = `/user.slice/user-${uid}.slice/user@${uid}.service/`;
  if (
    uid === undefined ||
    !controlGroup.startsWith(root) ||
    !controlGroup.endsWith(`/${scopeName}`) ||
    controlGroup.length > 4096 ||
    controlGroup
      .split("/")
      .slice(1)
      .some((part) => !/^[A-Za-z0-9_.@:-]+$/.test(part) || part === "." || part === "..")
  ) {
    throw new Error("Process scope is outside its exact user-owned cgroup");
  }
}

/** Pin the actual kernel directory through all limit/events reads. A pathname
 * replacement must not turn a previously checked identity into a different one.
 * The caller owns the returned descriptor and must always close it. */
function openCgroup(controlGroup: string): { fd: number; stat: fs.BigIntStats } {
  const fd = fs.openSync(
    `/sys/fs/cgroup${controlGroup}`,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isDirectory()) {
      throw new Error("Process cgroup is not a kernel directory");
    }
    return { fd, stat };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function withCgroup<T>(
  controlGroup: string,
  inspect: (root: string, stat: fs.BigIntStats) => T,
): T {
  const { fd, stat } = openCgroup(controlGroup);
  try {
    return inspect(`/proc/self/fd/${fd}`, stat);
  } finally {
    fs.closeSync(fd);
  }
}

/** Recursive population of the pinned cgroup. Partial or unparseable evidence
 * is an error, never an inferred emptiness. */
function readRecursivePopulation(root: string): boolean {
  const events = fs.readFileSync(`${root}/cgroup.events`, "utf8");
  const matches = [...events.matchAll(/^populated ([01])$/gm)];
  if (matches.length !== 1 || !matches[0]) {
    throw new Error("Process cgroup recursive population unavailable");
  }
  return matches[0][1] === "1";
}

function assertCustodian(custodian: NodeWorkerProcessIdentity, controlGroup: string): void {
  if (
    !Number.isSafeInteger(custodian.pid) ||
    custodian.pid <= 0 ||
    !Number.isSafeInteger(custodian.startTime) ||
    custodian.startTime < 0 ||
    inspectNodeWorkerProcessIdentity(custodian) !== "live"
  ) {
    throw new Error("Process custodian process identity changed or is unavailable");
  }
  const membership = fs.readFileSync(`/proc/${custodian.pid}/cgroup`, "utf8").trim();
  if (
    membership !== `0::${controlGroup}` ||
    inspectNodeWorkerProcessIdentity(custodian) !== "live"
  ) {
    throw new Error("Process custodian is not in its exact reserved scope");
  }
}

function assertSameScope(
  scope: Record<string, string>,
  identity: SupervisedProcessScopeIdentity,
): void {
  if (
    scope.LoadState !== "loaded" ||
    scope.InvocationID !== identity.invocationId ||
    scope.ControlGroup !== identity.controlGroup
  ) {
    throw new Error("Process scope invocation or cgroup changed; cleanup remains unknown");
  }
}

function validateIdentity(identity: SupervisedProcessScopeIdentity): void {
  if (
    identity.scopeName !== supervisedProcessScopeName(identity.resourceId) ||
    !/^[0-9a-f]{32}$/.test(identity.invocationId) ||
    !/^[0-9]+$/.test(identity.cgroupDevice) ||
    !/^[1-9][0-9]*$/.test(identity.cgroupInode) ||
    !BOOT_UUID.test(identity.bootId) ||
    !/^[0-9a-f]{64}$/.test(identity.hostId) ||
    identity.hostId !== readHostId() ||
    !Number.isSafeInteger(identity.custodian.pid) ||
    identity.custodian.pid <= 0 ||
    !Number.isSafeInteger(identity.custodian.startTime) ||
    identity.custodian.startTime < 0
  ) {
    throw new Error("Process scope binding does not identify this execution host");
  }
  validateControlGroup(identity.controlGroup, identity.scopeName);
  validateSupervisedProcessResourceLimits(identity.limits);
}

/** A different boot on the same installation proves that the bound kernel
 * processes are extinct. This observation grants no authority over current
 * units, even if a current unit has the same name. Missing/wrong host evidence
 * throws: absence of evidence must not become physical-capacity release. */
export function isSupervisedProcessBootRetired(identity: SupervisedProcessScopeIdentity): boolean {
  validateIdentity(identity);
  return identity.bootId !== readBootId();
}

/** Both the parent and the gated custodian may inspect; neither observation
 * authorizes payload admission. Commit the binding and recheck live authority. */
export async function inspectSupervisedProcessScope(params: {
  resourceId: string;
  limits: SupervisedProcessResourceLimits;
  expectedProcess: NodeWorkerProcessIdentity;
  assertCurrent: () => void;
}): Promise<SupervisedProcessScopeIdentity> {
  const limits = { ...params.limits };
  const custodian = { ...params.expectedProcess };
  validateSupervisedProcessResourceLimits(limits);
  const scopeName = supervisedProcessScopeName(params.resourceId);
  const hostId = readHostId();
  const bootId = readBootId();
  params.assertCurrent();
  const scope = await readScope(scopeName);
  params.assertCurrent();
  const invocationId = scope.InvocationID;
  if (
    scope.LoadState !== "loaded" ||
    scope.ActiveState !== "active" ||
    !invocationId ||
    !/^[0-9a-f]{32}$/.test(invocationId)
  ) {
    throw new Error("Process scope is not an active, identified invocation");
  }
  const controlGroup = scope.ControlGroup;
  if (!controlGroup) {
    throw new Error("Process scope cgroup is unavailable");
  }
  validateControlGroup(controlGroup, scopeName);
  assertCustodian(custodian, controlGroup);
  const inode = withCgroup(controlGroup, (root, stat) => {
    for (const [file, expected] of [
      ["memory.max", limits.memoryBytes],
      ["memory.swap.max", 0],
      ["pids.max", limits.tasks],
    ] as const) {
      if (fs.readFileSync(`${root}/${file}`, "utf8").trim() !== String(expected)) {
        throw new Error(`Process scope kernel limit ${file} does not match accepted policy`);
      }
    }
    return { cgroupDevice: stat.dev.toString(), cgroupInode: stat.ino.toString() };
  });
  const identity: SupervisedProcessScopeIdentity = {
    resourceId: params.resourceId,
    scopeName,
    invocationId,
    controlGroup,
    hostId,
    bootId,
    custodian,
    ...inode,
    limits,
  };
  const currentScope = await readScope(scopeName);
  params.assertCurrent();
  assertSameScope(currentScope, identity);
  if (isSupervisedProcessBootRetired(identity)) {
    throw new Error("Process scope host boot changed during admission");
  }
  assertCustodian(custodian, identity.controlGroup);
  withCgroup(identity.controlGroup, (_root, stat) => assertCgroupIdentity(stat, identity));
  return identity;
}

function assertCgroupIdentity(
  stat: fs.BigIntStats,
  identity: SupervisedProcessScopeIdentity,
): void {
  if (
    stat.dev.toString() !== identity.cgroupDevice ||
    stat.ino.toString() !== identity.cgroupInode
  ) {
    throw new Error("Process cgroup kernel identity changed; cleanup remains unknown");
  }
}

/** Wrapper/main-process exit and ActiveState alone NEVER establish extinction. */
export async function isSupervisedProcessScopeClosed(
  identity: SupervisedProcessScopeIdentity,
): Promise<boolean> {
  if (isSupervisedProcessBootRetired(identity)) {
    return true;
  }
  const scope = await readScope(identity.scopeName);
  if (isSupervisedProcessBootRetired(identity)) {
    return true;
  }
  if (
    (scope.InvocationID && scope.InvocationID !== identity.invocationId) ||
    (scope.ControlGroup && scope.ControlGroup !== identity.controlGroup)
  ) {
    throw new Error("Process scope invocation or cgroup changed; cleanup remains unknown");
  }
  let populated: boolean;
  try {
    populated = withCgroup(identity.controlGroup, (root, stat) => {
      assertCgroupIdentity(stat, identity);
      return readRecursivePopulation(root);
    });
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
    // The cgroup can retire between show and open. Reconcile fresh manager
    // state rather than treating that normal race as an unknown cleanup.
    const retired = await readScope(identity.scopeName);
    if (isSupervisedProcessBootRetired(identity)) {
      return true;
    }
    // GC of a never-reused unit or retirement of the bound invocation, AND
    // absence of its kernel directory, prove closure. Manager errors do not.
    if (retired.LoadState === "not-found" && !retired.InvocationID && !retired.ControlGroup) {
      return true;
    }
    if (
      retired.LoadState === "loaded" &&
      ["inactive", "failed"].includes(retired.ActiveState ?? "") &&
      retired.InvocationID === identity.invocationId &&
      retired.ControlGroup === ""
    ) {
      return true;
    }
    throw new Error("Process cgroup disappeared without matching scope retirement", {
      cause: error,
    });
  }
  assertSameScope(scope, identity);
  return !populated;
}

export async function awaitSupervisedProcessScopeClosed(
  identity: SupervisedProcessScopeIdentity,
  timeoutMs = 5000,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) {
    throw new Error("Invalid bounded process cleanup deadline");
  }
  const deadline = performance.now() + timeoutMs;
  do {
    if (await isSupervisedProcessScopeClosed(identity)) {
      return;
    }
    if (performance.now() >= deadline) {
      break;
    }
    await delay(Math.min(50, Math.max(0, deadline - performance.now())));
  } while (performance.now() <= deadline);
  throw new Error("Process resource scope remains populated; cleanup is not complete");
}

/** Cleanup authority is independent of permission to run more payload work.
 * systemd kill is name-addressed, not InvocationID-CAS: durable UUID non-reuse
 * is mandatory. Never signal a scope discovered only by a plausible name. */
export async function terminateSupervisedProcessScope(
  identity: SupervisedProcessScopeIdentity,
  assertCleanupCurrent: () => void,
): Promise<void> {
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    assertCleanupCurrent();
    if (await isSupervisedProcessScopeClosed(identity)) {
      assertCleanupCurrent();
      return;
    }
    assertCleanupCurrent();
    const scope = await readScope(identity.scopeName);
    assertCleanupCurrent();
    if (isSupervisedProcessBootRetired(identity)) {
      return;
    }
    assertSameScope(scope, identity);
    withCgroup(identity.controlGroup, (_root, stat) => assertCgroupIdentity(stat, identity));
    assertCleanupCurrent();
    const result = await runCommandBuffered(
      [
        "/usr/bin/systemctl",
        "--user",
        "kill",
        "--kill-who=all",
        `--signal=${signal}`,
        identity.scopeName,
      ],
      { timeoutMs: MANAGER_TIMEOUT_MS, maxOutputBytes: 8192, maxCombinedOutputBytes: 16384 },
    );
    assertCleanupCurrent();
    // A failed or timed-out manager process can still have applied. Reconcile
    // observable closure once, never replay the uncertain mutation blindly.
    if (result.termination !== "exit" || result.code !== 0) {
      if (await isSupervisedProcessScopeClosed(identity)) {
        assertCleanupCurrent();
        return;
      }
      throw new Error("Process scope termination was uncertain; custody remains held");
    }
    if (signal === "SIGTERM") {
      await delay(100);
    }
  }
  await awaitSupervisedProcessScopeClosed(identity);
  assertCleanupCurrent();
}

/** Host facts for a pre-bind launch tombstone; never signaling authority. */
export function readSupervisedProcessHostIdentity() {
  return { hostId: readHostId(), bootId: readBootId() };
}

/** A payload-host check, not merely a model-executable check. Call before
 * exposing host tools and again at resource-owned action boundaries. */
export function assertSupervisedProcessScopeMember(
  identity: SupervisedProcessScopeIdentity,
  member: NodeWorkerProcessIdentity,
): void {
  validateIdentity(identity);
  if (identity.bootId !== readBootId()) {
    throw new Error("Process resource boot retired");
  }
  withCgroup(identity.controlGroup, (_root, stat) => assertCgroupIdentity(stat, identity));
  assertCustodian(member, identity.controlGroup);
}
