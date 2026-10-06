import fs from "node:fs/promises";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { parseKeyValueOutput } from "../daemon/runtime-parse.js";
import { execSystemctl, execSystemctlUser } from "../daemon/systemd-exec.js";
import {
  parseSystemdTimeSpanMs,
  SYSTEMD_DEFAULT_STOP_TIMEOUT_MS,
} from "../daemon/systemd-time-span.js";
import { formatErrorMessage } from "./errors.js";
import { normalizeSystemdUnit } from "./restart.js";
import { detectRespawnSupervisor } from "./supervisor-markers.js";

export type SystemdStopTimeout = { timeoutMs: number; source: string; warning?: string };

/** Read only the running unit, never a same-named unit in the other manager. */
export async function readSystemdStopTimeout(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SystemdStopTimeout | null> {
  const membership = await fs.readFile("/proc/self/cgroup", "utf8").catch(() => "");
  const memberships = membership.split("\n");
  // On hybrid/legacy hosts, resource controllers can stop at the user manager.
  // Only the systemd hierarchy identifies the Gateway's own service.
  const systemdMembership =
    memberships.find((line) => line.split(":")[1]?.split(",").includes("name=systemd")) ??
    memberships.find((line) => line.startsWith("0::"));
  const servicePath = systemdMembership?.slice(
    systemdMembership.indexOf(":", systemdMembership.indexOf(":") + 1) + 1,
  );
  const leafUnit = servicePath?.split("/").findLast((part) => /\.(service|scope)$/u.test(part));
  const cgroupUnit = leafUnit?.endsWith(".service") ? leafUnit : undefined;
  if (
    !cgroupUnit &&
    detectRespawnSupervisor(env, "linux", { includeLinuxOpenClawGatewayServiceMarker: true }) !==
      "systemd"
  ) {
    return null;
  }
  const unit = normalizeSystemdUnit(cgroupUnit ?? env.OPENCLAW_SYSTEMD_UNIT, env.OPENCLAW_PROFILE);
  const scope =
    cgroupUnit && servicePath
      ? /\/user@\d+\.service\//u.test(servicePath)
        ? "user"
        : "system"
      : undefined;
  const scopes = scope ? [scope] : ["user", "system"];
  const failures: string[] = [];
  for (const candidate of scopes) {
    const failed = (reason: string) => failures.push(`${candidate} manager ${unit}: ${reason}`);
    const args = [
      "show",
      unit,
      "--no-page",
      "--property",
      "TimeoutStopUSec,InvocationID,LoadState",
    ];
    const result = await (
      candidate === "user" ? execSystemctlUser(env, args, 2_000) : execSystemctl(args, env, 2_000)
    ).catch((error: unknown) => {
      failed(`systemctl show threw: ${formatErrorMessage(error)}`);
      return undefined;
    });
    if (!result) {
      continue;
    }
    if (result.code !== 0) {
      failed(`systemctl show exited ${result.code}: ${formatErrorMessage(result.stderr)}`);
      continue;
    }
    const properties = parseKeyValueOutput(result.stdout, "=");
    if (properties.loadstate !== "loaded") {
      failed(`LoadState=${properties.loadstate || "missing"}`);
      continue;
    }
    if (env.INVOCATION_ID && properties.invocationid !== env.INVOCATION_ID) {
      failed("InvocationID does not match the running process");
      continue;
    }
    const timeoutMs = parseSystemdTimeSpanMs(properties.timeoutstopusec ?? "");
    if (timeoutMs !== undefined) {
      return {
        timeoutMs: timeoutMs === 0 ? Infinity : timeoutMs,
        source: `systemd ${candidate} ${unit} TimeoutStopUSec`,
      };
    }
    failed("TimeoutStopUSec is missing or invalid");
  }
  return {
    timeoutMs: SYSTEMD_DEFAULT_STOP_TIMEOUT_MS,
    source: `systemd ${unit} timeout unavailable; default TimeoutStopUSec`,
    warning: `Unable to read systemd stop timeout; ${failures.map((failure) => truncateUtf16Safe(failure.replaceAll(/\s+/g, " "), 500)).join("; ")}; using ${SYSTEMD_DEFAULT_STOP_TIMEOUT_MS}ms default. Check the running unit with systemctl show.`,
  };
}
