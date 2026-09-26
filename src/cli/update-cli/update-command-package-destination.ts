import fs from "node:fs/promises";
import path from "node:path";
import { summarizeGatewayServiceLayout } from "../../daemon/service-layout.js";
import { resolveManagedGatewayServiceCommand } from "../../daemon/service-types.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { resolveCanonicalPath } from "../../infra/package-update-manager-preflight.js";
import { isPathStrictlyInside } from "../../infra/path-guards.js";
import {
  UPDATE_DESTINATION_RECOVERY,
  type UpdateDestinationFailure,
} from "../../infra/update-destination-failure.js";
import { createUpdateFailureFact } from "../../infra/update-failure-facts.js";
import type { ResolvedGlobalInstallTarget } from "../../infra/update-global.js";
import {
  inspectNpmLauncher,
  resolveNpmGlobalPrefixLayoutFromGlobalRoot,
} from "../../infra/update-npm-prefix.js";
import { UPDATE_FOREIGN_DESTINATION_REASON } from "../../shared/update-outcome.js";
import { formatCliCommand } from "../command-format.js";
import { quoteCliArg, quotePowerShellArg } from "../quote-cli-arg.js";
import {
  gatewayServiceCommandUsesRoot,
  isGatewayServiceManagementAllowedForUpdate,
  readManagedGatewayServiceForUpdate,
} from "./update-command-service-plan.js";

/** Inspect the same destination the package transaction will write after a Node switch. */
export async function inspectNpmGlobalDestination(
  root: string,
  installTarget: ResolvedGlobalInstallTarget,
) {
  const destination: Omit<UpdateDestinationFailure, "ownership" | "cause"> = {
    destinationKind: "unknown",
    prefix: null,
    packageRoot: null,
    runningRoot: path.resolve(root),
    runningPrefix: resolveNpmGlobalPrefixLayoutFromGlobalRoot(path.dirname(root))?.prefix ?? null,
    launcher: null,
    launcherTarget: null,
  };
  const quote = process.platform === "win32" ? quotePowerShellArg : quoteCliArg;
  const retry = formatCliCommand("openclaw update").replace(
    /^openclaw\b/,
    () => `node ${quote(path.resolve(root, "openclaw.mjs"))}`,
  );
  const unknown = (prefix: string | null, cause: "permission" | "unreadable-layout") => ({
    kind: "unknown" as const,
    cause,
    prefix,
    ...destinationRefusal(
      `Selected npm destination ${prefix ?? "(unresolved installation layout)"} could not be inspected (${cause}); ownership is unknown. No installation was attempted. Fix inspection permissions on this prefix for the service account, or restore the selected package layout, then run \`${retry}\`. Alternatively, ask the deployment owner to verify the layout and explicitly select the intended installation using its existing deployment procedure.`,
      { ...destination, ownership: "unknown", cause },
    ),
  });
  let prefix: string | null = null;
  try {
    const destinationLayout = resolveNpmGlobalPrefixLayoutFromGlobalRoot(installTarget.globalRoot, {
      allowDirectNodeModulesRoot: installTarget.directNodeModulesRoot === true,
    });
    const packageRoot = installTarget.packageRoot;
    if (!destinationLayout || !packageRoot) {
      return unknown(prefix, "unreadable-layout");
    }
    prefix = destinationLayout.prefix;
    destination.destinationKind = "npm-global";
    destination.prefix = prefix;
    destination.packageRoot = packageRoot;
    const { launcher, launcherTarget } = await inspectNpmLauncher(destinationLayout);
    destination.launcher = launcher;
    destination.launcherTarget = launcherTarget;
    const present = (target: string) =>
      fs.lstat(target).then(
        () => true,
        (error: unknown) => {
          if (hasErrnoCode(error, "ENOENT")) {
            return false;
          }
          throw error;
        },
      );
    const packagePresent = await present(packageRoot);
    const launcherPresent = await present(launcher);
    if (!packagePresent && !launcherPresent) {
      return { kind: "empty" as const, prefix };
    }
    const packageRootReal = packagePresent ? await fs.realpath(packageRoot) : null;
    if (launcherPresent && !launcherTarget) {
      return unknown(prefix, "unreadable-layout");
    }
    const manageable = isGatewayServiceManagementAllowedForUpdate(process.env);
    const serviceInspection = manageable
      ? await readManagedGatewayServiceForUpdate(process.env)
      : null;
    const command = serviceInspection?.command ?? null;
    const ownsPackage =
      packageRootReal !== null &&
      ((await resolveCanonicalPath(root)) === packageRootReal ||
        (await gatewayServiceCommandUsesRoot({ root: packageRootReal, command })) === true);
    const ownsLauncher =
      !launcherPresent ||
      (packageRootReal !== null &&
        launcherTarget !== null &&
        isPathStrictlyInside(packageRootReal, launcherTarget));
    if (ownsPackage && ownsLauncher) {
      return { kind: "owned" as const, prefix };
    }
    const layout = await summarizeGatewayServiceLayout(command);
    const wrapper = [
      process.env,
      command?.environment,
      resolveManagedGatewayServiceCommand(command)?.environment,
    ].some((env) => env?.OPENCLAW_WRAPPER?.trim());
    const select =
      serviceInspection?.verdict.refreshDefinition && !wrapper && ownsLauncher && launcherTarget
        ? formatCliCommand(
            `openclaw gateway install --force --runtime-path ${quote(process.execPath)}`,
          ).replace(/^openclaw\b/, () => `node ${quote(launcherTarget)}`)
        : undefined;
    const message = [
      `Selected npm destination ${prefix} is occupied by another OpenClaw installation: package ${packageRoot}; launcher ${launcher}${launcherTarget ? ` -> ${launcherTarget}` : " (target unresolved)"}.`,
      layout?.entrypoint
        ? `The selected service${layout.sourcePath ? ` (${layout.sourcePath})` : ""} uses ${layout.entrypoint}; it does not own this destination.`
        : "No selected managed service could be verified as owning this destination.",
      `No installation was attempted. Switch the runtime back and run \`${retry}\`.`,
      select
        ? `Alternatively, if the destination's owner agrees to use it for this service, explicitly select it with \`${select}\` and rerun the update. This changes the service binding; it does not grant ownership of another deployment's package.`
        : "Alternatively, ask the destination's deployment owner to resolve its package/launcher and select it for the intended service using their deployment procedure. Do not overwrite it.",
    ].join(" ");
    return {
      kind: "foreign" as const,
      prefix,
      ...destinationRefusal(message, {
        ...destination,
        ownership: "foreign",
        cause: ownsPackage ? "launcher-mismatch" : "package-mismatch",
      }),
    };
  } catch (error) {
    return unknown(
      prefix,
      hasErrnoCode(error, "EACCES") || hasErrnoCode(error, "EPERM")
        ? "permission"
        : "unreadable-layout",
    );
  }
}

function destinationRefusal(detail: string, destination: UpdateDestinationFailure) {
  const message = `Next step: ${UPDATE_DESTINATION_RECOVERY} ${detail}`;
  return {
    reason: UPDATE_FOREIGN_DESTINATION_REASON,
    message,
    failureFacts: [
      createUpdateFailureFact({
        check: "package-install",
        code: UPDATE_FOREIGN_DESTINATION_REASON,
        message,
        destination,
      }),
    ],
  };
}
