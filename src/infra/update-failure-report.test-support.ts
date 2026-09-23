import { vi } from "vitest";
import type { GithubIssueSubmitHooks, PreparedGithubIssue } from "./github-issue.js";
import type { UpdateRunResult } from "./update-runner-types.js";

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

export function failedUpdate(overrides: Partial<UpdateRunResult> = {}): UpdateRunResult {
  return {
    status: "error",
    mode: "git",
    reason: "build-failed",
    before: { sha: "a".repeat(40), version: "2026.8.1" },
    after: { sha: "b".repeat(40), version: "2026.8.2" },
    steps: [
      {
        name: "build",
        command: "pnpm build --token raw-command-secret",
        cwd: "/Users/private/openclaw",
        durationMs: 12,
        exitCode: 1,
        stdoutTail: "raw chat and log output must not be copied",
        stderrTail: "token=raw-log-secret /Users/private/openclaw/build.log",
      },
    ],
    durationMs: 20,
    recovery: { serviceRestartSafe: true, version: "2026.8.1" },
    ...overrides,
  };
}
