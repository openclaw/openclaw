import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { z } from "zod";
import { unsupportedSecretRefSurfacePolicy } from "../secrets/unsupported-surface-policy.js";
import { appendAllowedValuesHint, summarizeAllowedValues } from "./allowed-values.js";
import type { ConfigValidationIssue } from "./types.js";
import { coerceSecretRef } from "./types.secrets.js";

type ConfigPathSegment = string | number;
const SECRETREF_POLICY_DOC_URL = "https://docs.openclaw.ai/reference/secretref-credential-surface";

function toConfigPathSegments(path: readonly PropertyKey[]): ConfigPathSegment[] {
  return path.filter((segment): segment is ConfigPathSegment => typeof segment !== "symbol");
}

export function withConfigIssuePath(
  issue: ConfigValidationIssue,
  pathSegments: readonly ConfigPathSegment[],
): ConfigValidationIssue {
  Object.defineProperty(issue, "pathSegments", {
    value: [...pathSegments],
    enumerable: false,
  });
  return issue;
}

function appendNumericBoundHint(message: string, record: z.core.$ZodIssue): string {
  if ((record.code !== "too_big" && record.code !== "too_small") || record.origin !== "number") {
    return message;
  }
  if (record.code === "too_big" && typeof record.maximum === "number") {
    return record.inclusive === true
      ? `${message} (maximum: ${record.maximum})`
      : `${message} (must be less than ${record.maximum})`;
  }
  if (record.code === "too_small" && typeof record.minimum === "number") {
    return record.inclusive === true
      ? `${message} (minimum: ${record.minimum})`
      : `${message} (must be greater than ${record.minimum})`;
  }
  return message;
}

/** Undefined means an open-ended branch prevents an exhaustive allowed-values hint. */
function collectAllowedValuesFromIssue(issue: z.core.$ZodIssue): unknown[] | undefined {
  if (issue.code === "invalid_value") {
    return issue.values;
  }
  if (issue.code === "invalid_type") {
    return issue.expected === "boolean" ? [true, false] : undefined;
  }
  if (issue.code !== "invalid_union") {
    return [];
  }
  if (issue.errors.length === 0) {
    return undefined;
  }
  const collected: unknown[] = [];
  for (const branch of issue.errors) {
    if (branch.length === 0) {
      return undefined;
    }
    const branchStart = collected.length;
    for (const branchIssue of branch) {
      const values = collectAllowedValuesFromIssue(branchIssue);
      if (!values) {
        return undefined;
      }
      collected.push(...values);
    }
    if (collected.length === branchStart) {
      return undefined;
    }
  }
  return collected;
}

function isRouteTypeMismatchIssue(issue: z.core.$ZodIssue): boolean {
  const issuePath = toConfigPathSegments(issue.path);
  return (
    issuePath.length === 1 &&
    issuePath[0] === "type" &&
    issue.code === "invalid_value" &&
    issue.values.includes("route")
  );
}

function extractBindingsSpecificUnionIssue(
  record: z.core.$ZodIssueInvalidUnion,
  parentPathSegments: readonly ConfigPathSegment[],
): ConfigValidationIssue | null {
  const issuePath = toConfigPathSegments(record.path);
  if (issuePath[0] !== "bindings" || typeof issuePath[1] !== "number") {
    return null;
  }
  let matchingBranchIssue: z.core.$ZodIssue | null = null;
  let sawRouteTypeMismatch = false;
  for (const branch of record.errors) {
    if (branch.some(isRouteTypeMismatchIssue)) {
      sawRouteTypeMismatch = true;
      continue;
    }
    let branchBestIssue: z.core.$ZodIssue | null = null;
    for (const issue of branch) {
      const issuePathLen = toConfigPathSegments(issue.path).length;
      const bestPathLen = branchBestIssue ? toConfigPathSegments(branchBestIssue.path).length : -1;
      if (
        issuePathLen > bestPathLen ||
        (issuePathLen === bestPathLen &&
          issue.code === "unrecognized_keys" &&
          branchBestIssue?.code !== "unrecognized_keys")
      ) {
        branchBestIssue = issue;
      }
    }
    if (!branchBestIssue) {
      continue;
    }
    if (matchingBranchIssue) {
      return null;
    }
    matchingBranchIssue = branchBestIssue;
  }
  if (
    !sawRouteTypeMismatch ||
    !matchingBranchIssue ||
    (toConfigPathSegments(matchingBranchIssue.path).length === 0 &&
      matchingBranchIssue.code !== "unrecognized_keys")
  ) {
    return null;
  }
  const fullPathSegments = [
    ...parentPathSegments,
    ...toConfigPathSegments(matchingBranchIssue.path),
  ];
  return withConfigIssuePath(
    { path: fullPathSegments.join("."), message: matchingBranchIssue.message },
    fullPathSegments,
  );
}

export function mapZodIssueToConfigIssue(issue: z.core.$ZodIssue): ConfigValidationIssue {
  const pathSegments = toConfigPathSegments(issue.path);
  const path = pathSegments.join(".");
  const enrichedMessage = appendNumericBoundHint(issue.message, issue);
  const allowedValuesSummary = summarizeAllowedValues(collectAllowedValuesFromIssue(issue) ?? []);

  // Bindings use a plain union because legacy route bindings may omit `type`.
  // When an explicit ACP binding fails strict-object checks, Zod collapses the
  // useful ACP branch issue behind a generic union-level "Invalid input".
  if (issue.code === "invalid_union" && !allowedValuesSummary) {
    const betterIssue = extractBindingsSpecificUnionIssue(issue, pathSegments);
    if (betterIssue) {
      return betterIssue;
    }
  }
  if (!allowedValuesSummary) {
    return withConfigIssuePath({ path, message: enrichedMessage }, pathSegments);
  }
  return withConfigIssuePath(
    {
      path,
      message: appendAllowedValuesHint(enrichedMessage, allowedValuesSummary),
      allowedValues: allowedValuesSummary.values,
      allowedValuesHiddenCount: allowedValuesSummary.hiddenCount,
    },
    pathSegments,
  );
}

function formatUnsupportedMutableSecretRefMessage(path: string): string {
  return [
    `SecretRef objects are not supported at ${path}.`,
    "This credential is runtime-mutable or runtime-managed and must stay a plain string value.",
    'Use a plain string (env template strings like "${MY_VAR}" are allowed).',
    `See ${SECRETREF_POLICY_DOC_URL}.`,
  ].join(" ");
}

export function collectUnsupportedSecretRefPolicyIssues(raw: unknown): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  for (const candidate of unsupportedSecretRefSurfacePolicy.collectConfigCandidates(raw)) {
    if (isRecord(candidate.value) && coerceSecretRef(candidate.value)) {
      issues.push({
        path: candidate.path,
        message: formatUnsupportedMutableSecretRefMessage(candidate.path),
      });
    }
  }
  return issues;
}

function formatFilteredUnrecognizedKeyMessage(message: string, keys: string[]): string {
  const quotedKeys = keys.map((key) => `"${key}"`).join(", ");
  if (/must not have additional properties/i.test(message)) {
    return `must not have additional properties: ${quotedKeys}`;
  }
  return keys.length === 1 ? `Unrecognized key: ${quotedKeys}` : `Unrecognized keys: ${quotedKeys}`;
}

function filterUnsupportedMutableSecretRefSchemaIssue(params: {
  issue: ConfigValidationIssue;
  policyIssue: ConfigValidationIssue;
}): ConfigValidationIssue | null {
  const { issue, policyIssue } = params;
  if (issue.path === policyIssue.path) {
    return /expected string, received object/i.test(issue.message) ? null : issue;
  }
  if (!issue.path || !policyIssue.path || !policyIssue.path.startsWith(`${issue.path}.`)) {
    return issue;
  }
  const childKey = policyIssue.path.slice(issue.path.length + 1).split(".")[0];
  if (!childKey || !/Unrecognized key|must not have additional properties/i.test(issue.message)) {
    return issue;
  }
  const unrecognizedKeys = [...issue.message.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  if (!unrecognizedKeys.includes(childKey)) {
    return issue;
  }
  const remainingKeys = unrecognizedKeys.filter(
    (key): key is string => key !== undefined && key !== childKey,
  );
  return remainingKeys.length === 0
    ? null
    : { ...issue, message: formatFilteredUnrecognizedKeyMessage(issue.message, remainingKeys) };
}

export function mergeUnsupportedMutableSecretRefIssues(
  policyIssues: ConfigValidationIssue[],
  schemaIssues: ConfigValidationIssue[],
): ConfigValidationIssue[] {
  if (policyIssues.length === 0) {
    return schemaIssues;
  }
  const filteredSchemaIssues = schemaIssues.flatMap((issue) => {
    let filteredIssue: ConfigValidationIssue | null = issue;
    for (const policyIssue of policyIssues) {
      if (!filteredIssue) {
        return [];
      }
      filteredIssue = filterUnsupportedMutableSecretRefSchemaIssue({
        issue: filteredIssue,
        policyIssue,
      });
    }
    return filteredIssue ? [filteredIssue] : [];
  });
  return [...policyIssues, ...filteredSchemaIssues];
}
