import { createHash } from "node:crypto";
import path from "node:path";
import { vi } from "vitest";
import type { GithubIssueSubmitHooks, PreparedGithubIssue } from "./github-issue.js";
import { readUpdateFailureReportReceipt } from "./restart-sentinel.js";
import type { PreparedUpdateFailureReport } from "./update-failure-report-prepare.js";
import { submitUpdateFailureReport } from "./update-failure-report.js";

export function createUpdateFailureReportFixture(
  prepared: PreparedUpdateFailureReport,
  stateDir: string,
) {
  const env = { OPENCLAW_STATE_DIR: stateDir };
  return {
    prepared,
    stateDir,
    env,
    receipt: () => readUpdateFailureReportReceipt(prepared.attemptId, env),
    submit: (options: Parameters<typeof submitUpdateFailureReport>[2] = {}) =>
      submitUpdateFailureReport(prepared, prepared.previewDigest, { stateDir, ...options }),
  };
}

export function savedReportArtifactPath(
  prepared: PreparedUpdateFailureReport,
  reservationId: string,
  previewDigest = prepared.previewDigest,
): string {
  const parsed = path.parse(prepared.savedReportPath);
  const artifactKey = createHash("sha256")
    .update(`${reservationId}\0${previewDigest}`)
    .digest("hex");
  return path.join(parsed.dir, `${parsed.name}.${artifactKey}${parsed.ext}`);
}

export function mockCreatedIssue(url: string) {
  return vi.fn(async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
    await hooks.afterAuthPreflight?.();
    const commitIssueCreate = await hooks.beforeIssueCreate?.();
    commitIssueCreate?.();
    return { status: "created" as const, url };
  });
}

export function mockFallbackIssue(fallbackUrl: string | undefined) {
  if (!fallbackUrl) {
    throw new Error("expected an available browser handoff");
  }
  return vi.fn(async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
    await hooks.afterAuthPreflight?.();
    return {
      url: fallbackUrl,
      reason: "cli-unavailable" as const,
      status: "browser-fallback" as const,
    };
  });
}

export function mockFallbackAfterIssueCreateNoStart(fallbackUrl: string | undefined) {
  if (!fallbackUrl) {
    throw new Error("expected an available browser handoff");
  }
  return vi.fn(async (_issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) => {
    await hooks.afterAuthPreflight?.();
    const commitIssueCreate = await hooks.beforeIssueCreate?.();
    commitIssueCreate?.();
    return {
      url: fallbackUrl,
      reason: "transport-unavailable" as const,
      status: "browser-fallback" as const,
    };
  });
}
