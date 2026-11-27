import { findRetiredConfigUpgradeRequirement } from "../../commands/doctor/shared/retired-config-formats.js";
import { isConfigReadFailure } from "../../config/io.invalid-config.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { collectNestedErrorCandidates } from "../../infra/error-graph-internal.js";
import { GatewayLockNamespaceError } from "../../infra/gateway-lock-payload.js";
import { GatewayStateOwnerContentionError } from "../../infra/gateway-state-owner-errors.js";
import { DoctorMaintenanceRefusalError } from "../../infra/update-doctor-result.js";
import type { UpdateFailureFact } from "../../infra/update-failure-facts.js";
import { UpdatePreMutationError } from "../../infra/update-pre-mutation-error.js";
import {
  normalizeSupportDiagnosticErrorCode,
  publicConfigIssueMessage,
} from "../../logging/diagnostic-support-redaction.js";
import { formatConcreteConfigPath } from "../../shared/dot-path.js";

/** Display facts do not replace the typed cause used by cleanup and recovery. */
export function resolveUpdateOwnershipFailure(
  cause: unknown,
): { message: string; nextAction: string; failureFacts: UpdateFailureFact[] } | undefined {
  const causes = collectNestedErrorCandidates(cause);
  const ownershipUnverified = causes.some((error) => error instanceof GatewayLockNamespaceError);
  const maintenanceBusy = causes.some(
    (error) =>
      error instanceof GatewayStateOwnerContentionError ||
      (error instanceof DoctorMaintenanceRefusalError &&
        error.refusal.kind === "deferred" &&
        (error.refusal.reason === "coordinator-contention" ||
          error.refusal.reason === "agent-database-in-use")),
  );
  if (!ownershipUnverified && !maintenanceBusy) {
    return undefined;
  }
  const message = ownershipUnverified
    ? "Gateway ownership could not be verified."
    : "Gateway maintenance is busy.";
  const nextAction = ownershipUnverified
    ? "Stop the recorded Gateway through its service manager or container, then retry."
    : "Wait for the active Gateway or maintenance operation to finish, or stop the Gateway through its service manager before retrying.";
  return {
    message: `Update refused: ${message} ${nextAction}`,
    nextAction,
    failureFacts: [
      {
        check: "config",
        code: ownershipUnverified ? "gateway-ownership-unverified" : "gateway-maintenance-busy",
        message,
      },
    ],
  };
}

/** Keep validation fields separate from diagnostics that can contain rejected secret values. */
export function createUpdateConfigFailure(
  snapshot: ConfigFileSnapshot,
  cause?: unknown,
): UpdatePreMutationError<"invalid-config" | "config-read-failed"> {
  if (isConfigReadFailure(snapshot)) {
    const ownership = resolveUpdateOwnershipFailure(cause);
    if (ownership) {
      return new UpdatePreMutationError("config-read-failed", ownership.message, ownership);
    }
    const code = normalizeSupportDiagnosticErrorCode(snapshot.readError?.code ?? undefined);
    const nextAction = snapshot.readError
      ? "Check configuration file access before retrying."
      : "Run `openclaw doctor --json` to inspect the configuration loading failure before retrying.";
    return new UpdatePreMutationError(
      "config-read-failed",
      `Update refused: configuration could not be read${code ? ` (${code})` : ""}. ${nextAction}`,
      {
        nextAction,
        failureFacts: [
          {
            check: "config",
            code: code ?? "config-read-failed",
            message: "Configuration could not be read.",
          },
        ],
      },
    );
  }
  const issues = snapshot.issues.map((issue) => ({
    path: issue.pathSegments?.length
      ? formatConcreteConfigPath(issue.pathSegments)
      : issue.path || "<root>",
    message: publicConfigIssueMessage(issue),
  }));
  const retired = findRetiredConfigUpgradeRequirement(
    snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig,
  );
  const includeOwnedLegacyRoster =
    snapshot.agentRosterIncludeOwned === true &&
    snapshot.legacyIssues.some(
      (issue) => issue.path === "agents.list" || issue.path === "agents.entries",
    );
  // Automatic legacy repair never rewrites included files, and the installed
  // version's Doctor does not know these fields are retired.
  const includedLegacy =
    (snapshot.includedPaths?.length ?? 0) > 0 && snapshot.legacyIssues.length > 0;
  const nextAction =
    retired?.nextAction ??
    (includeOwnedLegacyRoster
      ? "Doctor cannot safely rewrite this include-owned legacy roster. Back up the root config, included files, and persisted state, then temporarily consolidate the original legacy config into one openclaw.json. Preserve roster order, legacy markers, environment and secret references, and configured path meanings. Run `openclaw doctor --fix` or retry the update; after repair and `openclaw config validate` succeed, split the repaired config back into includes and validate again. See https://docs.openclaw.ai/gateway/doctor/config-migrations#agent-roster-migration."
      : includedLegacy
        ? `The update migrates ${snapshot.legacyIssues.map((issue) => issue.path).join(", ")} automatically only in a single-file config, and this config uses includes. Keep these settings as they are; do not remove them, because the installed version can then change behavior (a removed disabled heartbeat falls back to the default heartbeat). Back up the root config and included files, temporarily consolidate the included files into one openclaw.json, correct any other errors listed above, and retry the update. After it succeeds and \`openclaw config validate\` passes, split the config back into includes.`
        : "Run `openclaw doctor --fix` to repair retired or unrecognized configuration fields, then correct any remaining errors before retrying.");
  return new UpdatePreMutationError(
    "invalid-config",
    [
      retired
        ? "Update refused: configuration contains retired fields that current Doctor cannot migrate."
        : `Update refused: configuration is invalid at ${snapshot.path}.`,
      ...formatConfigIssueLines(issues, "-", { normalizeRoot: true }),
      nextAction,
    ].join("\n"),
    {
      nextAction,
      failureFacts: issues.length
        ? issues.map((issue) => ({
            check: "invalid-config",
            code: "invalid-config",
            affectedKey: issue.path || "<root>",
            message: issue.message,
          }))
        : [
            {
              check: "invalid-config",
              code: "invalid-config",
              message: "Invalid configuration field",
            },
          ],
    },
  );
}
