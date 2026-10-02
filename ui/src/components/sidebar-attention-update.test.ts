import { describe, expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { buildUpdateInboxEntry } from "./sidebar-attention-entries.ts";
import { resolveSidebarUpdateAttention } from "./sidebar-attention-update.ts";

function contextWithGitStatus(
  status: "ahead" | "behind" | "current" | "diverged" | "unavailable",
): ApplicationContext {
  const git =
    status === "current"
      ? { status }
      : status === "ahead"
        ? { status, commitsAhead: 1 }
        : status === "behind"
          ? { status, commitsBehind: 50 }
          : status === "diverged"
            ? { status, commitsAhead: 1, commitsBehind: 50 }
            : { status, reason: "fetch-failed" };
  return {
    gateway: { snapshot: { phase: "connected" } },
    overlays: {
      snapshot: {
        updateAvailable: {
          currentVersion: "2026.9.2",
          latestVersion: "2026.9.3",
          channel: "dev",
          commitsBehind: 246,
        },
        updateSchedule: {
          channel: "dev",
          autoEnabled: false,
          install: { kind: "git", git },
          target: {
            kind: "git",
            upstreamRef: "origin/main",
            upstreamSha: "abc1234def",
            commitsBehind: 246,
          },
        },
        updateRunning: false,
        updateReconciliationPending: false,
        updateStatusBanner: null,
      },
    },
  } as unknown as ApplicationContext;
}

function resolveUpdateEntry(context: ApplicationContext) {
  const state = resolveSidebarUpdateAttention(context);
  const entry = buildUpdateInboxEntry({
    canDismiss: state.canUpdate,
    dismissal: state.dismissal,
    forced: state.forced,
    requiresAction: state.actionable,
    severity: "warning",
    visible: state.present,
  });
  return { entry, state };
}

describe("update attention", () => {
  it.each(["current", "ahead"] as const)(
    "retires stale git availability from the Inbox after a refreshed %s comparison",
    (status) => {
      const { entry, state } = resolveUpdateEntry(contextWithGitStatus(status));
      expect(state.present).toBe(false);
      expect(entry).toBeNull();
    },
  );

  it("retains cached git availability when the refreshed comparison is unavailable", () => {
    const { entry, state } = resolveUpdateEntry(contextWithGitStatus("unavailable"));
    expect(state.present).toBe(true);
    expect(entry).not.toBeNull();
  });

  it.each(["behind", "diverged"] as const)(
    "keeps refreshed %s git availability in the Inbox",
    (status) => {
      const { entry, state } = resolveUpdateEntry(contextWithGitStatus(status));
      expect(state.present).toBe(true);
      expect(entry).not.toBeNull();
    },
  );
});
