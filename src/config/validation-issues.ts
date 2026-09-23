import { asNullableObjectRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { unsupportedSecretRefSurfacePolicy } from "../secrets/unsupported-surface-policy.js";
import { appendAllowedValuesHint, summarizeAllowedValues } from "./allowed-values.js";
import type { ConfigValidationIssue } from "./types.js";
import { coerceSecretRef } from "./types.secrets.js";

type UnknownIssueRecord = Record<string, unknown>;
type ConfigPathSegment = string | number;
type AllowedValuesCollection = {
  values: unknown[];
  incomplete: boolean;
  hasValues: boolean;
};

const SECRETREF_POLICY_DOC_URL = "https://docs.openclaw.ai/reference/secretref-credential-surface";

function toConfigPathSegments(path: unknown): ConfigPathSegment[] {
  if (!Array.isArray(path)) {
    return [];
  }
  return path.filter((segment): segment is ConfigPathSegment => {
    const segmentType = typeof segment;
    return segmentType === "string" || segmentType === "number";
  });
}

function formatConfigPath(segments: readonly ConfigPathSegment[]): string {
  return segments.join(".");
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

function appendNumericBoundHint(message: string, record: UnknownIssueRecord): string {
  // Numeric ceiling/floor hints (too_big / too_small with numeric origin).
  // Append a parenthesized bound alongside Zod's native message,
  // matching the clarity that enum/union rejections get via (allowed: …).
  const origin = typeof record.origin === "string" ? record.origin : "";
  if (origin !== "number") {
    return message;
  }
  const inclusive = record.inclusive === true;
  if (record.code === "too_big") {
    const maximum = typeof record.maximum === "number" ? record.maximum : undefined;
    if (maximum !== undefined) {
      return inclusive
        ? `${message} (maximum: ${maximum})`
        : `${message} (must be less than ${maximum})`;
    }
  }
  if (record.code === "too_small") {
    const minimum = typeof record.minimum === "number" ? record.minimum : undefined;
    if (minimum !== undefined) {
      return inclusive
        ? `${message} (minimum: ${minimum})`
        : `${message} (must be greater than ${minimum})`;
    }
  }
  return message;
}

function collectAllowedValuesFromIssue(issue: unknown): AllowedValuesCollection {
  const record = asNullableObjectRecord(issue);
  if (!record) {
    return { values: [], incomplete: false, hasValues: false };
  }
  const code = typeof record.code === "string" ? record.code : "";
  if (code === "invalid_value") {
    const values = record.values;
    return Array.isArray(values)
      ? { values, incomplete: false, hasValues: values.length > 0 }
      : { values: [], incomplete: true, hasValues: false };
  }
  if (code === "invalid_type") {
    return record.expected === "boolean"
      ? { values: [true, false], incomplete: false, hasValues: true }
      : { values: [], incomplete: true, hasValues: false };
  }
  if (code !== "invalid_union") {
    return { values: [], incomplete: false, hasValues: false };
  }
  const nested = record.errors;
  if (!Array.isArray(nested) || nested.length === 0) {
    return { values: [], incomplete: true, hasValues: false };
  }
  const collected: unknown[] = [];
  for (const branch of nested) {
    if (!Array.isArray(branch) || branch.length === 0) {
      return { values: [], incomplete: true, hasValues: false };
    }
    const branchCollected = collectAllowedValuesFromIssueList(branch);
    if (branchCollected.incomplete || !branchCollected.hasValues) {
      return { values: [], incomplete: true, hasValues: false };
    }
    collected.push(...branchCollected.values);
  }
  return { values: collected, incomplete: false, hasValues: collected.length > 0 };
}

function collectAllowedValuesFromIssueList(
  issues: ReadonlyArray<unknown>,
): AllowedValuesCollection {
  const collected: unknown[] = [];
  let hasValues = false;
  for (const issue of issues) {
    const branch = collectAllowedValuesFromIssue(issue);
    if (branch.incomplete) {
      return { values: [], incomplete: true, hasValues: false };
    }
    if (branch.hasValues) {
      hasValues = true;
      collected.push(...branch.values);
    }
  }
  return { values: collected, incomplete: false, hasValues };
}

function collectAllowedValuesFromUnknownIssue(issue: unknown): unknown[] {
  const collection = collectAllowedValuesFromIssue(issue);
  return collection.incomplete || !collection.hasValues ? [] : collection.values;
}

function isBindingsIssuePath(pathSegments: readonly ConfigPathSegment[]): boolean {
  return pathSegments[0] === "bindings" && typeof pathSegments[1] === "number";
}

function isRouteTypeMismatchIssue(issue: UnknownIssueRecord): boolean {
  const issuePath = toConfigPathSegments(issue.path);
  return (
    issuePath.length === 1 &&
    issuePath[0] === "type" &&
    issue.code === "invalid_value" &&
    Array.isArray(issue.values) &&
    issue.values.includes("route")
  );
}

function extractBindingsSpecificUnionIssue(
  record: UnknownIssueRecord,
  parentPathSegments: readonly ConfigPathSegment[],
): ConfigValidationIssue | null {
  if (!isBindingsIssuePath(toConfigPathSegments(record.path)) || !Array.isArray(record.errors)) {
    return null;
  }
  let matchingBranchIssue: UnknownIssueRecord | null = null;
  let matchingBranchIsUnrecognized = false;
  let matchingBranchPathLen = -1;
  let sawRouteTypeMismatch = false;
  for (const errGroup of record.errors) {
    if (!Array.isArray(errGroup)) {
      continue;
    }
    const branch = errGroup.map(asNullableObjectRecord).filter(Boolean) as UnknownIssueRecord[];
    if (branch.length === 0) {
      continue;
    }
    if (branch.some(isRouteTypeMismatchIssue)) {
      sawRouteTypeMismatch = true;
      continue;
    }
    let branchBestIssue: UnknownIssueRecord | null = null;
    let branchBestIsUnrecognized = false;
    let branchBestPathLen = -1;
    for (const issue of branch) {
      const issuePathLen = toConfigPathSegments(issue.path).length;
      const issueIsUnrecognized = issue.code === "unrecognized_keys";
      if (
        issuePathLen > branchBestPathLen ||
        (issuePathLen === branchBestPathLen && issueIsUnrecognized && !branchBestIsUnrecognized)
      ) {
        branchBestIssue = issue;
        branchBestIsUnrecognized = issueIsUnrecognized;
        branchBestPathLen = issuePathLen;
      }
    }
    if (!branchBestIssue) {
      continue;
    }
    if (matchingBranchIssue) {
      return null;
    }
    matchingBranchIssue = branchBestIssue;
    matchingBranchIsUnrecognized = branchBestIsUnrecognized;
    matchingBranchPathLen = branchBestPathLen;
  }
  if (
    !sawRouteTypeMismatch ||
    !matchingBranchIssue ||
    (matchingBranchPathLen === 0 && !matchingBranchIsUnrecognized)
  ) {
    return null;
  }
  const fullPathSegments = [
    ...parentPathSegments,
    ...toConfigPathSegments(matchingBranchIssue.path),
  ];
  const message =
    typeof matchingBranchIssue.message === "string" ? matchingBranchIssue.message : "Invalid input";
  return withConfigIssuePath(
    { path: formatConfigPath(fullPathSegments), message },
    fullPathSegments,
  );
}

export function mapZodIssueToConfigIssue(issue: unknown): ConfigValidationIssue {
  const record = asNullableObjectRecord(issue);
  const pathSegments = toConfigPathSegments(record?.path);
  const path = formatConfigPath(pathSegments);
  const message = typeof record?.message === "string" ? record.message : "Invalid input";
  const enrichedMessage = record ? appendNumericBoundHint(message, record) : message;
  const allowedValuesSummary = summarizeAllowedValues(collectAllowedValuesFromUnknownIssue(issue));

  // Bindings use a plain union because legacy route bindings may omit `type`.
  // When an explicit ACP binding fails strict-object checks, Zod collapses the
  // useful ACP branch issue behind a generic union-level "Invalid input".
  if (record?.code === "invalid_union" && !allowedValuesSummary) {
    const betterIssue = extractBindingsSpecificUnionIssue(record, pathSegments);
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

function isObjectSecretRefCandidate(value: unknown): boolean {
  return isRecord(value) && Boolean(coerceSecretRef(value));
}

function formatUnsupportedMutableSecretRefMessage(path: string): string {
  return [
    `SecretRef objects are not supported at ${path}.`,
    "This credential is runtime-mutable or runtime-managed and must stay a plain string value.",
    'Use a plain string (env template strings like "${MY_VAR}" are allowed).',
    `See ${SECRETREF_POLICY_DOC_URL}.`,
  ].join(" ");
}

function collectUnsupportedMutableSecretRefIssues(raw: unknown): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  for (const candidate of unsupportedSecretRefSurfacePolicy.collectConfigCandidates(raw)) {
    if (isObjectSecretRefCandidate(candidate.value)) {
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

export function collectUnsupportedSecretRefPolicyIssues(raw: unknown): ConfigValidationIssue[] {
  return collectUnsupportedMutableSecretRefIssues(raw);
}
