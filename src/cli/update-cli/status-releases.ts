import path from "node:path";
import { resolveGatewayPort } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isImplicitLocalGatewayTarget } from "../../gateway/call.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { compareSemverStrings } from "../../infra/npm-registry-spec.js";
import { listPackageReleases } from "../../infra/package-release-retention.js";
import { readPackageReleaseIdentity } from "../../infra/package-release-slot.js";
import { readPackageActivationReceipt } from "../../infra/package-update-activation.js";
import type { UpdateCheckResult } from "../../infra/update-check.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { readTrial, resolvePrefix } from "../../update/store.js";
import { VERSION } from "../../version.js";
import { formatCliCommand } from "../command-format.js";
import { confirmGatewayReachable } from "../daemon-cli/restart-health-probe.js";

/** Read-only projection of resident and legacy package-release facts for update status. */
export async function inspectUpdateReleaseStatus({
  root,
  config,
  update,
  inspect,
  remainingMs,
  safeMessage,
}: {
  root: string | null;
  config: OpenClawConfig;
  update: UpdateCheckResult;
  inspect: <T>(section: string, operation: () => T | Promise<T>, fallback: T) => Promise<T>;
  remainingMs: () => number;
  safeMessage: (message: string) => string;
}) {
  let packageActivation;
  let packageActivationError: string | undefined;
  try {
    if (root) {
      packageActivation = readPackageActivationReceipt(resolveUpdateInstallRoot(root));
    }
  } catch (error) {
    packageActivationError = safeMessage(formatErrorMessage(error));
  }
  const packageReleases = root
    ? await inspect("package releases", () => listPackageReleases(root), [])
    : [];

  // The selected state slot is independent of the package that invoked this command.
  const selectedRelease = await inspect(
    "resident release",
    () =>
      readPackageReleaseIdentity(path.join(resolvePrefix(), "openclaw")).catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      }),
    undefined,
  );
  const releaseStatus = selectedRelease
    ? await inspect(
        "resident status",
        async () => {
          const localGateway = await isImplicitLocalGatewayTarget({ config });
          const [cliIdentity, trial, gateway] = await Promise.all([
            root
              ? inspect("CLI identity", () => readPackageReleaseIdentity(root), undefined)
              : undefined,
            inspect("release trial", readTrial, null),
            !localGateway
              ? Promise.resolve({ kind: "unavailable" as const })
              : confirmGatewayReachable({
                  port: resolveGatewayPort(config),
                  timeoutMs: remainingMs(),
                }).then(({ gatewayVersion: version, gatewayBuildId: buildId }) =>
                  version
                    ? { kind: "responding" as const, version, ...(buildId ? { buildId } : {}) }
                    : { kind: "unavailable" as const },
                ),
          ]);
          const cli = {
            version: VERSION,
            build: cliIdentity?.build ?? null,
            source: update.packageManager,
            path: root,
          };
          const comparison = selectedRelease.version
            ? compareSemverStrings(cli.version, selectedRelease.version)
            : null;
          const split =
            comparison !== 0 ||
            !cli.build ||
            !selectedRelease.build ||
            cli.build !== selectedRelease.build;
          const command = formatCliCommand(
            comparison !== null && comparison < 0
              ? `openclaw update --tag ${cli.version}`
              : "openclaw update",
          );
          const notice = split
            ? comparison !== null && comparison < 0
              ? `The selected resident release is newer than this CLI. It was not downgraded. To use ${cli.version}, run: ${command}`
              : comparison !== null && comparison > 0
                ? `${cli.version} is installed but is not selected by the resident launcher. Run: ${command}`
                : `CLI and selected release builds differ or could not be verified. Run: ${command}`
            : gateway.kind !== "responding"
              ? "Gateway version is not verified; registry freshness describes the CLI only."
              : gateway.version !== selectedRelease.version ||
                  !gateway.buildId ||
                  gateway.buildId !== selectedRelease.build
                ? `Running Gateway and selected release differ or their builds could not be verified. Run: ${command}`
                : undefined;
          return {
            cli,
            registryScope: "cli",
            selectedRelease,
            trial,
            gateway,
            gatewayScope: localGateway ? "local" : "remote",
            split,
            notice,
          };
        },
        undefined,
      )
    : undefined;
  const releaseRows = [
    ...(releaseStatus
      ? [
          {
            Item: "CLI",
            Value: `${releaseStatus.cli.version} · build ${releaseStatus.cli.build ?? "unknown"} · ${releaseStatus.cli.source}`,
          },
          {
            Item: "Active release",
            Value: `${releaseStatus.selectedRelease.version ?? "unknown"} · build ${releaseStatus.selectedRelease.build ?? "unknown"} · resident launcher (selected)`,
          },
          {
            Item: "Gateway",
            Value:
              releaseStatus.gateway.kind === "responding"
                ? `${releaseStatus.gateway.version} · build ${releaseStatus.gateway.buildId ?? "unknown"} (observed running)`
                : `not verified (${releaseStatus.gatewayScope})`,
          },
          ...(releaseStatus.trial
            ? [
                {
                  Item: "Release trial",
                  Value: `${releaseStatus.trial.version} · build ${releaseStatus.trial.buildId ?? "unknown"} · ${releaseStatus.trial.phase}${releaseStatus.trial.phase === "pending" ? " · starts on the next Gateway start; running Gateway unchanged" : ""}${releaseStatus.trial.outcome ? " (historical outcome)" : ""}${releaseStatus.trial.outcome?.reason ? ` · ${releaseStatus.trial.outcome.reason}` : ""}`,
                },
              ]
            : []),
        ]
      : []),
    ...(packageActivation
      ? [
          {
            Item: "Package recovery",
            Value: `${packageActivation.phase} (${packageActivation.operationId})`,
          },
        ]
      : []),
    ...(packageActivation?.recoveryCommand
      ? [{ Item: "Recovery command (external Node)", Value: packageActivation.recoveryCommand }]
      : []),
    ...(packageActivationError
      ? [{ Item: "Package recovery", Value: packageActivationError }]
      : []),
    ...packageReleases.map((release) => ({
      Item: release.selected ? "Active release" : "Retained release",
      Value: `${release.id} · version ${release.version ?? "unknown"} · build ${release.build ?? "unknown"}${release.leased ? " · in use" : ""}`,
    })),
  ];
  return { releaseStatus, packageActivation, packageActivationError, packageReleases, releaseRows };
}
