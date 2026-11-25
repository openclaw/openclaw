import fs from "node:fs/promises";
import path from "node:path";
import { summarizeGatewayServiceLayout } from "../../daemon/service-layout.js";
import { resolveManagedGatewayServiceCommand } from "../../daemon/service-types.js";
import { hasErrnoCode } from "../../infra/errno.js";
import {
  isGitReleaseForwardingPackage,
  resolveGitReleasePrefix,
} from "../../infra/git-release-paths.js";
import { readPackageReleaseSlotSync } from "../../infra/package-release-slot-path.js";
import { restoreInterruptedNpmPackageRootLink } from "../../infra/package-update-npm-root.js";
import { pathEntryExists, realpathOrResolve } from "../../infra/path-existence.js";
import { isPathStrictlyInside } from "../../infra/path-guards.js";
import {
  UPDATE_DESTINATION_RECOVERY,
  type UpdateDestinationFailure,
} from "../../infra/update-failure-facts-format.js";
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
  options: { dryRun?: boolean } = {},
) {
  const dryRun = options.dryRun === true;
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
    // An update killed while replacing this checkout's npm link left the path empty.
    const interruptedLink = (await pathEntryExists(packageRoot))
      ? undefined
      : await restoreInterruptedNpmPackageRootLink(
          destinationLayout.globalRoot,
          packageRoot,
          root,
          dryRun,
        );
    if (interruptedLink && dryRun) {
      // A dry run moves nothing; the real run inspects the launcher once the link is back.
      return { kind: "owned" as const, interruptedLink };
    }
    const { launcher, launcherTarget } = await inspectNpmLauncher(destinationLayout);
    destination.launcher = launcher;
    destination.launcherTarget = launcherTarget;
    const packagePresent = await pathEntryExists(packageRoot);
    const launcherPresent = await pathEntryExists(launcher);
    if (!packagePresent && !launcherPresent) {
      return { kind: "empty" as const };
    }
    const packageRootReal = packagePresent ? await fs.realpath(packageRoot) : null;
    if (launcherPresent && !launcherTarget) {
      return unknown(prefix, "unreadable-layout");
    }
    const serviceInspection = isGatewayServiceManagementAllowedForUpdate(process.env)
      ? await readManagedGatewayServiceForUpdate(process.env)
      : null;
    const command = serviceInspection?.command ?? null;
    // A Git release install leaves the package forwarding to its launcher (exact text only).
    const forwardsToThisInstall =
      packageRootReal !== null &&
      isGitReleaseForwardingPackage(packageRootReal, resolveGitReleasePrefix());
    const ownsPackage =
      packageRootReal !== null &&
      (forwardsToThisInstall ||
        (await realpathOrResolve(root)) === packageRootReal ||
        (await gatewayServiceCommandUsesRoot({ root: packageRootReal, command })) === true);
    const ownsLauncher =
      !launcherPresent ||
      (packageRootReal !== null &&
        launcherTarget !== null &&
        isPathStrictlyInside(packageRootReal, launcherTarget));
    // A service started by a release's real path would keep running that release after
    // the link moves; published updaters write such paths when run through the link.
    // Replace that release in place, as they do. The restart's service refresh then
    // installs the service from the package path, and the next update switches releases.
    const releaseSlot =
      ownsPackage && ownsLauncher ? readPackageReleaseSlotSync(packageRoot) : null;
    const releaseLayout = releaseSlot ? await summarizeGatewayServiceLayout(command) : undefined;
    if (
      releaseSlot &&
      releaseLayout?.entrypoint &&
      isPathStrictlyInside(releaseSlot.releaseRoot, path.resolve(releaseLayout.entrypoint))
    ) {
      const rebind = formatCliCommand("openclaw gateway install --force").replace(
        /^openclaw\b/,
        () => `node ${quote(path.join(packageRoot, "openclaw.mjs"))}`,
      );
      return {
        kind: "owned" as const,
        interruptedLink,
        releaseBoundService: {
          releaseRoot: releaseSlot.releaseRoot,
          installTarget: {
            ...installTarget,
            globalRoot: path.dirname(releaseSlot.releaseRoot),
            packageRoot: releaseSlot.releaseRoot,
          },
          warning: `The Gateway service starts ${releaseLayout.entrypoint}, inside the release ${releaseSlot.releaseRoot}, so this update replaces that release in place. If the restart does not bind the service to the package path ${packageRoot}, run \`${rebind}\`; the next update then switches releases.`,
        },
      };
    }
    if (ownsPackage && ownsLauncher) {
      return { kind: "owned" as const, interruptedLink };
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

/**
 * A pnpm or Bun global entry that links to this Git checkout is the checkout's own
 * `openclaw` command. This updater cannot switch it to the package: replacing the entry
 * changes what every later service ownership check names, so revalidation, rollback and
 * recovery refuse and leave the Gateway stopped, and current pnpm launchers staged for the
 * replacement still point into the removed stage. Refuse before anything changes.
 */
export async function inspectCheckoutLinkPackageSwitch(params: {
  checkoutRoot: string;
  installTarget: ResolvedGlobalInstallTarget;
  serviceRunsCheckout: boolean;
  targetSpec: string;
  storedChannel: string | null;
  requestedChannel: string;
}) {
  const { manager, packageRoot } = params.installTarget;
  if (manager === "npm" || !packageRoot) {
    return null;
  }
  if (!(await fs.lstat(packageRoot).catch(() => null))?.isSymbolicLink()) {
    return null;
  }
  const [linked, checkout] = await Promise.all([
    realpathOrResolve(packageRoot),
    realpathOrResolve(params.checkoutRoot),
  ]);
  if (linked !== checkout) {
    return null;
  }
  const running = params.serviceRunsCheckout
    ? "the CLI and Gateway still run"
    : "the CLI still runs";
  // No manual install recipe: it would bypass the updater's schema, runtime and service
  // definition checks. The agent route can inspect this instance before switching.
  const followChannel =
    params.storedChannel === params.requestedChannel
      ? [formatCliCommand("openclaw update")]
      : [
          formatCliCommand(`openclaw config set update.channel ${params.requestedChannel}`),
          formatCliCommand("openclaw update"),
        ];
  const message = [
    `Switch to ${params.targetSpec} not started: \`openclaw\` is a ${manager} global link to this Git checkout (${packageRoot} -> ${checkout})${params.serviceRunsCheckout ? " and the managed Gateway runs from that checkout" : ""}.`,
    `This updater cannot replace that link in a way it can verify and roll back, so nothing was stopped or changed; ${running} the checkout.`,
    `To keep this checkout and follow the ${params.requestedChannel} channel through its release tags, run ${followChannel.map((command) => `\`${command}\``).join(", then ")}.`,
    `To switch to the package anyway, run \`${formatCliCommand("openclaw triage")}\` or ask this instance's agent; it can check database, runtime and Gateway service compatibility before moving the install.`,
  ].join(" ");
  return {
    reason: "unsupported-package-target",
    message,
    failureFacts: [
      createUpdateFailureFact({
        check: "installation-inspection",
        code: "unsupported-package-target",
        message,
      }),
    ],
    recoverySteps: followChannel.map((command) => ({ kind: "continue-update" as const, command })),
  };
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
