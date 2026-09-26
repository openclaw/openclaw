import { isConfigReadFailure } from "../../config/io.invalid-config.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { normalizeSupportDiagnosticErrorCode } from "../../logging/diagnostic-support-redaction.js";
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
  const issues = snapshot.issues.map(({ path, pathSegments }) => ({
    path,
    pathSegments,
    message: "Invalid configuration field",
  }));
  const nextAction =
    "Run `openclaw doctor --fix` to repair retired or unrecognized configuration fields, then correct any remaining errors before retrying.";
  return new UpdatePreMutationError(
    "invalid-config",
    [
      `Update refused: configuration is invalid at ${snapshot.path}.`,
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
