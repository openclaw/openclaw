import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { normalizeSubmittedConfigModelRefs } from "../../config/model-input-normalization.js";
import type { ConfigValidationIssue, OpenClawConfig } from "../../config/types.openclaw.js";
import {
  validateConfigObjectRawWithPlugins,
  validateConfigObjectWithPlugins,
} from "../../config/validation.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import type { RespondFn } from "./types.js";

// Keep the transport message useful but bounded; the complete issue list remains in details.issues.
const MAX_CONFIG_ISSUES_IN_ERROR_SUMMARY = 3;

export function summarizeConfigValidationIssues(
  issues: ReadonlyArray<ConfigValidationIssue>,
): string {
  const trimmed = issues.slice(0, MAX_CONFIG_ISSUES_IN_ERROR_SUMMARY);
  const lines = normalizeStringEntries(
    formatConfigIssueLines(trimmed, "", { normalizeRoot: true }),
  );
  if (lines.length === 0) {
    return "invalid config";
  }
  const hiddenCount = Math.max(0, issues.length - lines.length);
  return `invalid config: ${lines.join("; ")}${
    hiddenCount > 0 ? ` (+${hiddenCount} more issue${hiddenCount === 1 ? "" : "s"})` : ""
  }`;
}

export function validateSubmittedConfigOrRespond(params: {
  candidate: unknown;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  respond: RespondFn;
}): { validationCandidate: OpenClawConfig; config: OpenClawConfig } | null {
  // SAFETY: normalization is shape-preserving; the raw validator below remains authoritative.
  const normalizationCandidate = params.candidate as OpenClawConfig;
  const validationCandidate = normalizeSubmittedConfigModelRefs(
    normalizationCandidate,
    params.pluginMetadataSnapshot?.owners.modelIdNormalizationPolicies,
  );
  const respondInvalid = (issues: ReadonlyArray<ConfigValidationIssue>) => {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, summarizeConfigValidationIssues(issues), {
        details: { issues },
      }),
    );
  };
  const validationParams = { pluginMetadataSnapshot: params.pluginMetadataSnapshot };
  const sourceValidated = validateConfigObjectRawWithPlugins(validationCandidate, validationParams);
  if (!sourceValidated.ok) {
    respondInvalid(sourceValidated.issues);
    return null;
  }
  const validated = validateConfigObjectWithPlugins(validationCandidate, validationParams);
  if (!validated.ok) {
    respondInvalid(validated.issues);
    return null;
  }
  return { validationCandidate, config: validated.config };
}
