import fs from "node:fs/promises";
import type { GatewayServiceEnv, GatewayServiceManagedOverrides } from "./service-types.js";
import {
  parseSystemdEnvironmentFileSpec,
  resolveSystemdEnvironmentFiles,
  type SystemdEnvironmentFileSpec,
} from "./systemd-environment-files.js";
import {
  parseSystemdEnvAssignments,
  splitSystemdEnvironmentWords,
  splitSystemdLogicalLines,
} from "./systemd-unit.js";

/** Which launcher and environment directives loaded drop-ins own over the managed base. */
export async function readSystemdDropInOverrides(
  dropInPaths: string[],
  managedUnsetEnvironment: string[],
  env: GatewayServiceEnv,
  effectiveFiles: SystemdEnvironmentFileSpec[],
): Promise<GatewayServiceManagedOverrides> {
  const inlineEnvironmentKeys = new Set<string>();
  const fileEnvironmentKeys = new Set<string>();
  const unsetEnvironmentKeys = new Set<string>();
  const overrides: GatewayServiceManagedOverrides = {};
  let resetInline = false;
  let resetFiles = false;
  for (const pathname of dropInPaths) {
    const content = await fs.readFile(pathname, "utf8");
    let inService = false;
    // Loaded drop-ins own directives even when their current values equal the managed base.
    for (const rawLine of splitSystemdLogicalLines(content)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) {
        continue;
      }
      if (line.startsWith("[")) {
        if (!line.endsWith("]")) {
          throw new Error("Invalid systemd drop-in section");
        }
        inService = line === "[Service]";
        continue;
      }
      if (!inService) {
        continue;
      }
      const separator = line.indexOf("=");
      if (separator < 0) {
        throw new Error("Invalid systemd drop-in directive");
      }
      const directive = line.slice(0, separator).trim();
      if (directive === "ExecStart" || directive === "WorkingDirectory") {
        overrides.launcher =
          directive === "ExecStart" ? "command" : (overrides.launcher ?? "working-directory");
      } else if (["Environment", "EnvironmentFile", "UnsetEnvironment"].includes(directive)) {
        const value = line.slice(separator + 1).trim();
        if (!value) {
          if (directive === "Environment") {
            inlineEnvironmentKeys.clear();
            resetInline = true;
          } else if (directive === "EnvironmentFile") {
            fileEnvironmentKeys.clear();
            resetFiles = true;
          } else {
            unsetEnvironmentKeys.clear();
            for (const assignment of managedUnsetEnvironment) {
              unsetEnvironmentKeys.add(assignment.split("=", 1)[0] ?? assignment);
            }
          }
        } else if (directive === "Environment") {
          const assignments = parseSystemdEnvAssignments(value);
          if (assignments.length !== splitSystemdEnvironmentWords(value).length) {
            throw new Error("Invalid systemd drop-in environment");
          }
          for (const { key } of assignments) {
            inlineEnvironmentKeys.add(key);
          }
        } else if (directive === "UnsetEnvironment") {
          for (const assignment of splitSystemdEnvironmentWords(value)) {
            const key = assignment.split("=", 1)[0];
            if (!key) {
              throw new Error("Invalid systemd drop-in environment removal");
            }
            unsetEnvironmentKeys.add(key);
          }
        } else {
          try {
            // Resolve the user runtime directory only when the manager confirms
            // that exact file. Other specifiers remain operator-owned/unknown.
            const runtimeDir = env.XDG_RUNTIME_DIR?.trim();
            const fileValue = runtimeDir
              ? value.replace(/%%|%t/gu, (token) => (token === "%t" ? runtimeDir : token))
              : value;
            if (fileValue.replace(/%%|%h/gu, "").includes("%")) {
              throw new Error("Unresolved systemd environment file specifier");
            }
            const spec = parseSystemdEnvironmentFileSpec(fileValue, env);
            if (
              fileValue !== value &&
              !effectiveFiles.some(
                ([filePath, optional]) => filePath === spec?.[0] && optional === spec?.[1],
              )
            ) {
              throw new Error("Systemd environment file differs from manager inspection");
            }
            const fileEnvironment = await resolveSystemdEnvironmentFiles({
              environmentFileSpecs: spec ? [spec] : [],
              failOnUnavailable: true,
            });
            for (const key of Object.keys(fileEnvironment)) {
              fileEnvironmentKeys.add(key);
            }
          } catch {
            overrides.environment = true;
          }
        }
      }
    }
  }
  if (overrides.environment !== true) {
    const ownedKeys = [
      ...new Set([...inlineEnvironmentKeys, ...fileEnvironmentKeys, ...unsetEnvironmentKeys]),
    ];
    if (ownedKeys.length > 0 || resetInline || resetFiles) {
      overrides.environment = {
        ...(ownedKeys.length > 0 ? { keys: ownedKeys } : {}),
        ...(resetInline ? { resetInline: true } : {}),
        ...(resetFiles ? { resetFiles: true } : {}),
      };
    }
  }
  // A known-empty set preserves the authored definition without mistaking native
  // defaults (such as a user service's home cwd) for operator-owned overrides.
  return overrides;
}
