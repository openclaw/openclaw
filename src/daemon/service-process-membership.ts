import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import { resolveDiagnosticProcessEnv } from "../infra/process-env.js";
import { spawnPsSync } from "../infra/spawn-ps.js";
import { parseKeyValueOutput } from "./runtime-parse.js";

type ServiceProcessMembership = "inside" | "outside" | "unknown";
const PROBE_TIMEOUT_MS = 2_000;

function readResourceCoalition(pid: number): { id: number; name: string } | undefined {
  const result = spawnSync("/bin/launchctl", ["print", `pid/${pid}`], {
    encoding: "utf8",
    env: resolveDiagnosticProcessEnv(),
    timeout: PROBE_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return undefined;
  }
  const headers = result.stdout.match(/^\s*resource coalition\s*=/gm);
  const body = /^\s*resource coalition\s*=\s*\{([^{}]*)^\s*\}/m.exec(result.stdout)?.[1];
  if (headers?.length !== 1 || !body) {
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
  return !caller || !gateway
    ? "unknown"
    : caller.id === gateway.id || caller.name === gateway.name
      ? "inside"
      : "outside";
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

function readSystemdMembership(pid: number): { hierarchy: string; path: string } | undefined {
  const memberships = readFileSync(`/proc/${pid}/cgroup`, "utf8").split(/\r?\n/).filter(Boolean);
  const named = memberships.filter(
    (line) => /^[1-9]\d*:/.test(line) && line.split(":")[1]?.split(",").includes("name=systemd"),
  );
  const selected = named.length ? named : memberships.filter((line) => line.startsWith("0::"));
  if (selected.length !== 1) {
    return undefined;
  }
  const fields = selected[0]!.split(":");
  const hierarchy = fields[0]!;
  const path = fields.slice(2).join(":");
  return isCgroupPath(path) ? { hierarchy, path } : undefined;
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
      if (
        !systemdControlGroup ||
        systemdControlGroup === "/" ||
        !isCgroupPath(systemdControlGroup)
      ) {
        return "unknown";
      }
      const caller = readSystemdMembership(process.pid);
      const gateway = readSystemdMembership(gatewayPid);
      return !caller ||
        !gateway ||
        caller.hierarchy !== gateway.hierarchy ||
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
