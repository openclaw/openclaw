import { afterEach, expect, it, vi } from "vitest";
import * as github from "./github-issue.js";
import { prepareUpdateFailureReport, submitUpdateFailureReport } from "./update-failure-report.js";
import { failedUpdateRun } from "./update-failure-report.test-support.js";

afterEach(() => vi.restoreAllMocks());

it("requires the reviewed digest and current attempt and authority before effects", async () => {
  const prepared = await prepareUpdateFailureReport(failedUpdateRun());
  const submit = vi.spyOn(github, "submitGithubIssue");
  const reconcile = vi.spyOn(github, "reconcileGithubIssue");
  await expect(submitUpdateFailureReport(prepared, "different")).rejects.toThrow(
    "preview is stale",
  );
  await expect(
    submitUpdateFailureReport(prepared, prepared.previewDigest, {
      validateCurrentAttempt: () => false,
    }),
  ).resolves.toMatchObject({ status: "stale" });
  await expect(
    submitUpdateFailureReport(prepared, prepared.previewDigest, {
      hasCurrentAuthority: () => false,
    }),
  ).rejects.toThrow("current authenticated client");
  expect(submit).not.toHaveBeenCalled();
  expect(reconcile).not.toHaveBeenCalled();
});

it("hands the exact reviewed body to the browser without host GitHub access", async () => {
  const prepared = await prepareUpdateFailureReport(failedUpdateRun());
  const submit = vi.spyOn(github, "submitGithubIssue");
  const reconcile = vi.spyOn(github, "reconcileGithubIssue");
  const result = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
    publicationMode: "browser",
  });
  expect(result.status).toBe("fallback");
  if (result.status !== "fallback") {
    throw new Error("Expected browser fallback");
  }
  expect(new URL(result.fallbackUrl).searchParams.get("body")).toBe(prepared.body);
  expect(submit).not.toHaveBeenCalled();
  expect(reconcile).not.toHaveBeenCalled();
});

it.each(["created", "not-found", "unavailable"] as const)(
  "reconciles %s without creating an issue",
  async (status) => {
    const prepared = await prepareUpdateFailureReport(failedUpdateRun());
    const url = "https://github.com/openclaw/openclaw/issues/123";
    vi.spyOn(github, "reconcileGithubIssue").mockResolvedValue(
      status === "created" ? { status, url } : { status },
    );
    const submit = vi.spyOn(github, "submitGithubIssue");
    const result = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
      publicationMode: "reconcile",
    });
    expect(result).toMatchObject(
      status === "created" ? { status: "created", url } : { status: "pending" },
    );
    expect(submit).not.toHaveBeenCalled();
  },
);

it.each([
  { status: "created", url: "https://github.com/openclaw/openclaw/issues/123" },
  { status: "outcome-unknown", reason: "creation-outcome-unknown" },
  { status: "fallback-unavailable", cause: "cli-unavailable", reason: "fallback-url-too-long" },
] as const)("preserves transport outcome $status", async (outcome) => {
  const prepared = await prepareUpdateFailureReport(failedUpdateRun());
  vi.spyOn(github, "submitGithubIssue").mockResolvedValue(outcome);
  const result = await submitUpdateFailureReport(prepared, prepared.previewDigest);
  expect(result.status).toBe(
    outcome.status === "created"
      ? "created"
      : outcome.status === "outcome-unknown"
        ? "pending"
        : "retryable",
  );
});

it("keeps a no-start retry in the terminal when browser fallback is disabled", async () => {
  const prepared = await prepareUpdateFailureReport(failedUpdateRun());
  vi.spyOn(github, "submitGithubIssue").mockResolvedValue(
    github.browserFallbackResult(prepared, "authentication-unavailable"),
  );
  const result = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
    allowBrowserFallback: false,
  });
  expect(result).toMatchObject({ status: "retryable" });
  expect(result).not.toHaveProperty("fallbackUrl");
});
