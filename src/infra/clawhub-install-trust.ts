// Shared ClawHub exact-release trust gate for plugin, skill, and Template installs.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { stripAnsi, visibleWidth } from "../../packages/terminal-core/src/ansi.js";
import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { resolveClawHubBaseUrl } from "./clawhub-client.js";
import { encodeClawHubPackagePath, formatClawHubReleaseLabel } from "./clawhub-display.js";
import { normalizeClawHubSha256Hex } from "./clawhub-integrity.js";
import {
  fetchClawHubPackageSecurity,
  type ClawHubPackageSecurityResponse,
  type ClawHubPackageSecurityTrust,
} from "./clawhub-packages.js";
import { fetchExactClawHubSkillSecurityVerdicts } from "./clawhub-skill-security.js";
import type { ClawHubSkillSecurityVerdictItem } from "./clawhub-skills.js";
import { formatErrorMessage } from "./errors.js";

export const CLAWHUB_TRUST_ERROR_CODE = {
  CLAWHUB_SECURITY_UNAVAILABLE: "clawhub_security_unavailable",
  CLAWHUB_DOWNLOAD_BLOCKED: "clawhub_download_blocked",
} as const;

export type ClawHubTrustErrorCode =
  (typeof CLAWHUB_TRUST_ERROR_CODE)[keyof typeof CLAWHUB_TRUST_ERROR_CODE];

type ClawHubTrustInstallRecordFields = {
  clawhubTrustDisposition: "clean" | "review-recommended" | "review-required" | "blocked";
  clawhubTrustScanStatus?: string;
  clawhubTrustModerationState?: string;
  clawhubTrustReasons?: string[];
  clawhubTrustPending?: true;
  clawhubTrustStale?: true;
  clawhubTrustCheckedAt: string;
};

type ClawHubTrustAcceptedResult = {
  ok: true;
  trustInstallRecordFields: ClawHubTrustInstallRecordFields;
  warning?: string;
};

type ClawHubTrustFailure = {
  ok: false;
  error: string;
  code?: ClawHubTrustErrorCode;
  warning?: string;
  version?: string;
};

type ClawHubInstallLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  terminalLinks?: boolean;
};

type ClawHubTrustSubject =
  | { kind: "plugin"; packageName: string }
  | { kind: "template"; packageName: string }
  | { kind: "skill"; packageName: string; workspaceDir: string; ownerHandle?: string };

type ClawHubFetchedSubjectSecurity = {
  security: ClawHubPackageSecurityResponse;
  links?: {
    subject?: string;
    security?: string;
  };
};

type ClawHubExpectedTemplateArtifact = {
  sha256: string;
  npmIntegrity: string;
  npmShasum?: string;
};

const CLAWHUB_BLOCKING_MODERATION_STATES = new Set(["blocked", "quarantined", "revoked"]);
const CLAWHUB_SAFE_MODERATION_STATES = new Set(["", "approved"]);
const CLAWHUB_SAFE_SECURITY_VERDICTS = new Set(["clean", "benign"]);
const CLAWHUB_BLOCKING_SECURITY_VERDICTS = new Set(["malicious", "blocked"]);
const CLAWHUB_NON_RISK_SCAN_STATUSES = new Set(["pending", "scan_pending", "stale", "stale_scan"]);
const CLAWHUB_NON_RISK_REASONS = new Set([
  "pending",
  "pending_scan",
  "scan:pending",
  "scan_pending",
  "stale",
  "scan:stale",
  "stale_scan",
]);

function normalizeClawHubTrustToken(value: string | null | undefined): string {
  return normalizeOptionalString(value)?.toLowerCase() ?? "";
}

type ClawHubTrustDisposition = ClawHubTrustInstallRecordFields["clawhubTrustDisposition"];

function hasClawHubRiskReasons(trust: ClawHubPackageSecurityTrust): boolean {
  const scanStatus = normalizeClawHubTrustToken(trust.scanStatus);
  const pendingOrStale = trust.pending || trust.stale;
  const moderationState = normalizeClawHubTrustToken(trust.moderationState);
  return (
    trust.blockedFromDownload ||
    (scanStatus !== "clean" &&
      !(pendingOrStale && CLAWHUB_NON_RISK_SCAN_STATUSES.has(scanStatus))) ||
    !CLAWHUB_SAFE_MODERATION_STATES.has(moderationState) ||
    trust.reasons.some((reason) => {
      const normalized = normalizeClawHubTrustToken(reason);
      return Boolean(normalized) && !(pendingOrStale && CLAWHUB_NON_RISK_REASONS.has(normalized));
    })
  );
}

function isBlockingClawHubTrust(trust: ClawHubPackageSecurityTrust): boolean {
  if (trust.blockedFromDownload) {
    return true;
  }
  if (normalizeClawHubTrustToken(trust.scanStatus) === "malicious") {
    return true;
  }
  if (CLAWHUB_BLOCKING_MODERATION_STATES.has(normalizeClawHubTrustToken(trust.moderationState))) {
    return true;
  }
  return trust.reasons.some((reason) => {
    const normalized = normalizeClawHubTrustToken(reason);
    return normalized === "scan:malicious" || normalized === "static:malicious";
  });
}

export function assessClawHubTrust(
  security: ClawHubPackageSecurityResponse,
): ClawHubTrustDisposition {
  const trust = security.trust;
  const verdict = normalizeClawHubTrustToken(security.verdict);
  if (isBlockingClawHubTrust(trust) || CLAWHUB_BLOCKING_SECURITY_VERDICTS.has(verdict)) {
    return "blocked";
  }
  if (!CLAWHUB_SAFE_SECURITY_VERDICTS.has(verdict)) {
    return "review-required";
  }
  const hasRiskReasons = hasClawHubRiskReasons(trust);
  if (!hasRiskReasons && !trust.pending && !trust.stale) {
    return "clean";
  }
  return hasRiskReasons ? "review-required" : "review-recommended";
}

function resolveClawHubSubjectUrl(params: {
  baseUrl?: string;
  subject: ClawHubTrustSubject;
}): string {
  if (params.subject.kind === "skill" && params.subject.ownerHandle) {
    return `${resolveClawHubBaseUrl(params.baseUrl)}/${encodeURIComponent(params.subject.ownerHandle)}/skills/${encodeURIComponent(params.subject.packageName)}`;
  }
  const pathRoot =
    params.subject.kind === "skill"
      ? "skills"
      : params.subject.kind === "template"
        ? "templates"
        : "plugins";
  return `${resolveClawHubBaseUrl(params.baseUrl)}/${pathRoot}/${encodeClawHubPackagePath(params.subject.packageName)}`;
}

function wrapClawHubAuditLine(value: string, width: number): string[] {
  if (visibleWidth(value) <= width) {
    return [value];
  }
  const words = value.split(/\s+/u).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && visibleWidth(next) > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  return line ? [...lines, line] : lines;
}

function renderClawHubAuditBox(lines: string[]): string {
  const columns = Math.max(72, Math.min(process.stdout.columns ?? 88, 104));
  const innerWidth = Math.max(54, Math.min(columns - 4, 88));
  const title = "─ ClawHub Security Audit ";
  const borderWidth = innerWidth + 2;
  const top = `╭${title}${"─".repeat(Math.max(0, borderWidth - visibleWidth(title)))}╮`;
  const body = lines.flatMap((line) => {
    if (!line) {
      return [`│ ${" ".repeat(innerWidth)} │`];
    }
    return wrapClawHubAuditLine(line, innerWidth).map(
      (wrapped) => `│ ${wrapped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(wrapped)))} │`,
    );
  });
  return [top, ...body, `╰${"─".repeat(borderWidth)}╯`].join("\n");
}

function formatClawHubSubjectPackageName(subject: ClawHubTrustSubject): string {
  return subject.kind === "skill" && subject.ownerHandle
    ? `@${subject.ownerHandle}/${subject.packageName}`
    : subject.packageName;
}

function formatClawHubSubjectReleaseLabel(subject: ClawHubTrustSubject, version: string): string {
  return formatClawHubReleaseLabel(formatClawHubSubjectPackageName(subject), version);
}

function readSkillVerdictSecurityStatus(item: ClawHubSkillSecurityVerdictItem): string | undefined {
  if (!item.security || typeof item.security !== "object") {
    return undefined;
  }
  const security = item.security as { status?: unknown; rawStatus?: unknown };
  if (typeof security.status === "string") {
    return security.status;
  }
  return typeof security.rawStatus === "string" ? security.rawStatus : undefined;
}

function readSkillVerdictSecurityPassed(
  item: ClawHubSkillSecurityVerdictItem,
): boolean | undefined {
  if (!item.security || typeof item.security !== "object") {
    return undefined;
  }
  const passed = (item.security as { passed?: unknown }).passed;
  return typeof passed === "boolean" ? passed : undefined;
}

function hasUsablePassingSkillVerdictSecurity(item: ClawHubSkillSecurityVerdictItem): boolean {
  return (
    Boolean(readSkillVerdictSecurityStatus(item)) && readSkillVerdictSecurityPassed(item) === true
  );
}

function hasSkillVerdictSecurityError(item: ClawHubSkillSecurityVerdictItem): boolean {
  return Boolean(item.error?.code || item.error?.message || item.version === null);
}

function isSkillVerdictPendingReason(reason: string): boolean {
  const normalized = normalizeClawHubTrustToken(reason);
  return normalized === "pending" || normalized === "pending_scan" || normalized === "scan_pending";
}

function isSkillVerdictStaleReason(reason: string): boolean {
  const normalized = normalizeClawHubTrustToken(reason);
  return normalized === "stale" || normalized === "scan:stale" || normalized === "stale_scan";
}

function isSkillVerdictBlockingReason(reason: string): boolean {
  const normalized = normalizeClawHubTrustToken(reason);
  return (
    normalized.includes("malicious") ||
    normalized.includes("malware") ||
    normalized.endsWith("_blocked") ||
    normalized.endsWith(".blocked") ||
    normalized === "blocked"
  );
}

function mapSkillSecurityVerdictToPackageSecurity(params: {
  item: ClawHubSkillSecurityVerdictItem;
  packageName: string;
  ownerHandle?: string;
  version: string;
}): ClawHubPackageSecurityResponse {
  const responseSlug = normalizeOptionalString(params.item.slug ?? params.item.requestedSlug);
  if (responseSlug !== params.packageName) {
    throw new Error(
      terminalText`ClawHub skill trust check for "${formatClawHubReleaseLabel(params.packageName, params.version)}" returned skill "${responseSlug ?? "unknown"}".`,
    );
  }
  const responsePublisher = normalizeOptionalString(params.item.publisherHandle);
  if (params.ownerHandle && responsePublisher !== params.ownerHandle) {
    throw new Error(
      terminalText`ClawHub skill trust check for "${formatClawHubReleaseLabel(params.packageName, params.version)}" returned publisher "${responsePublisher ?? "unknown"}", expected "${params.ownerHandle}".`,
    );
  }
  const responseVersion = normalizeOptionalString(params.item.version);
  if (responseVersion !== params.version) {
    const reason = params.item.error?.message ? `: ${params.item.error.message}` : "";
    throw new Error(
      terminalText`ClawHub skill trust check for "${formatClawHubReleaseLabel(params.packageName, params.version)}" returned version "${responseVersion ?? "unknown"}"${reason}.`,
    );
  }
  if (hasSkillVerdictSecurityError(params.item)) {
    const reason = params.item.error?.message ? `: ${params.item.error.message}` : "";
    throw new Error(
      terminalText`ClawHub skill trust check for "${formatClawHubReleaseLabel(params.packageName, params.version)}" did not return a usable security verdict${reason}.`,
    );
  }
  const decision = normalizeClawHubTrustToken(params.item.decision);
  if (params.item.ok && decision === "pass" && !hasUsablePassingSkillVerdictSecurity(params.item)) {
    throw new Error(
      `ClawHub skill trust check for "${formatClawHubReleaseLabel(params.packageName, params.version)}" did not return a usable security verdict.`,
    );
  }

  const securityStatus = normalizeClawHubTrustToken(readSkillVerdictSecurityStatus(params.item));
  const securityPassed = readSkillVerdictSecurityPassed(params.item);
  const reasons = params.item.reasons
    .map((reason) => normalizeOptionalString(reason))
    .filter((reason): reason is string => Boolean(reason));
  const securityPassedAllowsInstall = securityPassed ?? true;
  const verdictPassed = params.item.ok && decision === "pass" && securityPassedAllowsInstall;
  const scanStatus = verdictPassed
    ? securityStatus || "clean"
    : securityStatus && securityStatus !== "clean"
      ? securityStatus
      : "suspicious";
  if (!verdictPassed && reasons.length === 0) {
    reasons.push(decision ? `decision:${decision}` : "decision:fail");
  }
  const hasBlockingReason = reasons.some(isSkillVerdictBlockingReason);
  const blocked = decision === "blocked" || securityStatus === "malicious" || hasBlockingReason;
  const displayName = normalizeOptionalString(params.item.displayName);
  const overview = params.item.overview;
  if (typeof overview !== "string" || !overview.trim()) {
    throw new Error(
      `ClawHub skill trust check for "${formatClawHubReleaseLabel(params.packageName, params.version)}" did not return an audit overview.`,
    );
  }
  const securityAuditUrl = normalizeOptionalString(params.item.securityAuditUrl);
  if (!securityAuditUrl) {
    throw new Error(
      `ClawHub skill trust check for "${formatClawHubReleaseLabel(params.packageName, params.version)}" did not return a security audit URL.`,
    );
  }
  return {
    package: {
      name: params.packageName,
      family: "skill",
      ...(displayName ? { displayName } : {}),
    },
    release: {
      version: params.version,
    },
    overview,
    verdict: blocked
      ? "blocked"
      : verdictPassed && securityStatus === "clean" && reasons.length === 0
        ? "benign"
        : "review",
    securityAuditUrl,
    trust: {
      scanStatus,
      moderationState: null,
      blockedFromDownload: blocked,
      reasons,
      pending: securityStatus === "pending" || reasons.some(isSkillVerdictPendingReason),
      stale: securityStatus === "stale" || reasons.some(isSkillVerdictStaleReason),
    },
  };
}

function resolveSkillSecurityLinks(
  item: ClawHubSkillSecurityVerdictItem,
): ClawHubFetchedSubjectSecurity["links"] {
  const subject = normalizeOptionalString(item.skillUrl);
  const security = normalizeOptionalString(item.securityAuditUrl);
  return {
    ...(subject ? { subject } : {}),
    ...(security ? { security } : {}),
  };
}

async function fetchClawHubSubjectSecurity(params: {
  subject: ClawHubTrustSubject;
  version: string;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
}): Promise<ClawHubFetchedSubjectSecurity> {
  if (params.subject.kind === "plugin" || params.subject.kind === "template") {
    const security = await fetchClawHubPackageSecurity({
      name: params.subject.packageName,
      version: params.version,
      baseUrl: params.baseUrl,
      token: params.token,
      timeoutMs: params.timeoutMs,
    });
    return {
      security,
      links: { security: security.securityAuditUrl },
    };
  }
  const [item] = await fetchExactClawHubSkillSecurityVerdicts({
    items: [
      {
        slug: params.subject.packageName,
        ...(params.subject.ownerHandle ? { ownerHandle: params.subject.ownerHandle } : {}),
        version: params.version,
      },
    ],
    baseUrl: params.baseUrl,
    token: params.token,
    timeoutMs: params.timeoutMs,
  });
  if (!item) {
    throw new Error(
      `ClawHub skill trust check for "${formatClawHubReleaseLabel(params.subject.packageName, params.version)}" returned no verdict.`,
    );
  }
  return {
    security: mapSkillSecurityVerdictToPackageSecurity({
      item,
      packageName: params.subject.packageName,
      ...(params.subject.ownerHandle ? { ownerHandle: params.subject.ownerHandle } : {}),
      version: params.version,
    }),
    links: resolveSkillSecurityLinks(item),
  };
}

export async function checkClawHubPackageTrust(params: {
  subject: ClawHubTrustSubject;
  version: string;
  expectedTemplateArtifact?: ClawHubExpectedTemplateArtifact;
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  logger?: ClawHubInstallLogger;
  mode?: "install" | "update";
  confirmOnUpdate?: boolean;
  confirmInstall?: (warning?: string) => boolean | Promise<boolean>;
}): Promise<ClawHubTrustFailure | ClawHubTrustAcceptedResult> {
  let security: ClawHubPackageSecurityResponse;
  let warningLinks: ClawHubFetchedSubjectSecurity["links"];
  const packageLabel = formatClawHubSubjectPackageName(params.subject);
  const releaseLabel = formatClawHubSubjectReleaseLabel(params.subject, params.version);
  try {
    const fetchedSecurity = await fetchClawHubSubjectSecurity({
      subject: params.subject,
      version: params.version,
      baseUrl: params.baseUrl,
      token: params.token,
      timeoutMs: params.timeoutMs,
    });
    const expectedFamily = params.subject.kind === "template" ? "template" : undefined;
    const expectedTemplateArtifact = expectedFamily ? params.expectedTemplateArtifact : undefined;
    const responsePackageName = normalizeOptionalString(fetchedSecurity.security.package?.name);
    if (responsePackageName !== params.subject.packageName) {
      return {
        ok: false,
        error: terminalText`ClawHub release trust check for "${formatClawHubReleaseLabel(packageLabel, params.version)}" returned package "${responsePackageName ?? "unknown"}".`,
        code: CLAWHUB_TRUST_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE,
        version: params.version,
      };
    }
    if (expectedFamily && fetchedSecurity.security.package?.family !== expectedFamily) {
      return {
        ok: false,
        error: `ClawHub release trust check for "${formatClawHubReleaseLabel(packageLabel, params.version)}" returned a different package family.`,
        code: CLAWHUB_TRUST_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE,
        version: params.version,
      };
    }
    const responseVersion = normalizeOptionalString(fetchedSecurity.security.release?.version);
    if (responseVersion !== params.version) {
      return {
        ok: false,
        error: terminalText`ClawHub release trust check for "${formatClawHubReleaseLabel(packageLabel, params.version)}" returned version "${responseVersion ?? "unknown"}".`,
        code: CLAWHUB_TRUST_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE,
        version: params.version,
      };
    }
    if (expectedFamily === "template" && !expectedTemplateArtifact) {
      return {
        ok: false,
        error: `ClawHub release trust check for "${formatClawHubReleaseLabel(packageLabel, params.version)}" has no selected artifact identity.`,
        code: CLAWHUB_TRUST_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE,
        version: params.version,
      };
    }
    if (expectedTemplateArtifact) {
      const release = fetchedSecurity.security.release;
      if (
        release?.artifactKind !== "npm-pack" ||
        normalizeClawHubSha256Hex(release.artifactSha256 ?? "") !==
          expectedTemplateArtifact.sha256 ||
        release.npmIntegrity !== expectedTemplateArtifact.npmIntegrity ||
        (expectedTemplateArtifact.npmShasum !== undefined &&
          release.npmShasum !== expectedTemplateArtifact.npmShasum)
      ) {
        return {
          ok: false,
          error: `ClawHub release trust check for "${formatClawHubReleaseLabel(packageLabel, params.version)}" returned a different artifact identity.`,
          code: CLAWHUB_TRUST_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE,
          version: params.version,
        };
      }
    }
    security = fetchedSecurity.security;
    warningLinks = fetchedSecurity.links;
  } catch (error) {
    return {
      ok: false,
      error: terminalText`ClawHub release trust check failed for "${releaseLabel}": ${formatErrorMessage(error)}`,
      code: CLAWHUB_TRUST_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE,
      version: params.version,
    };
  }

  const assessedDisposition = assessClawHubTrust(security);
  const disposition =
    params.subject.kind === "template" && assessedDisposition === "review-recommended"
      ? "review-required"
      : assessedDisposition;
  const checkedAt = new Date().toISOString();

  const auditBaseUrl = params.baseUrl;
  const auditSubject = params.subject;
  const auditVersion = params.version;
  const overview = security.overview;
  const subjectUrl =
    (auditSubject.kind === "skill" && normalizeOptionalString(warningLinks?.subject)) ||
    resolveClawHubSubjectUrl({ baseUrl: auditBaseUrl, subject: auditSubject });
  const securityAuditUrl =
    normalizeOptionalString(warningLinks?.security) ??
    `${subjectUrl}/security-audit?version=${encodeURIComponent(auditVersion)}`;
  const auditReleaseLabel = formatClawHubSubjectReleaseLabel(auditSubject, auditVersion);
  const outcome =
    disposition === "blocked"
      ? theme.error("Blocked")
      : disposition === "clean"
        ? theme.success("Safe")
        : theme.warn("Review");
  const terminalAudit = renderClawHubAuditBox([
    terminalText`${auditReleaseLabel}`,
    "",
    `Outcome: ${outcome}`,
    "",
    "Overview:",
    ...overview.split("\n").map((line) => terminalText`${line}`),
    "",
    terminalText`Details: ${securityAuditUrl}`,
  ]);
  const audit = stripAnsi(terminalAudit);
  if (disposition === "clean") {
    params.logger?.info?.(terminalAudit);
  } else {
    params.logger?.warn?.(terminalAudit);
  }
  if (disposition === "blocked") {
    const blockedVerb = params.mode === "update" ? "update" : "install";
    return {
      ok: false,
      error: `ClawHub blocked this release; ${blockedVerb} was not started.`,
      code: CLAWHUB_TRUST_ERROR_CODE.CLAWHUB_DOWNLOAD_BLOCKED,
      warning: audit,
      version: params.version,
    };
  }
  if (
    (params.mode !== "update" || params.confirmOnUpdate) &&
    params.confirmInstall &&
    !(await params.confirmInstall(disposition === "clean" ? undefined : audit))
  ) {
    return {
      ok: false,
      error: "Install cancelled.",
      warning: audit,
      version: params.version,
    };
  }
  const trust = security.trust;
  const scanStatus = normalizeClawHubTrustToken(trust.scanStatus);
  const moderationState = normalizeClawHubTrustToken(trust.moderationState);
  const reasons = trust.reasons
    .map((reason) => normalizeOptionalString(reason))
    .filter((reason): reason is string => Boolean(reason));
  return {
    ok: true,
    trustInstallRecordFields: {
      clawhubTrustDisposition: disposition,
      ...(scanStatus ? { clawhubTrustScanStatus: scanStatus } : {}),
      ...(moderationState ? { clawhubTrustModerationState: moderationState } : {}),
      ...(reasons.length > 0 ? { clawhubTrustReasons: reasons } : {}),
      ...(trust.pending ? { clawhubTrustPending: true } : {}),
      ...(trust.stale ? { clawhubTrustStale: true } : {}),
      clawhubTrustCheckedAt: checkedAt,
    },
    ...(disposition === "clean" ? {} : { warning: audit }),
  };
}
