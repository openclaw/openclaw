import { findRetiredConfigUpgradeRequirement } from "../../commands/doctor/shared/retired-config-formats.js";
import { isConfigReadFailure } from "../../config/io.invalid-config.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import {
  normalizeSupportDiagnosticErrorCode,
  publicConfigIssueMessage,
} from "../../logging/diagnostic-support-redaction.js";
import { formatConcreteConfigPath } from "../../shared/dot-path.js";
import { UpdatePreMutationError } from "./shared.js";

/** Keep validation fields separate from diagnostics that can contain rejected secret values. */
export function createUpdateConfigFailure(
  snapshot: ConfigFileSnapshot,
): UpdatePreMutationError<"invalid-config" | "config-read-failed"> {
  if (isConfigReadFailure(snapshot)) {
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
  const nextAction =
    retired?.nextAction ??
    (includeOwnedLegacyRoster
      ? "Doctor cannot safely rewrite this include-owned legacy roster. Back up the root config, included files, and persisted state, then temporarily consolidate the original legacy config into one openclaw.json. Preserve roster order, legacy markers, environment and secret references, and configured path meanings. Run `openclaw doctor --fix` or retry the update; after repair and `openclaw config validate` succeed, split the repaired config back into includes and validate again. See https://docs.openclaw.ai/gateway/doctor/config-migrations#agent-roster-migration."
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
