import { describe, expect, it } from "vitest";
import type { CronJob } from "../api/types.ts";
import {
  buildScopeUpgradeInboxEntry,
  buildSidebarInboxEntries,
  sidebarInboxTabCounts,
} from "./sidebar-attention-entries.ts";
import { buildSidebarAttentionEntries, type CronAttentionJob } from "./sidebar-attention-items.ts";
import { inboxMention } from "./sidebar-inbox.test-support.ts";

function cronJob(
  id: string,
  state: CronJob["state"] = { lastRunStatus: "error" },
  name = id,
): CronAttentionJob {
  return { id, name, enabled: true, updatedAtMs: 0, state };
}

function mentionItem(id: string, createdAt: number) {
  return { ...inboxMention(id), createdAt };
}

function cronItems(
  cronJobs: readonly CronAttentionJob[],
  now = 0,
  cronOwnerByJobId?: ReadonlyMap<string, string>,
  cronSchedulerEnabled = true,
) {
  return buildSidebarAttentionEntries({
    cronJobs,
    cronSchedulerEnabled,
    cronOwnerByJobId,
    modelAuthStatus: null,
    now,
  });
}

function inbox(
  requiresAction: boolean,
  overrides: Partial<Parameters<typeof buildSidebarInboxEntries>[0]> = {},
) {
  return buildSidebarInboxEntries({
    approvals: [],
    attention: [],
    mentions: [],
    scopeUpgrade: null,
    update: {
      type: "update",
      category: "system",
      dismissal: null,
      requiresAction,
      severity: "warning",
    },
    ...overrides,
  });
}

describe("sidebar attention projection", () => {
  it("lists each failed job as direct automation navigation", () => {
    const failed = cronItems([
      cronJob("primary", undefined, "Nightly backup"),
      cronJob("reason-id", undefined, ""),
      cronJob("unknown-id"),
    ]);

    expect(failed.map((item) => item.label)).toEqual(["Nightly backup", "reason-id", "unknown-id"]);
    expect(failed.map((item) => item.action)).toEqual(
      Array.from({ length: 3 }, () => ({ kind: "navigate", routeId: "cron" })),
    );
  });

  it("does not flag an actively running job as overdue", () => {
    const running = cronJob("running-id", { lastRunStatus: "ok", nextRunAtMs: 1, runningAtMs: 2 });
    const stalled = cronJob("stalled-id", { lastRunStatus: "ok", nextRunAtMs: 2 });

    const overdue = cronItems([running, stalled], 300_003).find(
      (item) => item.kind === "cronOverdue",
    );

    expect(overdue?.label).toBe("stalled-id");
  });

  it("does not flag an enabled overdue job while the scheduler is disabled", () => {
    const overdue = cronJob("overdue-id");
    overdue.state = { lastRunStatus: "ok", nextRunAtMs: 1 };

    expect(cronItems([overdue], 300_002, undefined, false)).not.toContainEqual(
      expect.objectContaining({ kind: "cronOverdue" }),
    );
  });

  it("shows automation owners only when the caller supplies an all-agent owner map", () => {
    const item = cronItems([cronJob("writer-job")], 0, new Map([["writer-job", "Writer"]]))[0];
    expect(item?.meta?.context).toBe("Writer");
  });

  it("orders failed before overdue and newest first within each group", () => {
    const items = cronItems(
      [
        cronJob("older-overdue", { lastRunStatus: "ok", nextRunAtMs: 1 }),
        cronJob("older-failed", { lastRunStatus: "error", lastRunAtMs: 100 }),
        cronJob("overdue", { lastRunStatus: "ok", nextRunAtMs: 2 }),
        cronJob("failed", { lastRunStatus: "error", lastRunAtMs: 200 }),
      ],
      300_003,
    );

    expect(items.map((item) => item.label)).toEqual([
      "failed",
      "older-failed",
      "overdue",
      "older-overdue",
    ]);
  });
  it("derives every tab count and dismiss control from one entry list", () => {
    const entries = inbox(true, {
      approvals: [
        {
          id: "approval-1",
          kind: "exec",
          request: { command: "pwd" },
          createdAtMs: 1,
          expiresAtMs: 60_000,
        },
      ],
      attention: cronItems([cronJob("failed-job")]),
      mentions: [mentionItem("older", 1_000), mentionItem("newer", 2_000)],
      scopeUpgrade: buildScopeUpgradeInboxEntry({
        scopes: ["operator.read"],
        state: { phase: "available" },
      }),
    });

    expect(sidebarInboxTabCounts(entries)).toEqual({
      all: 6,
      approvals: 1,
      mentions: 2,
      automations: 1,
      system: 2,
    });
    expect(entries.filter((entry) => entry.dismissal).map((entry) => entry.type)).toEqual([
      "scopeUpgrade",
      "attention",
    ]);
    expect(entries.slice(-2).map((entry) => entry.type === "mention" && entry.mention.id)).toEqual([
      "newer",
      "older",
    ]);
  });

  it("keeps informational updates visible without adding them to attention counts", () => {
    const entries = inbox(false);

    expect(entries).toHaveLength(1);
    expect(sidebarInboxTabCounts(entries)).toEqual({
      all: 0,
      approvals: 0,
      mentions: 0,
      automations: 0,
      system: 0,
    });
  });
});
