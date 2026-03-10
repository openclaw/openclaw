/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_UI_GROWTH_FOUNDATION_PATH,
  CONTROL_UI_GROWTH_REVIEW_ACTION_PATH,
} from "../../../../src/gateway/control-ui-contract.js";
import {
  loadGrowthFoundationSummary,
  submitGrowthFoundationReviewAction,
} from "./growth-foundation.ts";

describe("loadGrowthFoundationSummary", () => {
  it("loads the growth foundation summary from the control-ui endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        available: true,
        projectId: "growth-foundation",
        workspaceProjectId: "2026-03-06_growth-foundation",
        alertStatus: "clear",
        alertTransition: "steady-clear",
        alertUpdatedAt: "2026-03-06T13:54:36+09:00",
        actionsStatus: "actionable",
        actionsUpdatedAt: "2026-03-06T13:54:16+09:00",
        priorityNow: [],
        thisWeek: ["Review queue output"],
        thisWeekItems: [
          {
            key: "item-1",
            text: "Review queue output",
            display: "Review queue output",
            completedAt: null,
            source: null,
          },
        ],
        completedThisWeekItems: [],
        completedHistoryItems: [],
        notificationStatus: "attention",
        notificationCount: 1,
        notificationItems: [
          {
            id: "reviews-open",
            severity: "warning",
            title: "1 review item(s) pending",
            detail: "Review queue output",
            path: "memory/projects/growth-foundation/weekly/2026-03-06-weekly-review.md",
            source: "weekly",
          },
        ],
        watch: [],
        reviewCount: 1,
        completedReviewCount: 0,
        alertsPath: "memory/projects/growth-foundation/alerts/current.md",
        actionsPath: "memory/projects/growth-foundation/actions/current.md",
        completedHistoryPath: null,
        heartbeatPath: "memory/projects/growth-foundation/heartbeat/2026-03-06.md",
        weeklyReviewPath: "memory/projects/growth-foundation/weekly/2026-03-06-weekly-review.md",
        codexSmokeStatus: "scheduled",
        codexSmokePeriod: "2026-W10",
        codexSmokeJobId: "scheduled-codex-patch-20260306",
        codexSmokeUpdatedAt: "2026-03-06T15:10:00+09:00",
        codexSmokeStatePath:
          "memory/projects/growth-foundation/automation/codex-patch-smoke-state.json",
        codexReviewSmokeStatus: "scheduled",
        codexReviewSmokePeriod: "2026-W10",
        codexReviewSmokeJobId: "scheduled-codex-review-20260306",
        codexReviewSmokeSourceJobId: "scheduled-codex-patch-20260306",
        codexReviewSmokeUpdatedAt: "2026-03-06T15:40:00+09:00",
        codexReviewSmokeStatePath:
          "memory/projects/growth-foundation/automation/codex-patch-smoke-review-state.json",
        codexReviewSmokeDiffPath:
          "projects/growth-foundation/evidence/2026-03-06_scheduled-codex-review-smoke/scheduled-codex-patch-20260306.diff.patch",
        codexReviewSmokeBackfillCount: 1,
        codexReviewSmokeBackfillItems: [
          {
            period: "2026-W08",
            jobId: "manual-backfill-codex-review-2026w08",
            requestedAt: "2026-03-06T16:05:00+09:00",
            reason: "WSL downtime skipped the reviewer timer",
            sourceJobId: "manual-backfill-codex-patch-2026w08",
            sourceOrigin: "patch-backfill",
            diffRelpath:
              "projects/growth-foundation/evidence/2026-03-06_manual-backfill-codex-review-smoke/manual-backfill-codex-patch-2026w08.diff.patch",
            jobPath: "queue/jobs/queued/manual-backfill-codex-review-2026w08.json",
            evidencePath: null,
          },
        ],
        codexReviewSmokeBackfillStatePath:
          "memory/projects/growth-foundation/automation/codex-patch-smoke-review-backfill-state.json",
        codexSmokeBackfillCount: 1,
        codexSmokeBackfillItems: [
          {
            period: "2026-W08",
            jobId: "manual-backfill-codex-patch-2026w08",
            requestedAt: "2026-03-06T15:30:00+09:00",
            reason: "WSL downtime skipped the weekly timer",
            jobPath: "queue/jobs/queued/manual-backfill-codex-patch-2026w08.json",
            evidencePath: null,
          },
        ],
        codexSmokeBackfillStatePath:
          "memory/projects/growth-foundation/automation/codex-patch-smoke-backfill-state.json",
        githubSyncStatus: "synced",
        githubSyncIssueCount: 1,
        githubSyncUpdatedAt: "2026-03-06T17:00:00+09:00",
        githubSyncCurrentPath: "memory/projects/growth-foundation/github/current.md",
        githubProjectStatus: "synced",
        githubProjectTitle: "Growth Foundation",
        githubProjectUrl: "https://github.com/users/yui-stingray/projects/1",
        githubProjectItemCount: 1,
        githubWritebackStatus: "applied",
        githubWritebackIssueRef: "yui-stingray/growth-foundation#10",
        githubWritebackActions: ["comment"],
        githubWritebackCloseIssue: false,
        githubWritebackOperator: "yui",
        githubWritebackProposalUpdatedAt: "2026-03-06T17:15:00+09:00",
        githubWritebackReceiptAppliedAt: "2026-03-06T17:20:00+09:00",
        githubWritebackProposalPath:
          "memory/projects/growth-foundation/github-writeback/current-proposal.json",
        githubWritebackReceiptPath:
          "memory/projects/growth-foundation/github-writeback/receipts/2026-03-06-issue-10.json",
        issueFlowStatus: "needs-review",
        issueFlowStage: "outcome",
        issueFlowIssueNumber: 17,
        issueFlowIssueRef: "yui-stingray/growth-foundation#17",
        issueFlowUpdatedAt: "2026-03-07T21:47:50+09:00",
        issueFlowDirectoryPath: "memory/projects/growth-foundation/issue-flow/issue-17",
        issueFlowPreflightStatus: "synced",
        issueFlowDraftStatus: "approved-for-proposal",
        issueFlowProposalStatus: "ready-for-manual-enqueue",
        issueFlowEnqueueStatus: "enqueued",
        issueFlowOutcomeStatus: "needs-review",
        issueFlowPreflightPath:
          "memory/projects/growth-foundation/issue-flow/issue-17/preflight.json",
        issueFlowDraftPath:
          "memory/projects/growth-foundation/issue-flow/issue-17/orchestrator-draft.json",
        issueFlowProposalPath:
          "memory/projects/growth-foundation/issue-flow/issue-17/queue-proposal.json",
        issueFlowReceiptPath:
          "memory/projects/growth-foundation/issue-flow/issue-17/enqueue-receipt.json",
        issueFlowOutcomePath:
          "memory/projects/growth-foundation/issue-flow/issue-17/outcome-bundle.json",
        issueFlowPrimaryResultPath: "queue/results/issue-17-live-operator-run-v2.json",
        issueFlowActiveCount: 2,
        issueFlowRecentCount: 1,
        issueFlowRecentItems: [
          {
            issueNumber: 16,
            issueRef: "yui-stingray/growth-foundation#16",
            stage: "outcome",
            status: "delivered",
            updatedAt: "2026-03-07T20:47:50+09:00",
            directoryPath: "memory/projects/growth-foundation/issue-flow/issue-16",
            preflightStatus: "synced",
            draftStatus: "approved-for-proposal",
            proposalStatus: "missing",
            enqueueStatus: "missing",
            outcomeStatus: "delivered",
            preflightPath: "memory/projects/growth-foundation/issue-flow/issue-16/preflight.json",
            draftPath:
              "memory/projects/growth-foundation/issue-flow/issue-16/orchestrator-draft.json",
            proposalPath: null,
            receiptPath: null,
            outcomePath:
              "memory/projects/growth-foundation/issue-flow/issue-16/outcome-bundle.json",
            primaryResultPath: "queue/results/issue-16-live-operator-run-v1.json",
          },
        ],
        issueFlowArchivedCount: 1,
        issueFlowArchiveRootPath: "memory/projects/growth-foundation/issue-flow/archive",
        issueFlowArchivedLatestIssueRef: "yui-stingray/growth-foundation#15",
        issueFlowArchivedLatestArchivedAt: "2026-03-06T20:00:00+09:00",
        issueFlowArchivedLatestPath:
          "memory/projects/growth-foundation/issue-flow/archive/issue-15--20260306T000000Z",
        issueFlowArchivedLatestReceiptPath:
          "memory/projects/growth-foundation/issue-flow/archive/issue-15--20260306T000000Z/archive-receipt.json",
        issueFlowVisibilityStatus: "state-drift",
        issueFlowVisibilityReason:
          "The latest issue-flow issue is absent from the current open-issue sync.",
        issueFlowVisibilityOpenIssue: false,
        issueFlowVisibilityGithubSyncUpdatedAt: "2026-03-06T17:00:00+09:00",
        relayStatus: "approval-required",
        relayChannel: "discord",
        relayMode: "approval-required",
        relayCandidateCount: 1,
        relayUpdatedAt: "2026-03-06T17:05:00+09:00",
        relayCurrentPath: "memory/projects/growth-foundation/relay/current.md",
      }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const state = {
      basePath: "/openclaw",
      growthFoundation: null,
    };

    await loadGrowthFoundationSummary(state);

    expect(fetchMock).toHaveBeenCalledWith(
      `/openclaw${CONTROL_UI_GROWTH_FOUNDATION_PATH}`,
      expect.objectContaining({ method: "GET" }),
    );
    expect(state.growthFoundation?.projectId).toBe("growth-foundation");
    expect(state.growthFoundation?.reviewCount).toBe(1);
    expect(state.growthFoundation?.githubWritebackStatus).toBe("applied");
    expect(state.growthFoundation?.issueFlowStatus).toBe("needs-review");
    expect(state.growthFoundation?.issueFlowIssueRef).toBe("yui-stingray/growth-foundation#17");
    expect(state.growthFoundation?.issueFlowActiveCount).toBe(2);
    expect(state.growthFoundation?.issueFlowRecentItems).toHaveLength(1);
    expect(state.growthFoundation?.issueFlowRecentItems?.[0]?.issueRef).toBe(
      "yui-stingray/growth-foundation#16",
    );
    expect(state.growthFoundation?.issueFlowArchivedCount).toBe(1);
    expect(state.growthFoundation?.issueFlowArchivedLatestIssueRef).toBe(
      "yui-stingray/growth-foundation#15",
    );
    expect(state.growthFoundation?.issueFlowVisibilityStatus).toBe("state-drift");

    vi.unstubAllGlobals();
  });

  it("keeps the prior state on failed fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const state = {
      basePath: "",
      growthFoundation: {
        available: true,
        projectId: "growth-foundation",
        workspaceProjectId: "2026-03-06_growth-foundation",
        alertStatus: "clear",
        alertTransition: "steady-clear",
        alertUpdatedAt: null,
        actionsStatus: "actionable",
        actionsUpdatedAt: null,
        priorityNow: [],
        thisWeek: [],
        thisWeekItems: [],
        completedThisWeekItems: [],
        completedHistoryItems: [],
        notificationStatus: "clear",
        notificationCount: 0,
        notificationItems: [],
        watch: [],
        reviewCount: 0,
        completedReviewCount: 0,
        alertsPath: null,
        actionsPath: null,
        completedHistoryPath: null,
        heartbeatPath: null,
        weeklyReviewPath: null,
        codexSmokeStatus: "missing",
        codexSmokePeriod: null,
        codexSmokeJobId: null,
        codexSmokeUpdatedAt: null,
        codexSmokeStatePath: null,
        codexReviewSmokeStatus: "missing",
        codexReviewSmokePeriod: null,
        codexReviewSmokeJobId: null,
        codexReviewSmokeSourceJobId: null,
        codexReviewSmokeUpdatedAt: null,
        codexReviewSmokeStatePath: null,
        codexReviewSmokeDiffPath: null,
        codexReviewSmokeBackfillCount: 0,
        codexReviewSmokeBackfillItems: [],
        codexReviewSmokeBackfillStatePath: null,
        codexSmokeBackfillCount: 0,
        codexSmokeBackfillItems: [],
        codexSmokeBackfillStatePath: null,
        githubSyncStatus: "missing",
        githubSyncIssueCount: 0,
        githubSyncUpdatedAt: null,
        githubSyncCurrentPath: null,
        githubProjectStatus: "missing",
        githubProjectTitle: null,
        githubProjectUrl: null,
        githubProjectItemCount: 0,
        githubWritebackStatus: "missing",
        githubWritebackIssueRef: null,
        githubWritebackActions: [],
        githubWritebackCloseIssue: false,
        githubWritebackOperator: null,
        githubWritebackProposalUpdatedAt: null,
        githubWritebackReceiptAppliedAt: null,
        githubWritebackProposalPath: null,
        githubWritebackReceiptPath: null,
        relayStatus: "missing",
        relayChannel: null,
        relayMode: null,
        relayCandidateCount: 0,
        relayUpdatedAt: null,
        relayCurrentPath: null,
      },
    };

    await loadGrowthFoundationSummary(state);

    expect(fetchMock).toHaveBeenCalledWith(
      CONTROL_UI_GROWTH_FOUNDATION_PATH,
      expect.objectContaining({ method: "GET" }),
    );
    expect(state.growthFoundation?.projectId).toBe("growth-foundation");
    expect(state.growthFoundation?.githubWritebackStatus).toBe("missing");

    vi.unstubAllGlobals();
  });

  it("loads the growth foundation summary from the active gateway when gatewayUrl is cross-origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ available: true, projectId: "growth-foundation", reviewCount: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const state = {
      basePath: "/openclaw",
      settings: { gatewayUrl: "wss://gateway.example.com/openclaw", token: "shared-token" },
      growthFoundation: null,
    };

    await loadGrowthFoundationSummary(state);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example.com/openclaw/__openclaw/growth-foundation.json",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/json",
          Authorization: "Bearer shared-token",
        }),
      }),
    );
    expect(state.growthFoundation?.projectId).toBe("growth-foundation");

    vi.unstubAllGlobals();
  });

  it("submits a review action and updates the snapshot", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        action: "complete",
        itemKey: "item-1",
        snapshot: {
          available: true,
          projectId: "growth-foundation",
          workspaceProjectId: "2026-03-06_growth-foundation",
          alertStatus: "clear",
          alertTransition: "steady-clear",
          alertUpdatedAt: null,
          actionsStatus: "actionable",
          actionsUpdatedAt: "2026-03-06T14:00:00+09:00",
          priorityNow: [],
          thisWeek: [],
          thisWeekItems: [],
          completedThisWeekItems: [
            {
              key: "item-1",
              text: "Review queue output",
              display: "Review queue output",
              completedAt: "2026-03-06T14:00:00+09:00",
              source: "control-ui",
            },
          ],
          completedHistoryItems: [
            {
              timestamp: "2026-03-06T14:00:00+09:00",
              action: "complete",
              itemKey: "item-1",
              weekly: "2026-03-06-weekly-review.md",
              source: "control-ui",
              text: "Review queue output",
            },
          ],
          notificationStatus: "clear",
          notificationCount: 0,
          notificationItems: [],
          watch: [],
          reviewCount: 0,
          completedReviewCount: 1,
          alertsPath: null,
          actionsPath: null,
          completedHistoryPath: "memory/projects/growth-foundation/actions/completed/2026-03-06.md",
          heartbeatPath: null,
          weeklyReviewPath: null,
          codexSmokeStatus: "scheduled",
          codexSmokePeriod: "2026-W10",
          codexSmokeJobId: "scheduled-codex-patch-20260306",
          codexSmokeUpdatedAt: "2026-03-06T15:10:00+09:00",
          codexSmokeStatePath:
            "memory/projects/growth-foundation/automation/codex-patch-smoke-state.json",
          codexReviewSmokeStatus: "scheduled",
          codexReviewSmokePeriod: "2026-W10",
          codexReviewSmokeJobId: "scheduled-codex-review-20260306",
          codexReviewSmokeSourceJobId: "scheduled-codex-patch-20260306",
          codexReviewSmokeUpdatedAt: "2026-03-06T15:40:00+09:00",
          codexReviewSmokeStatePath:
            "memory/projects/growth-foundation/automation/codex-patch-smoke-review-state.json",
          codexReviewSmokeDiffPath:
            "projects/growth-foundation/evidence/2026-03-06_scheduled-codex-review-smoke/scheduled-codex-patch-20260306.diff.patch",
          codexReviewSmokeBackfillCount: 1,
          codexReviewSmokeBackfillItems: [
            {
              period: "2026-W08",
              jobId: "manual-backfill-codex-review-2026w08",
              requestedAt: "2026-03-06T16:05:00+09:00",
              reason: "WSL downtime skipped the reviewer timer",
              sourceJobId: "manual-backfill-codex-patch-2026w08",
              sourceOrigin: "patch-backfill",
              diffRelpath:
                "projects/growth-foundation/evidence/2026-03-06_manual-backfill-codex-review-smoke/manual-backfill-codex-patch-2026w08.diff.patch",
              jobPath: "queue/jobs/queued/manual-backfill-codex-review-2026w08.json",
              evidencePath: null,
            },
          ],
          codexReviewSmokeBackfillStatePath:
            "memory/projects/growth-foundation/automation/codex-patch-smoke-review-backfill-state.json",
          codexSmokeBackfillCount: 1,
          codexSmokeBackfillItems: [
            {
              period: "2026-W08",
              jobId: "manual-backfill-codex-patch-2026w08",
              requestedAt: "2026-03-06T15:30:00+09:00",
              reason: "WSL downtime skipped the weekly timer",
              jobPath: "queue/jobs/queued/manual-backfill-codex-patch-2026w08.json",
              evidencePath: null,
            },
          ],
          codexSmokeBackfillStatePath:
            "memory/projects/growth-foundation/automation/codex-patch-smoke-backfill-state.json",
          githubSyncStatus: "synced",
          githubSyncIssueCount: 1,
          githubSyncUpdatedAt: "2026-03-06T17:00:00+09:00",
          githubSyncCurrentPath: "memory/projects/growth-foundation/github/current.md",
          githubProjectStatus: "synced",
          githubProjectTitle: "Growth Foundation",
          githubProjectUrl: "https://github.com/users/yui-stingray/projects/1",
          githubProjectItemCount: 1,
          githubWritebackStatus: "applied",
          githubWritebackIssueRef: "yui-stingray/growth-foundation#10",
          githubWritebackActions: ["comment"],
          githubWritebackCloseIssue: false,
          githubWritebackOperator: "yui",
          githubWritebackProposalUpdatedAt: "2026-03-06T17:15:00+09:00",
          githubWritebackReceiptAppliedAt: "2026-03-06T17:20:00+09:00",
          githubWritebackProposalPath:
            "memory/projects/growth-foundation/github-writeback/current-proposal.json",
          githubWritebackReceiptPath:
            "memory/projects/growth-foundation/github-writeback/receipts/2026-03-06-issue-10.json",
          issueFlowVisibilityStatus: "state-drift",
          issueFlowVisibilityReason:
            "The latest issue-flow issue is absent from the current open-issue sync.",
          issueFlowVisibilityOpenIssue: false,
          issueFlowVisibilityGithubSyncUpdatedAt: "2026-03-06T17:00:00+09:00",
          relayStatus: "approval-required",
          relayChannel: "discord",
          relayMode: "approval-required",
          relayCandidateCount: 1,
          relayUpdatedAt: "2026-03-06T17:05:00+09:00",
          relayCurrentPath: "memory/projects/growth-foundation/relay/current.md",
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const state = {
      basePath: "/openclaw",
      growthFoundation: {
        available: true,
        projectId: "growth-foundation",
        workspaceProjectId: "2026-03-06_growth-foundation",
        alertStatus: "clear",
        alertTransition: "steady-clear",
        alertUpdatedAt: null,
        actionsStatus: "actionable",
        actionsUpdatedAt: null,
        priorityNow: [],
        thisWeek: ["Review queue output"],
        thisWeekItems: [
          {
            key: "item-1",
            text: "Review queue output",
            display: "Review queue output",
            completedAt: null,
            source: null,
          },
        ],
        completedThisWeekItems: [],
        completedHistoryItems: [],
        notificationStatus: "clear",
        notificationCount: 0,
        notificationItems: [],
        watch: [],
        reviewCount: 1,
        completedReviewCount: 0,
        alertsPath: null,
        actionsPath: null,
        completedHistoryPath: null,
        heartbeatPath: null,
        weeklyReviewPath: null,
        codexSmokeStatus: "missing",
        codexSmokePeriod: null,
        codexSmokeJobId: null,
        codexSmokeUpdatedAt: null,
        codexSmokeStatePath: null,
        codexReviewSmokeStatus: "missing",
        codexReviewSmokePeriod: null,
        codexReviewSmokeJobId: null,
        codexReviewSmokeSourceJobId: null,
        codexReviewSmokeUpdatedAt: null,
        codexReviewSmokeStatePath: null,
        codexReviewSmokeDiffPath: null,
        codexReviewSmokeBackfillCount: 0,
        codexReviewSmokeBackfillItems: [],
        codexReviewSmokeBackfillStatePath: null,
        codexSmokeBackfillCount: 0,
        codexSmokeBackfillItems: [],
        codexSmokeBackfillStatePath: null,
        githubSyncStatus: "missing",
        githubSyncIssueCount: 0,
        githubSyncUpdatedAt: null,
        githubSyncCurrentPath: null,
        githubProjectStatus: "missing",
        githubProjectTitle: null,
        githubProjectUrl: null,
        githubProjectItemCount: 0,
        githubWritebackStatus: "missing",
        githubWritebackIssueRef: null,
        githubWritebackActions: [],
        githubWritebackCloseIssue: false,
        githubWritebackOperator: null,
        githubWritebackProposalUpdatedAt: null,
        githubWritebackReceiptAppliedAt: null,
        githubWritebackProposalPath: null,
        githubWritebackReceiptPath: null,
        issueFlowVisibilityStatus: "missing",
        issueFlowVisibilityReason: null,
        issueFlowVisibilityOpenIssue: null,
        issueFlowVisibilityGithubSyncUpdatedAt: null,
        relayStatus: "missing",
        relayChannel: null,
        relayMode: null,
        relayCandidateCount: 0,
        relayUpdatedAt: null,
        relayCurrentPath: null,
      },
      growthFoundationActionBusyKey: null,
      growthFoundationActionError: null,
    };

    await submitGrowthFoundationReviewAction(state, { action: "complete", itemKey: "item-1" });

    expect(fetchMock).toHaveBeenCalledWith(
      `/openclaw${CONTROL_UI_GROWTH_REVIEW_ACTION_PATH}`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "complete",
          itemKey: "item-1",
          projectId: "2026-03-06_growth-foundation",
        }),
      }),
    );
    expect(state.growthFoundation?.reviewCount).toBe(0);
    expect(state.growthFoundation?.completedReviewCount).toBe(1);
    expect(state.growthFoundation?.githubWritebackStatus).toBe("applied");
    expect(state.growthFoundationActionBusyKey).toBeNull();
    expect(state.growthFoundationActionError).toBeNull();

    vi.unstubAllGlobals();
  });

  it("submits review actions to the active gateway when gatewayUrl is cross-origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        action: "complete",
        itemKey: "item-1",
        snapshot: { available: true, projectId: "growth-foundation", reviewCount: 0 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const state = {
      basePath: "/openclaw",
      settings: { gatewayUrl: "wss://gateway.example.com/openclaw", token: "shared-token" },
      growthFoundation: {
        available: true,
        projectId: "growth-foundation",
        workspaceProjectId: "2026-03-06_growth-foundation",
      },
      growthFoundationActionBusyKey: null,
      growthFoundationActionError: null,
    };

    await submitGrowthFoundationReviewAction(state, { action: "complete", itemKey: "item-1" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://gateway.example.com/openclaw/__openclaw/growth-foundation/review-action",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: "Bearer shared-token",
        }),
        body: JSON.stringify({
          action: "complete",
          itemKey: "item-1",
          projectId: "2026-03-06_growth-foundation",
        }),
      }),
    );
    expect(state.growthFoundation?.projectId).toBe("growth-foundation");
    expect(state.growthFoundationActionError).toBeNull();

    vi.unstubAllGlobals();
  });

  it("captures review action failures without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        success: false,
        action: "complete",
        itemKey: "item-1",
        snapshot: null,
        error: "growth foundation snapshot unavailable",
      }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const state = {
      basePath: "",
      growthFoundation: {
        available: true,
        projectId: "growth-foundation",
        workspaceProjectId: "2026-03-06_growth-foundation",
        alertStatus: "clear",
        alertTransition: "steady-clear",
        alertUpdatedAt: null,
        actionsStatus: "actionable",
        actionsUpdatedAt: null,
        priorityNow: [],
        thisWeek: ["Review queue output"],
        thisWeekItems: [
          {
            key: "item-1",
            text: "Review queue output",
            display: "Review queue output",
            completedAt: null,
            source: null,
          },
        ],
        completedThisWeekItems: [],
        completedHistoryItems: [],
        notificationStatus: "clear",
        notificationCount: 0,
        notificationItems: [],
        watch: [],
        reviewCount: 1,
        completedReviewCount: 0,
        alertsPath: null,
        actionsPath: null,
        completedHistoryPath: null,
        heartbeatPath: null,
        weeklyReviewPath: null,
        codexSmokeStatus: "missing",
        codexSmokePeriod: null,
        codexSmokeJobId: null,
        codexSmokeUpdatedAt: null,
        codexSmokeStatePath: null,
        codexReviewSmokeStatus: "missing",
        codexReviewSmokePeriod: null,
        codexReviewSmokeJobId: null,
        codexReviewSmokeSourceJobId: null,
        codexReviewSmokeUpdatedAt: null,
        codexReviewSmokeStatePath: null,
        codexReviewSmokeDiffPath: null,
        codexReviewSmokeBackfillCount: 0,
        codexReviewSmokeBackfillItems: [],
        codexReviewSmokeBackfillStatePath: null,
        codexSmokeBackfillCount: 0,
        codexSmokeBackfillItems: [],
        codexSmokeBackfillStatePath: null,
        githubSyncStatus: "missing",
        githubSyncIssueCount: 0,
        githubSyncUpdatedAt: null,
        githubSyncCurrentPath: null,
        githubProjectStatus: "missing",
        githubProjectTitle: null,
        githubProjectUrl: null,
        githubProjectItemCount: 0,
        githubWritebackStatus: "missing",
        githubWritebackIssueRef: null,
        githubWritebackActions: [],
        githubWritebackCloseIssue: false,
        githubWritebackOperator: null,
        githubWritebackProposalUpdatedAt: null,
        githubWritebackReceiptAppliedAt: null,
        githubWritebackProposalPath: null,
        githubWritebackReceiptPath: null,
        issueFlowVisibilityStatus: "missing",
        issueFlowVisibilityReason: null,
        issueFlowVisibilityOpenIssue: null,
        issueFlowVisibilityGithubSyncUpdatedAt: null,
        relayStatus: "missing",
        relayChannel: null,
        relayMode: null,
        relayCandidateCount: 0,
        relayUpdatedAt: null,
        relayCurrentPath: null,
      },
      growthFoundationActionBusyKey: null,
      growthFoundationActionError: null,
    };

    await expect(
      submitGrowthFoundationReviewAction(state, { action: "complete", itemKey: "item-1" }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith(
      CONTROL_UI_GROWTH_REVIEW_ACTION_PATH,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "complete",
          itemKey: "item-1",
          projectId: "2026-03-06_growth-foundation",
        }),
      }),
    );
    expect(state.growthFoundation?.reviewCount).toBe(1);
    expect(state.growthFoundationActionBusyKey).toBeNull();
    expect(state.growthFoundationActionError).toBe("growth foundation snapshot unavailable");

    vi.unstubAllGlobals();
  });

  it("ignores concurrent review action submissions while one is already running", async () => {
    let resolveFetch:
      | ((value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void)
      | null = null;
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const state = {
      basePath: "",
      growthFoundation: {
        available: true,
        projectId: "growth-foundation",
        workspaceProjectId: "2026-03-06_growth-foundation",
        alertStatus: "clear",
        alertTransition: "steady-clear",
        alertUpdatedAt: null,
        actionsStatus: "actionable",
        actionsUpdatedAt: null,
        priorityNow: [],
        thisWeek: ["Review queue output"],
        thisWeekItems: [
          {
            key: "item-1",
            text: "Review queue output",
            display: "Review queue output",
            completedAt: null,
            source: null,
          },
        ],
        completedThisWeekItems: [
          {
            key: "item-2",
            text: "Already reviewed",
            display: "Already reviewed",
            completedAt: "2026-03-06T14:00:00+09:00",
            source: "mission-control",
          },
        ],
        completedHistoryItems: [],
        notificationStatus: "clear",
        notificationCount: 0,
        notificationItems: [],
        watch: [],
        reviewCount: 1,
        completedReviewCount: 1,
        alertsPath: null,
        actionsPath: null,
        completedHistoryPath: null,
        heartbeatPath: null,
        weeklyReviewPath: null,
        codexSmokeStatus: "missing",
        codexSmokePeriod: null,
        codexSmokeJobId: null,
        codexSmokeUpdatedAt: null,
        codexSmokeStatePath: null,
        codexReviewSmokeStatus: "missing",
        codexReviewSmokePeriod: null,
        codexReviewSmokeJobId: null,
        codexReviewSmokeSourceJobId: null,
        codexReviewSmokeUpdatedAt: null,
        codexReviewSmokeStatePath: null,
        codexReviewSmokeDiffPath: null,
        codexReviewSmokeBackfillCount: 0,
        codexReviewSmokeBackfillItems: [],
        codexReviewSmokeBackfillStatePath: null,
        codexSmokeBackfillCount: 0,
        codexSmokeBackfillItems: [],
        codexSmokeBackfillStatePath: null,
        githubSyncStatus: "missing",
        githubSyncIssueCount: 0,
        githubSyncUpdatedAt: null,
        githubSyncCurrentPath: null,
        githubProjectStatus: "missing",
        githubProjectTitle: null,
        githubProjectUrl: null,
        githubProjectItemCount: 0,
        githubWritebackStatus: "missing",
        githubWritebackIssueRef: null,
        githubWritebackActions: [],
        githubWritebackCloseIssue: false,
        githubWritebackOperator: null,
        githubWritebackProposalUpdatedAt: null,
        githubWritebackReceiptAppliedAt: null,
        githubWritebackProposalPath: null,
        githubWritebackReceiptPath: null,
        issueFlowVisibilityStatus: "missing",
        issueFlowVisibilityReason: null,
        issueFlowVisibilityOpenIssue: null,
        issueFlowVisibilityGithubSyncUpdatedAt: null,
        relayStatus: "missing",
        relayChannel: null,
        relayMode: null,
        relayCandidateCount: 0,
        relayUpdatedAt: null,
        relayCurrentPath: null,
      },
      growthFoundationActionBusyKey: null,
      growthFoundationActionError: null,
    };

    const first = submitGrowthFoundationReviewAction(state, {
      action: "complete",
      itemKey: "item-1",
    });
    expect(state.growthFoundationActionBusyKey).toBe("item-1");

    await expect(
      submitGrowthFoundationReviewAction(state, { action: "reopen", itemKey: "item-2" }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch?.({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        action: "complete",
        itemKey: "item-1",
        snapshot: {
          ...state.growthFoundation,
          reviewCount: 0,
          completedReviewCount: 2,
        },
      }),
    });
    await first;

    expect(state.growthFoundationActionBusyKey).toBeNull();
    expect(state.growthFoundation?.reviewCount).toBe(0);
    expect(state.growthFoundation?.completedReviewCount).toBe(2);

    vi.unstubAllGlobals();
  });
});
