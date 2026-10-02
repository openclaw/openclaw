import { describe, expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { buildUpdateInboxEntry } from "./sidebar-attention-entries.ts";
import { resolveSidebarUpdateAttention } from "./sidebar-attention-update.ts";

function contextWithGitStatus(status: "behind" | "current" | "unavailable"): ApplicationContext {
  const git =
    status === "current"
      ? { status }
      : status === "behind"
        ? { status, commitsBehind: 50 }
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
  it.each([
    { status: "current", present: false },
    { status: "behind", present: true },
    { status: "unavailable", present: true },
  ] as const)(
    "sets Inbox presence to $present after a $status comparison",
    ({ status, present }) => {
      const { entry, state } = resolveUpdateEntry(contextWithGitStatus(status));
      expect(state.present).toBe(present);
      if (present) {
        expect(entry).not.toBeNull();
      } else {
        expect(entry).toBeNull();
      }
    },
  );
});
