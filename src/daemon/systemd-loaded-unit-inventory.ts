/** Read loaded service commands without loading units or reading their environment files. */
import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errno.js";
import { withServiceInspectionBudget } from "./service-inspection-budget.js";
import type { GatewayServiceEnv } from "./service-types.js";
import { execSystemctl, execSystemctlUser } from "./systemd-exec.js";

const INSPECTION_TIMEOUT_MS = 15_000;

export type LoadedSystemdUnit = {
  name: string;
  fragmentPath: string;
  execStart: string;
};

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function hasManager(scope: "user" | "system", env: GatewayServiceEnv): Promise<boolean> {
  if (scope === "system") {
    return Boolean(env.DBUS_SYSTEM_BUS_ADDRESS) || (await exists("/run/systemd/system"));
  }
  if (env.DBUS_SESSION_BUS_ADDRESS || env.SUDO_USER) {
    return true;
  }
  const runtimeDir = env.XDG_RUNTIME_DIR || `/run/user/${process.geteuid?.()}`;
  return (
    path.isAbsolute(runtimeDir) &&
    ((await exists(path.join(runtimeDir, "systemd/private"))) ||
      (await exists(path.join(runtimeDir, "bus"))))
  );
}

function parseUnitNames(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const name = line.trimStart().split(/\s+/, 1)[0];
    if (!name?.endsWith(".service")) {
      throw new Error("Loaded systemd service list could not be inspected.");
    }
    names.push(name);
  }
  return [...new Set(names)];
}

function parseLoadedUnits(output: string, requested: Set<string>): LoadedSystemdUnit[] {
  const units: LoadedSystemdUnit[] = [];
  const seen = new Set<string>();
  for (const block of output.trim().split(/\r?\n\r?\n/)) {
    if (!block) {
      continue;
    }
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf("=");
      if (separator <= 0) {
        throw new Error("Loaded systemd service properties could not be inspected.");
      }
      const key = line.slice(0, separator);
      const value = line.slice(separator + 1);
      if (fields.has(key) && key !== "ExecStart") {
        throw new Error("Loaded systemd service properties could not be inspected.");
      }
      fields.set(
        key,
        key === "ExecStart" && fields.has(key) ? `${fields.get(key)}; ${value}` : value,
      );
    }
    const name = fields.get("Id");
    const fragmentPath = fields.get("FragmentPath");
    const execStart = fields.get("ExecStart") ?? "";
    const state = fields.get("ActiveState");
    if (!name || !requested.has(name) || seen.has(name) || fragmentPath === undefined || !state) {
      throw new Error("Loaded systemd service properties could not be inspected.");
    }
    seen.add(name);
    if (["active", "activating", "reloading", "deactivating", "failed"].includes(state)) {
      units.push({ name, fragmentPath, execStart });
    }
  }
  if (seen.size !== requested.size) {
    throw new Error("Loaded systemd service inventory changed during inspection.");
  }
  return units;
}

export async function listLoadedSystemdUnits(
  scope: "user" | "system",
  env: GatewayServiceEnv,
): Promise<LoadedSystemdUnit[]> {
  if (!(await hasManager(scope, env))) {
    return [];
  }
  const run = (args: string[]) =>
    scope === "user"
      ? withServiceInspectionBudget(() => execSystemctlUser(env, args, INSPECTION_TIMEOUT_MS))
      : execSystemctl(["--system", ...args], undefined, INSPECTION_TIMEOUT_MS);
  const listed = await run([
    "list-units",
    "--all",
    "--type=service",
    "--state=active,activating,reloading,deactivating,failed",
    "--plain",
    "--no-legend",
    "--no-pager",
    "--full",
  ]);
  if (listed.termination !== "exit" || listed.code !== 0) {
    throw new Error("Loaded systemd service list could not be inspected.");
  }
  const names = parseUnitNames(listed.stdout);
  if (names.length === 0) {
    return [];
  }
  const shown = await run([
    "show",
    "--property=Id,FragmentPath,ExecStart,ActiveState",
    "--no-pager",
    "--",
    ...names,
  ]);
  if (shown.termination !== "exit" || shown.code !== 0) {
    throw new Error("Loaded systemd service properties could not be inspected.");
  }
  return parseLoadedUnits(shown.stdout, new Set(names));
}
