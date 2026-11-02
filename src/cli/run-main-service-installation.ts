import fs from "node:fs/promises";
import path from "node:path";
import { mergeGatewayServiceEnv } from "../daemon/service-env-merge.js";
import {
  inspectGatewayServiceInstallationDrift,
  resolveServiceEntrypointIndex,
  summarizeGatewayServiceLayout,
} from "../daemon/service-layout.js";
import type { GatewayServiceCommandConfig } from "../daemon/service-types.js";
import { resolveGatewayService } from "../daemon/service.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { hasErrnoCode } from "../infra/errno.js";
import type { GatewayServiceInstallation } from "../infra/gateway-service-installation-context.js";
import { compareOpenClawReleaseVersions } from "../infra/npm-registry-spec.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { lstatIfExists, statIfExists } from "../infra/path-existence.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { VERSION } from "../version.js";
import { isGatewayRunInvocationArgv } from "./gateway-run-argv.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

/** Only definite absence permits climbing past a missing service database. */
async function resolveInspectedServiceDatabasePath(databasePath: string): Promise<string> {
  let current = databasePath;
  const suffix: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...suffix.toReversed());
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT") || (await lstatIfExists(current, "ENOENT"))) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

/** Resolve this Gateway's own manager, never a same-named unit in another scope. */
export async function readOwnGatewayServiceCommand(
  env: NodeJS.ProcessEnv,
): Promise<GatewayServiceCommandConfig | undefined> {
  if (process.platform !== "linux" || !isGatewayRunInvocationArgv(process.argv)) {
    return undefined;
  }
  try {
    const membership = await fs.readFile("/proc/self/cgroup", "utf8");
    const memberships = membership.split("\n");
    const systemdMembership =
      memberships.find((line) => line.split(":")[1]?.split(",").includes("name=systemd")) ??
      memberships.find((line) => line.startsWith("0::"));
    const servicePath = systemdMembership?.slice(
      systemdMembership.indexOf(":", systemdMembership.indexOf(":") + 1) + 1,
    );
    const unit = servicePath?.split("/").findLast((part) => /\.(service|scope)$/u.test(part));
    if (!unit?.endsWith(".service") || !servicePath) {
      return undefined;
    }
    const scope = /\/user@\d+\.service\//u.test(servicePath) ? "user" : "system";
    const [
      { resolveSystemdUnitPathForName, readSystemdServiceCommandLocation },
      { readSystemdServiceRuntime },
    ] = await Promise.all([
      import("../daemon/systemd-service-files.js"),
      import("../daemon/systemd-runtime.js"),
    ]);
    const target = {
      scope,
      unitName: unit,
      unitPath:
        scope === "system"
          ? "/etc/systemd/system/" + unit
          : resolveSystemdUnitPathForName(env, unit.slice(0, -".service".length)),
    } as const;
    // Identity only: do not read EnvironmentFile secrets or query enablement.
    const [location, runtime] = await Promise.all([
      readSystemdServiceCommandLocation(env, target),
      readSystemdServiceRuntime(env, {
        systemdReadTarget: target,
        requireEffective: true,
        requireLoaded: true,
        timeoutMs: 2_000,
      }),
    ]);
    // Cgroup membership alone is not authority: child CLIs can inherit it.
    // Both readers require native loaded facts for this explicit manager target.
    // DelegateSubgroup=gateway leaves the manager's ControlGroup at the unit root.
    return location.kind === "command" &&
      location.command.programArguments.length > 0 &&
      runtime.status === "running" &&
      runtime.state === "active" &&
      runtime.subState === "running" &&
      !runtime.inspectionFailure &&
      runtime.pid === process.pid &&
      runtime.systemd?.scope === scope &&
      runtime.systemd.unit === unit &&
      runtime.systemd.controlGroup === servicePath.replace(/\/gateway$/u, "")
      ? location.command
      : undefined;
  } catch {
    // Failed self-proof must retain the existing installed-service migration guard.
    return undefined;
  }
}

/** Unknown service installations retain normal CLI behavior; only proven older installs restrict migration. */
export async function inspectCliGatewayServiceInstallation(
  env: NodeJS.ProcessEnv,
): Promise<GatewayServiceInstallation | undefined> {
  try {
    const service = resolveGatewayService();
    const ownCommand = await readOwnGatewayServiceCommand(env);
    const command = ownCommand ?? (await service.readCommand(env, { inspectStateIdentity: true }));
    const root = await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url });
    const layout = await summarizeGatewayServiceLayout(command);
    const drift = root ? await inspectGatewayServiceInstallationDrift(layout, root) : undefined;
    if (
      !drift?.serviceVersion ||
      (compareOpenClawReleaseVersions(VERSION, drift.serviceVersion) ?? 0) <= 0
    ) {
      return undefined;
    }
    // A separate installed service does not inherit this CLI's state selectors.
    // A positively identified running Gateway uses its own live process environment.
    const serviceEnv = ownCommand
      ? env
      : mergeGatewayServiceEnv(
          {
            ...env,
            OPENCLAW_HOME: undefined,
            OPENCLAW_STATE_DIR: undefined,
            OPENCLAW_PROFILE: undefined,
            OPENCLAW_CONFIG_PATH: undefined,
          },
          command,
        );
    // The Windows service projection already applies command-line profiles.
    if (!ownCommand && command && process.platform !== "win32") {
      const entrypoint = resolveServiceEntrypointIndex(command.programArguments);
      if (entrypoint !== undefined) {
        const profile = parseCliProfileArgs([
          "node",
          ...command.programArguments.slice(entrypoint),
        ]);
        if (profile.ok && profile.profile) {
          applyCliProfileEnv({ profile: profile.profile, env: serviceEnv });
        }
      }
    }
    const callerDatabasePath = resolveIdentityPathViaExistingAncestorSync(
      resolveOpenClawStateSqlitePath(env),
    );
    let databasePath = callerDatabasePath;
    // Relative service selectors depend on its cwd, not this CLI's invocation base.
    const relativeServiceSelector = [
      "HOME",
      "USERPROFILE",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
    ].some((key) => {
      const value = command?.environment?.[key]?.trim();
      return value && !path.isAbsolute(value) && !/^~(?:$|[\\/])/u.test(value);
    });
    if (!command?.stateIdentityUnverified && !relativeServiceSelector) {
      try {
        const serviceDatabasePath = await resolveInspectedServiceDatabasePath(
          resolveOpenClawStateSqlitePath(serviceEnv),
        );
        const [callerDatabase, serviceDatabase] = await Promise.all([
          statIfExists(callerDatabasePath),
          statIfExists(serviceDatabasePath),
        ]);
        // Bind mounts and hard links can expose the same database under different paths.
        databasePath =
          callerDatabase &&
          serviceDatabase &&
          callerDatabase.dev === serviceDatabase.dev &&
          callerDatabase.ino === serviceDatabase.ino
            ? callerDatabasePath
            : serviceDatabasePath;
      } catch {
        // Keep the older-service restriction when its state identity cannot be inspected.
      }
    }
    return {
      root: drift.serviceRoot,
      version: drift.serviceVersion,
      cliVersion: VERSION,
      databasePath,
    };
  } catch {
    // Service inspection is best effort and must not make an uninspectable host unusable.
    return undefined;
  }
}
