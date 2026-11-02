import path from "node:path";
import { isStringArray } from "@openclaw/normalization-core/record-coerce";
import { execFileUtf8 } from "./exec-file.js";
import type { SystemdBusQuery } from "./systemd-bus-query.js";

export async function readSystemdAccountHome(user: string): Promise<string | undefined> {
  try {
    const key = user || "0";
    const result = await execFileUtf8("/usr/bin/getent", ["passwd", key], { timeout: 1_000 });
    const fields = result.stdout.trim().split(":");
    const name = fields[0];
    const uid = fields[2];
    const home = fields[5];
    return result.code === 0 &&
      result.termination === "exit" &&
      fields.length === 7 &&
      (name === key || (/^\d+$/u.test(key) && uid === key)) &&
      home &&
      path.posix.isAbsolute(home)
      ? home
      : undefined;
  } catch {
    // NSS failures are uncertainty, never proof that the service has separate state.
    return undefined;
  }
}

/** Host paths cannot identify state when systemd supplies selectors or remaps storage. */
export async function canResolveSystemdStateFromHost(
  query: SystemdBusQuery,
  destination: string,
  unitPath: string,
): Promise<boolean> {
  try {
    const isolation = await query(
      [
        "get-property",
        destination,
        unitPath,
        "org.freedesktop.systemd1.Service",
        "PAMName",
        "RootDirectory",
        "RootImage",
        "BindPaths",
        "BindReadOnlyPaths",
        "TemporaryFileSystem",
        "MountImages",
        "ExtensionImages",
        "ExtensionDirectories",
        "PrivateTmp",
        "ProtectHome",
        "PassEnvironment",
      ],
      [
        "s",
        "s",
        "s",
        "a(ssbt)",
        "a(ssbt)",
        "a(ss)",
        "a(ssba(ss))",
        "a(sba(ss))",
        "as",
        "b",
        "s",
        "as",
      ],
    );
    const managerEnvironment = (
      await query(
        [
          "get-property",
          destination,
          "/org/freedesktop/systemd1",
          "org.freedesktop.systemd1.Manager",
          "Environment",
        ],
        ["as"],
      )
    )?.[0];
    const selectsState = (value: string) =>
      /^(?:HOME|USERPROFILE|OPENCLAW_(?:HOME|STATE_DIR|PROFILE|CONFIG_PATH))(?:=|$)/u.test(value);
    const passEnvironment = isolation?.[11];
    return (
      isolation?.length === 12 &&
      isolation.slice(0, 3).every((value) => value === "") &&
      isolation.slice(3, 9).every((value) => Array.isArray(value) && value.length === 0) &&
      isolation[9] === false &&
      (isolation[10] === "no" || isolation[10] === "read-only") &&
      isStringArray(passEnvironment) &&
      !passEnvironment.some(selectsState) &&
      isStringArray(managerEnvironment) &&
      !managerEnvironment.some(selectsState)
    );
  } catch {
    // Unsupported properties and denied inspection do not establish separate state.
    return false;
  }
}
