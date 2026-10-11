import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import { resolveDiagnosticProcessEnv } from "../infra/process-env.js";
import { spawnPsSync } from "../infra/spawn-ps.js";
import { parseKeyValueOutput } from "./runtime-parse.js";

type ServiceProcessMembership = "inside" | "outside" | "unknown" | "absent";
type ResourceCoalition = { id: number; name?: string };
const PROBE_TIMEOUT_MS = 2_000;
// Node startup plus two native library loads; sized for old Intel Macs.
const NATIVE_PROBE_TIMEOUT_MS = 10_000;
declare const SEALED_RUNTIME_BUILD: boolean;

// Koffi segfaults some Darwin hosts (x86_64 under Rosetta), so the query runs in a joined
// child: a crash only loses the observation. Coalition IDs are kernel facts; the job name
// comes from launchd and may be unavailable.
const NATIVE_COALITION_SCRIPT = String.raw`
function probe() {
const koffi = require(process.argv[1]);
const pid = Number(process.argv[2]);
const libproc = koffi.load('/usr/lib/libproc.dylib');
const pidinfo = libproc.func('int proc_pidinfo(int pid, int flavor, uint64_t arg, _Out_ void *buffer, int buffersize)');
// PROC_PIDCOALITIONINFO: resource and jetsam coalition IDs, then three reserved uint64s.
const info = Buffer.alloc(40);
if (pidinfo(pid, 20, 0, info, info.length) !== info.length) { process.exitCode = 1; return; }
const id = info.readBigUInt64LE(0);
if (!id) { process.exitCode = 1; return; }
let name;
try {
  const xpc = koffi.load('/usr/lib/system/libxpc.dylib');
  const copy = xpc.func('void *xpc_coalition_copy_info(uint64_t id)');
  const release = xpc.func('void xpc_release(void *value)');
  const type = xpc.func('void *xpc_get_type(void *value)');
  const getId = xpc.func('uint64_t xpc_dictionary_get_uint64(void *value, const char *key)');
  const getName = xpc.func('const char *xpc_dictionary_get_string(void *value, const char *key)');
  const dictionaryType = koffi.address(xpc.symbol('_xpc_type_dictionary'));
  const idKey = koffi.decode(xpc.symbol('XPC_COALITION_INFO_KEY_CID'), 'const char *');
  const nameKey = koffi.decode(xpc.symbol('XPC_COALITION_INFO_KEY_NAME'), 'const char *');
  const reply = copy(id);
  if (reply) {
    try {
      if (koffi.address(type(reply)) === dictionaryType && BigInt(getId(reply, idKey)) === id) {
        name = getName(reply, nameKey) ?? undefined;
      }
    } finally {
      release(reply);
    }
  }
} catch {}
process.stdout.write(JSON.stringify({ id: String(id), name }));
}
probe();
`;

function readNativeResourceCoalition(pid: number): ResourceCoalition | undefined {
  if (typeof SEALED_RUNTIME_BUILD === "boolean" && SEALED_RUNTIME_BUILD) {
    return undefined;
  }
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      NATIVE_COALITION_SCRIPT,
      createRequire(import.meta.url).resolve("koffi"),
      String(pid),
    ],
    {
      encoding: "utf8",
      env: resolveDiagnosticProcessEnv(),
      stdio: ["ignore", "pipe", "ignore"],
      timeout: NATIVE_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 4096,
    },
  );
  if (result.error || result.status !== 0) {
    return undefined;
  }
  const info: unknown = JSON.parse(result.stdout);
  if (!info || typeof info !== "object" || !("id" in info) || typeof info.id !== "string") {
    return undefined;
  }
  const id = Number(info.id);
  if (!/^[1-9]\d*$/.test(info.id) || !Number.isSafeInteger(id)) {
    return undefined;
  }
  const name = "name" in info && typeof info.name === "string" ? info.name.trim() : "";
  return name && !containsAsciiControlCharacter(name) ? { id, name } : { id };
}

function readResourceCoalition(pid: number): ResourceCoalition | null | undefined {
  const result = spawnSync("/bin/launchctl", ["print", `pid/${pid}`], {
    encoding: "utf8",
    env: resolveDiagnosticProcessEnv(),
    timeout: PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    return undefined;
  }
  if (result.status !== 0) {
    // macOS 12 refuses `print pid/<pid>` for most processes (exit 1, EPERM).
    return readNativeResourceCoalition(pid);
  }
  const lines = result.stdout.trim().split(/\r?\n/);
  if (/^pid\/([1-9]\d*)\s*=\s*\{$/.exec(lines[0] ?? "")?.[1] !== String(pid)) {
    return undefined;
  }
  let depth = 1;
  let pidType = false;
  for (const rawLine of lines.slice(1)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (depth === 0) {
      return undefined;
    }
    if (line === "}") {
      depth--;
    } else if (/[=]\s*\{$/.test(line)) {
      depth++;
    } else if (depth === 1 && !line.includes("=")) {
      return undefined;
    } else if (depth === 1 && /^type\s*=/.test(line)) {
      if (pidType || !/^type\s*=\s*pid$/.test(line)) {
        return undefined;
      }
      pidType = true;
    }
  }
  if (depth !== 0 || !pidType) {
    return undefined;
  }
  const headers = result.stdout.match(/^\s*resource coalition\s*=/gm);
  if (!headers) {
    return /resource coalition/i.test(result.stdout) ? undefined : null;
  }
  const body = /^\s*resource coalition\s*=\s*\{([^{}]*)^\s*\}/m.exec(result.stdout)?.[1];
  if (headers.length !== 1 || !body) {
    return undefined;
  }
  const fields = parseKeyValueOutput(body, "=");
  for (const key of ["id", "type", "name"]) {
    if (
      body.split(/\r?\n/).filter((line) => line.trim().split(/\s*=/)[0]?.toLowerCase() === key)
        .length !== 1
    ) {
      return undefined;
    }
  }
  const id = Number(fields.id);
  return fields.type === "resource" &&
    /^[1-9]\d*$/.test(fields.id ?? "") &&
    Number.isSafeInteger(id) &&
    fields.name &&
    !containsAsciiControlCharacter(fields.name)
    ? { id, name: fields.name }
    : undefined;
}

function inspectLaunchdMembership(gatewayPid: number): ServiceProcessMembership {
  const expected = new Set([process.pid, gatewayPid]);
  const result = spawnPsSync(
    ["-o", "pid=,pgid=,sess=", "-p", [...expected].join(",")],
    PROBE_TIMEOUT_MS,
  );
  if (result.error || result.status !== 0) {
    return "unknown";
  }
  const groups = new Map<number, number>();
  for (const line of result.stdout.trim().split(/\r?\n/)) {
    const match = /^\s*([1-9]\d*)\s+([1-9]\d*)\s+(?:0x)?[\da-f]+\s*$/i.exec(line);
    const pid = Number(match?.[1]);
    const group = Number(match?.[2]);
    if (!match || !expected.has(pid) || groups.has(pid) || !Number.isSafeInteger(group)) {
      return "unknown";
    }
    groups.set(pid, group);
  }
  if (groups.size !== expected.size) {
    return "unknown";
  }
  if (groups.get(process.pid) === groups.get(gatewayPid)) {
    return "inside";
  }
  // Reparenting and setsid can remove ancestry/group evidence while launchd still owns the job.
  const caller = readResourceCoalition(process.pid);
  const gateway = readResourceCoalition(gatewayPid);
  if (caller === undefined || gateway === undefined) {
    return "unknown";
  }
  if (gateway === null) {
    return "absent";
  }
  if (!caller || caller.id === gateway.id) {
    return caller ? "inside" : "outside";
  }
  // A job's earlier instance can leave children under the same name with another ID.
  return !caller.name || !gateway.name
    ? "unknown"
    : caller.name === gateway.name
      ? "inside"
      : "outside";
}

function readLinuxProcessGroupId(pid: number): number | undefined {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  // comm may contain spaces, newlines and parentheses; pgrp follows its final closing parenthesis.
  const match = /^([1-9]\d*) \([\s\S]*\) (\S) (\d+) ([1-9]\d*)(?:\s|$)/.exec(stat);
  const group = Number(match?.[4]);
  return match &&
    Number(match[1]) === pid &&
    Number.isSafeInteger(Number(match[3])) &&
    Number.isSafeInteger(group)
    ? group
    : undefined;
}

function isCgroupPath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !containsAsciiControlCharacter(path) &&
    !/\s/.test(path) &&
    (path === "/" ||
      path
        .split("/")
        .slice(1)
        .every((part) => part && part !== "." && part !== ".."))
  );
}

function isWithinControlGroup(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function readSystemdMembership(
  pid: number,
): { hierarchy: string; path: string } | { hierarchy: null; atRoot: boolean } | undefined {
  const rows = readFileSync(`/proc/${pid}/cgroup`, "utf8").split(/\r?\n/).filter(Boolean);
  if (rows.length === 0) {
    return undefined;
  }
  const memberships = new Map<string, { controllers: string[]; path: string }>();
  for (const row of rows) {
    const fields = /^(0|[1-9]\d*):([^:]*):(.*)$/.exec(row);
    if (!fields) {
      return undefined;
    }
    const hierarchy = fields[1]!;
    const controllers = fields[2] ? fields[2].split(",") : [];
    const path = fields[3]!;
    if (
      !Number.isSafeInteger(Number(hierarchy)) ||
      memberships.has(hierarchy) ||
      (hierarchy === "0") !== (controllers.length === 0) ||
      controllers.some((controller) => !/^(?:name=)?[a-zA-Z0-9_.-]+$/.test(controller)) ||
      new Set(controllers).size !== controllers.length ||
      !isCgroupPath(path)
    ) {
      return undefined;
    }
    memberships.set(hierarchy, { controllers, path });
  }
  const named = [...memberships].filter(([, entry]) => entry.controllers.includes("name=systemd"));
  const selected = named.length
    ? named
    : [...memberships].filter(([hierarchy]) => hierarchy === "0");
  if (selected.length > 1) {
    return undefined;
  }
  return selected[0]
    ? { hierarchy: selected[0][0], path: selected[0][1].path }
    : { hierarchy: null, atRoot: [...memberships.values()].every((entry) => entry.path === "/") };
}

/** One process against an observed systemd cgroup, including a stopped service. */
export function inspectSystemdProcessMembershipSync(
  pid: number,
  controlGroup: string,
): "inside" | "outside" | "unknown" {
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !isCgroupPath(controlGroup) ||
    controlGroup === "/"
  ) {
    return "unknown";
  }
  try {
    const membership = readSystemdMembership(pid);
    return !membership || membership.hierarchy === null
      ? "unknown"
      : isWithinControlGroup(membership.path, controlGroup)
        ? "inside"
        : "outside";
  } catch {
    return "unknown";
  }
}

/** Native containment survives parent exit; environment markers never establish it. */
export function inspectServiceProcessMembershipSync(
  gatewayPid: number,
  platform: NodeJS.Platform = process.platform,
  systemdControlGroup?: string,
): ServiceProcessMembership {
  if (!Number.isSafeInteger(gatewayPid) || gatewayPid <= 0) {
    return "unknown";
  }
  try {
    if (platform === "darwin") {
      return inspectLaunchdMembership(gatewayPid);
    }
    if (platform === "linux") {
      if (typeof systemdControlGroup === "string" && !isCgroupPath(systemdControlGroup)) {
        return "unknown";
      }
      const caller = readSystemdMembership(process.pid);
      const gateway = readSystemdMembership(gatewayPid);
      if (!caller || !gateway || caller.hierarchy !== gateway.hierarchy) {
        return "unknown";
      }
      if (systemdControlGroup === undefined || systemdControlGroup === "/") {
        if (!(gateway.hierarchy === null ? gateway.atRoot : gateway.path === "/")) {
          return "unknown";
        }
        // Process-group supervisors can still kill reparented children without a service cgroup.
        const callerGroup = readLinuxProcessGroupId(process.pid);
        const gatewayGroup = readLinuxProcessGroupId(gatewayPid);
        return callerGroup === undefined || gatewayGroup === undefined
          ? "unknown"
          : callerGroup === gatewayGroup
            ? "inside"
            : "absent";
      }
      return caller.hierarchy === null ||
        gateway.hierarchy === null ||
        !isWithinControlGroup(gateway.path, systemdControlGroup)
        ? "unknown"
        : isWithinControlGroup(caller.path, systemdControlGroup)
          ? "inside"
          : "outside";
    }
  } catch {
    // An unreadable native observation cannot prove the caller escaped the service.
  }
  return "unknown";
}
