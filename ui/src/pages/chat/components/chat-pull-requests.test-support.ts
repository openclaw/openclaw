import type { ControlUiSessionBranch } from "../../../../../src/gateway/control-ui-contract.js";
import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-controller.ts";

export function publication(overrides: Partial<GitHubPublicationView> = {}): GitHubPublicationView {
  return {
    activity: null,
    canPublishShared: true,
    canPublishPersonal: true,
    locked: false,
    options: null,
    selection: {
      source: "shared",
      expected: { source: "system-configured", accountId: 1, login: "system-bot" },
    },
    result: null,
    confirmation: null,
    error: null,
    personalReady: true,
    onPublish: () => {},
    onRefresh: () => {},
    ...overrides,
  };
}

export function sessionBranch(
  overrides: Partial<ControlUiSessionBranch> = {},
): ControlUiSessionBranch {
  return {
    owner: "openclaw",
    repo: "openclaw",
    branch: "claude/cloud-workers-live-events",
    additions: 2819,
    deletions: 205,
    createUrl: "https://github.com/openclaw/openclaw/pull/new/claude/cloud-workers-live-events",
    ...overrides,
  };
}
