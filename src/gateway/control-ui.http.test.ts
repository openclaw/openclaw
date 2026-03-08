import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  CONTROL_UI_GROWTH_FILE_PATH,
  CONTROL_UI_GROWTH_FOUNDATION_PATH,
  CONTROL_UI_GROWTH_REVIEW_ACTION_PATH,
} from "./control-ui-contract.js";
import { handleControlUiAvatarRequest, handleControlUiHttpRequest } from "./control-ui.js";
import { makeMockHttpResponse } from "./test-http-response.js";

describe("handleControlUiHttpRequest", () => {
  async function withControlUiRoot<T>(params: {
    indexHtml?: string;
    fn: (tmp: string) => Promise<T>;
  }) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
    try {
      await fs.writeFile(path.join(tmp, "index.html"), params.indexHtml ?? "<html></html>\n");
      return await params.fn(tmp);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  function parseBootstrapPayload(end: ReturnType<typeof makeMockHttpResponse>["end"]) {
    return JSON.parse(String(end.mock.calls[0]?.[0] ?? "")) as {
      basePath: string;
      assistantName: string;
      assistantAvatar: string;
      assistantAgentId: string;
    };
  }

  function parseGrowthPayload(end: ReturnType<typeof makeMockHttpResponse>["end"]) {
    return JSON.parse(String(end.mock.calls[0]?.[0] ?? "")) as {
      available: boolean;
      projectId: string | null;
      workspaceProjectId?: string | null;
      alertStatus: string;
      actionsStatus: string;
      reviewCount: number;
      thisWeek: string[];
      thisWeekItems: Array<{ key: string; display: string }>;
      completedThisWeekItems: Array<{ key: string; display: string }>;
      completedHistoryItems: Array<{
        action: string;
        itemKey: string;
        text: string;
        weeklyPath: string | null;
      }>;
      notificationStatus: string;
      notificationCount: number;
      notificationItems: Array<{
        id: string;
        severity: string;
        title: string;
        detail: string;
        path: string | null;
      }>;
      completedReviewCount: number;
      alertsPath?: string | null;
      heartbeatPath?: string | null;
      completedHistoryPath: string | null;
      weeklyReviewPath: string | null;
      codexSmokeStatus: string;
      codexSmokePeriod: string | null;
      codexSmokeJobId: string | null;
      codexSmokeUpdatedAt: string | null;
      codexSmokeStatePath: string | null;
      codexReviewSmokeStatus: string;
      codexReviewSmokePeriod: string | null;
      codexReviewSmokeJobId: string | null;
      codexReviewSmokeSourceJobId: string | null;
      codexReviewSmokeUpdatedAt: string | null;
      codexReviewSmokeStatePath: string | null;
      codexReviewSmokeDiffPath: string | null;
      codexReviewSmokeBackfillCount: number;
      codexReviewSmokeBackfillItems: Array<{
        period: string;
        jobId: string | null;
        requestedAt: string | null;
        reason: string | null;
        sourceJobId: string | null;
        sourceOrigin: string | null;
        diffRelpath: string | null;
      }>;
      codexReviewSmokeBackfillStatePath: string | null;
      codexSmokeBackfillCount: number;
      codexSmokeBackfillItems: Array<{
        period: string;
        jobId: string | null;
        requestedAt: string | null;
        reason: string | null;
      }>;
      codexSmokeBackfillStatePath: string | null;
      githubSyncStatus: string;
      githubSyncIssueCount: number;
      githubSyncUpdatedAt: string | null;
      githubSyncCurrentPath: string | null;
      githubProjectStatus: string;
      githubProjectTitle: string | null;
      githubProjectUrl: string | null;
      githubProjectItemCount: number;
      githubWritebackStatus: string;
      githubWritebackIssueRef: string | null;
      githubWritebackActions: string[];
      githubWritebackCloseIssue: boolean;
      githubWritebackOperator: string | null;
      githubWritebackProposalUpdatedAt: string | null;
      githubWritebackReceiptAppliedAt: string | null;
      githubWritebackProposalPath: string | null;
      githubWritebackReceiptPath: string | null;
      issueFlowStatus?: string;
      issueFlowStage?: string | null;
      issueFlowIssueNumber?: number | null;
      issueFlowIssueRef?: string | null;
      issueFlowUpdatedAt?: string | null;
      issueFlowDirectoryPath?: string | null;
      issueFlowPreflightStatus?: string;
      issueFlowDraftStatus?: string;
      issueFlowProposalStatus?: string;
      issueFlowEnqueueStatus?: string;
      issueFlowOutcomeStatus?: string;
      issueFlowPreflightPath?: string | null;
      issueFlowDraftPath?: string | null;
      issueFlowProposalPath?: string | null;
      issueFlowReceiptPath?: string | null;
      issueFlowOutcomePath?: string | null;
      issueFlowPrimaryResultPath?: string | null;
      issueFlowActiveCount?: number;
      issueFlowRecentCount?: number;
      issueFlowRecentItems?: Array<{
        issueNumber: number;
        issueRef: string | null;
        stage: string | null;
        status: string;
        updatedAt: string | null;
        directoryPath: string;
        outcomePath: string | null;
        primaryResultPath: string | null;
      }>;
      issueFlowArchivedCount?: number;
      issueFlowArchiveRootPath?: string | null;
      issueFlowArchivedLatestIssueRef?: string | null;
      issueFlowArchivedLatestArchivedAt?: string | null;
      issueFlowArchivedLatestPath?: string | null;
      issueFlowArchivedLatestReceiptPath?: string | null;
      issueFlowVisibilityStatus?: string;
      issueFlowVisibilityReason?: string | null;
      issueFlowVisibilityOpenIssue?: boolean | null;
      issueFlowVisibilityGithubSyncUpdatedAt?: string | null;
      relayStatus: string;
      relayChannel: string | null;
      relayMode: string | null;
      relayCandidateCount: number;
      relayUpdatedAt: string | null;
      relayCurrentPath: string | null;
    };
  }

  function makePostRequest(url: string, payload: Record<string, unknown>) {
    const req = new EventEmitter() as IncomingMessage & {
      setEncoding: ReturnType<typeof vi.fn>;
    };
    req.url = url;
    req.method = "POST";
    req.setEncoding = vi.fn();
    queueMicrotask(() => {
      req.emit("data", JSON.stringify(payload));
      req.emit("end");
    });
    return req;
  }

  function expectNotFoundResponse(params: {
    handled: boolean;
    res: ReturnType<typeof makeMockHttpResponse>["res"];
    end: ReturnType<typeof makeMockHttpResponse>["end"];
  }) {
    expect(params.handled).toBe(true);
    expect(params.res.statusCode).toBe(404);
    expect(params.end).toHaveBeenCalledWith("Not Found");
  }

  function runControlUiRequest(params: {
    url: string;
    method: "GET" | "HEAD" | "POST";
    rootPath: string;
    basePath?: string;
    rootKind?: "resolved" | "bundled";
  }) {
    const { res, end } = makeMockHttpResponse();
    const handled = handleControlUiHttpRequest(
      { url: params.url, method: params.method } as IncomingMessage,
      res,
      {
        ...(params.basePath ? { basePath: params.basePath } : {}),
        root: { kind: params.rootKind ?? "resolved", path: params.rootPath },
      },
    );
    return { res, end, handled };
  }

  function runAvatarRequest(params: {
    url: string;
    method: "GET" | "HEAD";
    resolveAvatar: Parameters<typeof handleControlUiAvatarRequest>[2]["resolveAvatar"];
    basePath?: string;
  }) {
    const { res, end } = makeMockHttpResponse();
    const handled = handleControlUiAvatarRequest(
      { url: params.url, method: params.method } as IncomingMessage,
      res,
      {
        ...(params.basePath ? { basePath: params.basePath } : {}),
        resolveAvatar: params.resolveAvatar,
      },
    );
    return { res, end, handled };
  }

  async function writeAssetFile(rootPath: string, filename: string, contents: string) {
    const assetsDir = path.join(rootPath, "assets");
    await fs.mkdir(assetsDir, { recursive: true });
    const filePath = path.join(assetsDir, filename);
    await fs.writeFile(filePath, contents);
    return { assetsDir, filePath };
  }

  async function withBasePathRootFixture<T>(params: {
    siblingDir: string;
    fn: (paths: { root: string; sibling: string }) => Promise<T>;
  }) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-root-"));
    try {
      const root = path.join(tmp, "ui");
      const sibling = path.join(tmp, params.siblingDir);
      await fs.mkdir(root, { recursive: true });
      await fs.mkdir(sibling, { recursive: true });
      await fs.writeFile(path.join(root, "index.html"), "<html>ok</html>\n");
      return await params.fn({ root, sibling });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }

  it("sets security headers for Control UI responses", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, setHeader } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          { url: "/", method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
          },
        );
        expect(handled).toBe(true);
        expect(setHeader).toHaveBeenCalledWith("X-Frame-Options", "DENY");
        const csp = setHeader.mock.calls.find((call) => call[0] === "Content-Security-Policy")?.[1];
        expect(typeof csp).toBe("string");
        expect(String(csp)).toContain("frame-ancestors 'none'");
        expect(String(csp)).toContain("script-src 'self'");
        expect(String(csp)).not.toContain("script-src 'self' 'unsafe-inline'");
      },
    });
  });

  it("does not inject inline scripts into index.html", async () => {
    const html = "<html><head></head><body>Hello</body></html>\n";
    await withControlUiRoot({
      indexHtml: html,
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          { url: "/", method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: {
              agents: { defaults: { workspace: tmp } },
              ui: { assistant: { name: "</script><script>alert(1)//", avatar: "evil.png" } },
            },
          },
        );
        expect(handled).toBe(true);
        expect(end).toHaveBeenCalledWith(html);
      },
    });
  });

  it("serves bootstrap config JSON", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          { url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH, method: "GET" } as IncomingMessage,
          res,
          {
            root: { kind: "resolved", path: tmp },
            config: {
              agents: { defaults: { workspace: tmp } },
              ui: { assistant: { name: "</script><script>alert(1)//", avatar: "</script>.png" } },
            },
          },
        );
        expect(handled).toBe(true);
        const parsed = parseBootstrapPayload(end);
        expect(parsed.basePath).toBe("");
        expect(parsed.assistantName).toBe("</script><script>alert(1)//");
        expect(parsed.assistantAvatar).toBe("/avatar/main");
        expect(parsed.assistantAgentId).toBe("main");
      },
    });
  });

  it("serves bootstrap config JSON under basePath", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res, end } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          { url: `/openclaw${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, method: "GET" } as IncomingMessage,
          res,
          {
            basePath: "/openclaw",
            root: { kind: "resolved", path: tmp },
            config: {
              agents: { defaults: { workspace: tmp } },
              ui: { assistant: { name: "Ops", avatar: "ops.png" } },
            },
          },
        );
        expect(handled).toBe(true);
        const parsed = parseBootstrapPayload(end);
        expect(parsed.basePath).toBe("/openclaw");
        expect(parsed.assistantName).toBe("Ops");
        expect(parsed.assistantAvatar).toBe("/openclaw/avatar/main");
        expect(parsed.assistantAgentId).toBe("main");
      },
    });
  });

  it("serves growth foundation JSON from the configured workspace", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-growth-home-"));
        const workspace = path.join(home, ".openclaw", "workspace");
        try {
          const projectDir = path.join(workspace, "memory", "projects", "growth-foundation");
          await fs.mkdir(path.join(projectDir, "actions", "completed"), { recursive: true });
          await fs.mkdir(path.join(projectDir, "alerts"), { recursive: true });
          await fs.mkdir(path.join(projectDir, "weekly"), { recursive: true });
          await fs.mkdir(path.join(projectDir, "github"), { recursive: true });
          await fs.mkdir(path.join(projectDir, "github-writeback", "receipts"), {
            recursive: true,
          });
          await fs.mkdir(path.join(projectDir, "issue-flow", "issue-16"), { recursive: true });
          await fs.mkdir(path.join(projectDir, "issue-flow", "issue-17"), { recursive: true });
          await fs.mkdir(
            path.join(projectDir, "issue-flow", "archive", "issue-15--20260306T000000Z"),
            {
              recursive: true,
            },
          );
          await fs.mkdir(path.join(projectDir, "relay"), { recursive: true });
          await fs.writeFile(
            path.join(projectDir, "weekly", "2026-03-06-weekly-review.md"),
            "# Weekly Review\n",
          );
          await fs.writeFile(
            path.join(projectDir, "actions", "manual-state.json"),
            JSON.stringify(
              {
                completed: {
                  "done-1": {
                    status: "completed",
                    section: "this_week",
                    weekly: "2026-03-06-weekly-review.md",
                    text: "Review `queue-output-done`",
                    completed_at: "2026-03-06T14:00:00+09:00",
                    source: "mission-control",
                  },
                },
              },
              null,
              2,
            ),
          );
          await fs.writeFile(
            path.join(projectDir, "actions", "completed", "2026-03-06.md"),
            [
              "# Growth Action Completions - 2026-03-06",
              "",
              "## 2026-03-06T14:00:00+09:00",
              "",
              "- action: `complete`",
              "- item-key: `done-1`",
              "- weekly: `2026-03-06-weekly-review.md`",
              "- source: `mission-control`",
              "- text: Review `queue-output-done`",
              "",
            ].join("\n"),
          );
          await fs.writeFile(
            path.join(projectDir, "actions", "current.md"),
            [
              "# Growth Action Items",
              "",
              "- project: `growth-foundation`",
              "- status: `actionable`",
              "- updated_at: `2026-03-06T13:54:16+09:00`",
              "- latest-weekly: `memory/projects/growth-foundation/weekly/2026-03-06-weekly-review.md`",
              "",
              "## Priority Now",
              "",
              "- none",
              "",
              "## This Week",
              "",
              "- [ ] Review `queue-output-1`",
              "",
              "## Watch",
              "",
              "- none",
              "",
            ].join("\n"),
          );
          await fs.writeFile(
            path.join(projectDir, "alerts", "current.md"),
            [
              "# Growth Alert State",
              "",
              "- project: `growth-foundation`",
              "- status: `clear`",
              "- transition: `steady-clear`",
              "- updated_at: `2026-03-06T13:54:36+09:00`",
              "- heartbeat: `memory/projects/growth-foundation/heartbeat/2026-03-06.md`",
              "- weekly-review: `memory/projects/growth-foundation/weekly/2026-03-06-weekly-review.md`",
              "- latest-alert: `memory/projects/growth-foundation/alerts/current.md`",
              "",
            ].join("\n"),
          );
          await fs.mkdir(path.join(projectDir, "automation"), { recursive: true });
          await fs.writeFile(
            path.join(projectDir, "automation", "codex-patch-smoke-state.json"),
            JSON.stringify(
              {
                updated_at: "2026-03-06T15:10:00+09:00",
                last_enqueued_period: "2026-W10",
                last_job_id: "scheduled-codex-patch-20260306",
              },
              null,
              2,
            ),
          );
          await fs.writeFile(
            path.join(projectDir, "automation", "codex-patch-smoke-backfill-state.json"),
            JSON.stringify(
              {
                updated_at: "2026-03-06T16:00:00+09:00",
                entries: {
                  "2026-W08": {
                    job_id: "manual-backfill-codex-patch-2026w08",
                    requested_at: "2026-03-06T15:30:00+09:00",
                    reason: "WSL downtime skipped the weekly timer",
                  },
                },
              },
              null,
              2,
            ),
          );
          await fs.writeFile(
            path.join(projectDir, "automation", "codex-patch-smoke-review-state.json"),
            JSON.stringify(
              {
                updated_at: "2026-03-06T15:40:00+09:00",
                last_enqueued_period: "2026-W10",
                last_job_id: "scheduled-codex-review-20260306",
                source_job_id: "scheduled-codex-patch-20260306",
                last_diff_relpath:
                  "projects/growth-foundation/evidence/2026-03-06_scheduled-codex-review-smoke/scheduled-codex-patch-20260306.diff.patch",
              },
              null,
              2,
            ),
          );
          await fs.writeFile(
            path.join(projectDir, "automation", "codex-patch-smoke-review-backfill-state.json"),
            JSON.stringify(
              {
                updated_at: "2026-03-06T16:10:00+09:00",
                entries: {
                  "2026-W08": {
                    job_id: "manual-backfill-codex-review-2026w08",
                    requested_at: "2026-03-06T16:05:00+09:00",
                    reason: "WSL downtime skipped the reviewer timer",
                    source_job_id: "manual-backfill-codex-patch-2026w08",
                    source_origin: "patch-backfill",
                    diff_relpath:
                      "projects/growth-foundation/evidence/2026-03-06_manual-backfill-codex-review-smoke/manual-backfill-codex-patch-2026w08.diff.patch",
                  },
                },
              },
              null,
              2,
            ),
          );
          await fs.writeFile(
            path.join(projectDir, "github", "state.json"),
            JSON.stringify(
              {
                status: "synced",
                updated_at: "2026-03-07T22:10:00+09:00",
                issue_count: 2,
                issues: [
                  {
                    repo: "yui-stingray/ai-company",
                    number: 12,
                    title: "Define the first orchestrator acceptance contract",
                    url: "https://github.com/yui-stingray/ai-company/issues/12",
                    state: "open",
                    updated_at: "2026-03-07T00:10:00Z",
                  },
                  {
                    repo: "yui-stingray/growth-foundation",
                    number: 17,
                    title: "Dedicated proof-run issue already closed",
                    url: "https://github.com/yui-stingray/growth-foundation/issues/17",
                    state: "closed",
                    updated_at: "2026-03-07T12:00:00Z",
                  },
                ],
                project_sync: {
                  status: "synced",
                  title: "Growth Foundation",
                  url: "https://github.com/users/yui-stingray/projects/1",
                  items: [
                    {
                      repo: "yui-stingray/ai-company",
                      number: 2,
                      title: "[upstream-sync] Action required",
                    },
                  ],
                },
              },
              null,
              2,
            ),
          );
          await fs.writeFile(path.join(projectDir, "github", "current.md"), "# GitHub\n");
          await fs.writeFile(
            path.join(projectDir, "github-writeback", "current-proposal.json"),
            JSON.stringify(
              {
                schema: "growth-github-writeback-proposal/v1",
                generated_at: "2026-03-07T21:55:00+09:00",
                issue_ref: "yui-stingray/growth-foundation#17",
                planned_actions: ["comment", "close"],
                close_issue: true,
              },
              null,
              2,
            ),
          );
          await fs.writeFile(
            path.join(projectDir, "github-writeback", "receipts", "2026-03-07-issue-17.json"),
            JSON.stringify(
              {
                schema: "growth-github-writeback-receipt/v1",
                issue_ref: "yui-stingray/growth-foundation#17",
                operator: "yui",
                applied_at: "2026-03-07T22:00:00+09:00",
                actions: ["comment", "close"],
                close_issue: true,
              },
              null,
              2,
            ),
          );
          await fs.writeFile(
            path.join(
              projectDir,
              "issue-flow",
              "archive",
              "issue-15--20260306T000000Z",
              "archive-receipt.json",
            ),
            JSON.stringify(
              {
                schema: "growth-issue-flow-archive/v1",
                issue_number: 15,
                issue_ref: "yui-stingray/growth-foundation#15",
                stage: "outcome",
                status: "delivered",
                updated_at: "2026-03-06T08:00:00+09:00",
                archived_at: "2026-03-06T20:00:00+09:00",
                archived_by: "yui",
                reason: "proof-run is complete",
                was_latest_active: false,
                source_relpath: "memory/projects/growth-foundation/issue-flow/issue-15",
                archive_relpath:
                  "memory/projects/growth-foundation/issue-flow/archive/issue-15--20260306T000000Z",
                artifact_filenames: ["preflight.json", "outcome-bundle.json"],
              },
              null,
              2,
            ),
          );
          await fs.writeFile(
            path.join(projectDir, "issue-flow", "issue-16", "preflight.json"),
            JSON.stringify(
              {
                schema: "growth-live-issue-preflight-result/v1",
                generated_at: "2026-03-07T20:05:42+09:00",
                project: "growth-foundation",
                issue_ref: "yui-stingray/growth-foundation#16",
                status: "synced",
              },
              null,
              2,
            ),
          );
          await fs.writeFile(
            path.join(projectDir, "issue-flow", "issue-16", "orchestrator-draft.json"),
            JSON.stringify(
              {
                schema: "growth-orchestrator-draft/v1",
                generated_at: "2026-03-07T20:20:00+09:00",
                project: "growth-foundation",
                issue_ref: "yui-stingray/growth-foundation#16",
                draft_status: "approved-for-proposal",
              },
              null,
              2,
            ),
          );
          await fs.writeFile(
            path.join(projectDir, "issue-flow", "issue-16", "outcome-bundle.json"),
            JSON.stringify(
              {
                schema: "growth-issue-outcome-bundle/v1",
                generated_at: "2026-03-07T20:47:50+09:00",
                project: "growth-foundation",
                issue_ref: "yui-stingray/growth-foundation#16",
                primary_result_relpath: "queue/results/issue-16-live-operator-run-v1.json",
                outcome_status: "delivered",
              },
              null,
              2,
            ),
          );
          await fs.writeFile(
            path.join(projectDir, "issue-flow", "issue-17", "preflight.json"),
            JSON.stringify(
              {
                generated_at: "2026-03-07T22:05:42+09:00",
                issue_ref: "yui-stingray/growth-foundation#17",
                status: "synced",
              },
              null,
              2,
            ),
          );
          await fs.writeFile(
            path.join(projectDir, "issue-flow", "issue-17", "orchestrator-draft.json"),
            JSON.stringify(
              {
                generated_at: "2026-03-07T21:20:00+09:00",
                issue_ref: "yui-stingray/growth-foundation#17",
                draft_status: "approved-for-proposal",
              },
              null,
              2,
            ),
          );
          await fs.writeFile(
            path.join(projectDir, "issue-flow", "issue-17", "queue-proposal.json"),
            JSON.stringify(
              {
                generated_at: "2026-03-07T21:34:51+09:00",
                issue_ref: "yui-stingray/growth-foundation#17",
                proposal_status: "ready-for-manual-enqueue",
              },
              null,
              2,
            ),
          );
          await fs.writeFile(
            path.join(projectDir, "issue-flow", "issue-17", "enqueue-receipt.json"),
            JSON.stringify(
              {
                issue_ref: "yui-stingray/growth-foundation#17",
                enqueued_at: "2026-03-07T21:34:57+09:00",
              },
              null,
              2,
            ),
          );
          await fs.writeFile(
            path.join(projectDir, "issue-flow", "issue-17", "outcome-bundle.json"),
            JSON.stringify(
              {
                generated_at: "2026-03-07T21:47:50+09:00",
                issue_ref: "yui-stingray/growth-foundation#17",
                outcome_status: "needs-review",
                primary_result_relpath: "queue/results/issue-17-live-operator-run-v2.json",
              },
              null,
              2,
            ),
          );
          await fs.writeFile(
            path.join(projectDir, "relay", "state.json"),
            JSON.stringify(
              {
                status: "approval-required",
                channel: "discord",
                mode: "approval-required",
                candidate_count: 1,
                updated_at: "2026-03-06T17:05:00+09:00",
              },
              null,
              2,
            ),
          );
          await fs.writeFile(path.join(projectDir, "relay", "current.md"), "# Relay\n");

          const { res, end } = makeMockHttpResponse();
          const handled = handleControlUiHttpRequest(
            { url: CONTROL_UI_GROWTH_FOUNDATION_PATH, method: "GET" } as IncomingMessage,
            res,
            {
              root: { kind: "resolved", path: tmp },
              config: { agents: { defaults: { workspace } } },
            },
          );

          expect(handled).toBe(true);
          const parsed = parseGrowthPayload(end);
          expect(parsed.available).toBe(true);
          expect(parsed.projectId).toBe("growth-foundation");
          expect(parsed.workspaceProjectId).toBe("growth-foundation");
          expect(parsed.alertStatus).toBe("clear");
          expect(parsed.actionsStatus).toBe("actionable");
          expect(parsed.notificationStatus).toBe("attention");
          expect(parsed.notificationCount).toBe(1);
          expect(parsed.notificationItems[0]?.id).toBe("reviews-open");
          expect(parsed.notificationItems[0]?.severity).toBe("warning");
          expect(parsed.notificationItems[0]?.detail).toBe("Review queue-output-1");
          expect(parsed.notificationItems[0]?.path).toBe(
            "memory/projects/growth-foundation/weekly/2026-03-06-weekly-review.md",
          );
          expect(parsed.reviewCount).toBe(1);
          expect(parsed.thisWeek).toEqual(["Review queue-output-1"]);
          expect(parsed.thisWeekItems[0]?.key).toBe("7bb1651c6f04");
          expect(parsed.completedReviewCount).toBe(1);
          expect(parsed.completedThisWeekItems[0]?.key).toBe("done-1");
          expect(parsed.completedThisWeekItems[0]?.display).toBe("Review queue-output-done");
          expect(parsed.completedHistoryItems[0]?.action).toBe("complete");
          expect(parsed.completedHistoryItems[0]?.itemKey).toBe("done-1");
          expect(parsed.completedHistoryItems[0]?.text).toBe("Review queue-output-done");
          expect(parsed.completedHistoryItems[0]?.weeklyPath).toBe(
            "memory/projects/growth-foundation/weekly/2026-03-06-weekly-review.md",
          );
          expect(parsed.completedHistoryPath).toBe(
            "memory/projects/growth-foundation/actions/completed/2026-03-06.md",
          );
          expect(parsed.weeklyReviewPath).toBe(
            "memory/projects/growth-foundation/weekly/2026-03-06-weekly-review.md",
          );
          expect(parsed.codexSmokeStatus).toBe("scheduled");
          expect(parsed.codexSmokePeriod).toBe("2026-W10");
          expect(parsed.codexSmokeJobId).toBe("scheduled-codex-patch-20260306");
          expect(parsed.codexSmokeUpdatedAt).toBe("2026-03-06T15:10:00+09:00");
          expect(parsed.codexSmokeStatePath).toBe(
            "memory/projects/growth-foundation/automation/codex-patch-smoke-state.json",
          );
          expect(parsed.codexReviewSmokeStatus).toBe("scheduled");
          expect(parsed.codexReviewSmokePeriod).toBe("2026-W10");
          expect(parsed.codexReviewSmokeJobId).toBe("scheduled-codex-review-20260306");
          expect(parsed.codexReviewSmokeSourceJobId).toBe("scheduled-codex-patch-20260306");
          expect(parsed.codexReviewSmokeUpdatedAt).toBe("2026-03-06T15:40:00+09:00");
          expect(parsed.codexReviewSmokeStatePath).toBe(
            "memory/projects/growth-foundation/automation/codex-patch-smoke-review-state.json",
          );
          expect(parsed.codexReviewSmokeDiffPath).toBe(
            "projects/growth-foundation/evidence/2026-03-06_scheduled-codex-review-smoke/scheduled-codex-patch-20260306.diff.patch",
          );
          expect(parsed.codexReviewSmokeBackfillCount).toBe(1);
          expect(parsed.codexReviewSmokeBackfillItems[0]?.period).toBe("2026-W08");
          expect(parsed.codexReviewSmokeBackfillItems[0]?.jobId).toBe(
            "manual-backfill-codex-review-2026w08",
          );
          expect(parsed.codexReviewSmokeBackfillItems[0]?.sourceJobId).toBe(
            "manual-backfill-codex-patch-2026w08",
          );
          expect(parsed.codexReviewSmokeBackfillItems[0]?.sourceOrigin).toBe("patch-backfill");
          expect(parsed.codexReviewSmokeBackfillItems[0]?.diffRelpath).toBe(
            "projects/growth-foundation/evidence/2026-03-06_manual-backfill-codex-review-smoke/manual-backfill-codex-patch-2026w08.diff.patch",
          );
          expect(parsed.codexReviewSmokeBackfillStatePath).toBe(
            "memory/projects/growth-foundation/automation/codex-patch-smoke-review-backfill-state.json",
          );
          expect(parsed.codexSmokeBackfillCount).toBe(1);
          expect(parsed.codexSmokeBackfillItems[0]?.period).toBe("2026-W08");
          expect(parsed.codexSmokeBackfillItems[0]?.jobId).toBe(
            "manual-backfill-codex-patch-2026w08",
          );
          expect(parsed.codexSmokeBackfillStatePath).toBe(
            "memory/projects/growth-foundation/automation/codex-patch-smoke-backfill-state.json",
          );
          expect(parsed.githubSyncStatus).toBe("synced");
          expect(parsed.githubSyncIssueCount).toBe(2);
          expect(parsed.githubSyncUpdatedAt).toBe("2026-03-07T22:10:00+09:00");
          expect(parsed.githubSyncCurrentPath).toBe(
            "memory/projects/growth-foundation/github/current.md",
          );
          expect(parsed.githubProjectStatus).toBe("synced");
          expect(parsed.githubProjectTitle).toBe("Growth Foundation");
          expect(parsed.githubProjectUrl).toBe("https://github.com/users/yui-stingray/projects/1");
          expect(parsed.githubProjectItemCount).toBe(1);
          expect(parsed.githubWritebackStatus).toBe("applied");
          expect(parsed.githubWritebackIssueRef).toBe("yui-stingray/growth-foundation#17");
          expect(parsed.githubWritebackActions).toEqual(["comment", "close"]);
          expect(parsed.githubWritebackCloseIssue).toBe(true);
          expect(parsed.githubWritebackOperator).toBe("yui");
          expect(parsed.githubWritebackProposalUpdatedAt).toBe("2026-03-07T21:55:00+09:00");
          expect(parsed.githubWritebackReceiptAppliedAt).toBe("2026-03-07T22:00:00+09:00");
          expect(parsed.githubWritebackProposalPath).toBe(
            "memory/projects/growth-foundation/github-writeback/current-proposal.json",
          );
          expect(parsed.githubWritebackReceiptPath).toBe(
            "memory/projects/growth-foundation/github-writeback/receipts/2026-03-07-issue-17.json",
          );
          expect(parsed.issueFlowStatus).toBe("needs-review");
          expect(parsed.issueFlowStage).toBe("outcome");
          expect(parsed.issueFlowIssueNumber).toBe(17);
          expect(parsed.issueFlowIssueRef).toBe("yui-stingray/growth-foundation#17");
          expect(parsed.issueFlowPreflightStatus).toBe("synced");
          expect(parsed.issueFlowDraftStatus).toBe("approved-for-proposal");
          expect(parsed.issueFlowProposalStatus).toBe("ready-for-manual-enqueue");
          expect(parsed.issueFlowEnqueueStatus).toBe("enqueued");
          expect(parsed.issueFlowOutcomeStatus).toBe("needs-review");
          expect(parsed.issueFlowDirectoryPath).toBe(
            "memory/projects/growth-foundation/issue-flow/issue-17",
          );
          expect(parsed.issueFlowPreflightPath).toBe(
            "memory/projects/growth-foundation/issue-flow/issue-17/preflight.json",
          );
          expect(parsed.issueFlowOutcomePath).toBe(
            "memory/projects/growth-foundation/issue-flow/issue-17/outcome-bundle.json",
          );
          expect(parsed.issueFlowPrimaryResultPath).toBe(
            "queue/results/issue-17-live-operator-run-v2.json",
          );
          expect(parsed.issueFlowActiveCount).toBe(2);
          expect(parsed.issueFlowRecentCount).toBe(1);
          expect(parsed.issueFlowRecentItems).toHaveLength(1);
          expect(parsed.issueFlowRecentItems?.[0]).toEqual(
            expect.objectContaining({
              issueNumber: 16,
              issueRef: "yui-stingray/growth-foundation#16",
              stage: "outcome",
              status: "delivered",
              directoryPath: "memory/projects/growth-foundation/issue-flow/issue-16",
              outcomePath:
                "memory/projects/growth-foundation/issue-flow/issue-16/outcome-bundle.json",
              primaryResultPath: "queue/results/issue-16-live-operator-run-v1.json",
            }),
          );
          expect(parsed.issueFlowArchivedCount).toBe(1);
          expect(parsed.issueFlowArchiveRootPath).toBe(
            "memory/projects/growth-foundation/issue-flow/archive",
          );
          expect(parsed.issueFlowArchivedLatestIssueRef).toBe("yui-stingray/growth-foundation#15");
          expect(parsed.issueFlowArchivedLatestArchivedAt).toBe("2026-03-06T20:00:00+09:00");
          expect(parsed.issueFlowArchivedLatestPath).toBe(
            "memory/projects/growth-foundation/issue-flow/archive/issue-15--20260306T000000Z",
          );
          expect(parsed.issueFlowArchivedLatestReceiptPath).toBe(
            "memory/projects/growth-foundation/issue-flow/archive/issue-15--20260306T000000Z/archive-receipt.json",
          );
          expect(parsed.issueFlowVisibilityStatus).toBe("aligned");
          expect(parsed.issueFlowVisibilityReason).toBe(
            "The issue is no longer open after an applied close write-back.",
          );
          expect(parsed.issueFlowVisibilityOpenIssue).toBe(false);
          expect(parsed.issueFlowVisibilityGithubSyncUpdatedAt).toBe("2026-03-07T22:10:00+09:00");
          expect(parsed.relayStatus).toBe("approval-required");
          expect(parsed.relayChannel).toBe("discord");
          expect(parsed.relayMode).toBe("approval-required");
          expect(parsed.relayCandidateCount).toBe(1);
          expect(parsed.relayUpdatedAt).toBe("2026-03-06T17:05:00+09:00");
          expect(parsed.relayCurrentPath).toBe(
            "memory/projects/growth-foundation/relay/current.md",
          );
        } finally {
          await fs.rm(home, { recursive: true, force: true });
        }
      },
    });
  });

  it("normalizes surfaced growth artifact paths to the workspace project id", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-growth-path-alias-home-"));
        const workspace = path.join(home, ".openclaw", "workspace");
        const workspaceProjectId = "2026-03-06_growth-foundation";
        const displayProjectId = "growth-foundation";
        const projectDir = path.join(workspace, "memory", "projects", workspaceProjectId);
        const evidenceDir = path.join(
          workspace,
          "projects",
          workspaceProjectId,
          "evidence",
          "2026-03-06_scheduled-codex-review-smoke",
        );
        const backfillEvidenceDir = path.join(
          workspace,
          "projects",
          workspaceProjectId,
          "evidence",
          "2026-03-06_manual-backfill-codex-review-smoke",
        );
        const weeklyRelPath = `memory/projects/${displayProjectId}/weekly/2026-03-06-weekly-review.md`;
        const alertRelPath = `memory/projects/${displayProjectId}/alerts/current.md`;
        const heartbeatRelPath = `memory/projects/${displayProjectId}/heartbeat/2026-03-06.md`;
        const diffRelPath =
          `projects/${displayProjectId}/evidence/2026-03-06_scheduled-codex-review-smoke/` +
          "scheduled-codex-patch-20260306.diff.patch";
        const backfillDiffRelPath =
          `projects/${displayProjectId}/evidence/2026-03-06_manual-backfill-codex-review-smoke/` +
          "manual-backfill-codex-patch-2026w08.diff.patch";
        try {
          await fs.mkdir(path.join(projectDir, "actions"), { recursive: true });
          await fs.mkdir(path.join(projectDir, "alerts"), { recursive: true });
          await fs.mkdir(path.join(projectDir, "weekly"), { recursive: true });
          await fs.mkdir(path.join(projectDir, "heartbeat"), { recursive: true });
          await fs.mkdir(path.join(projectDir, "automation"), { recursive: true });
          await fs.mkdir(evidenceDir, { recursive: true });
          await fs.mkdir(backfillEvidenceDir, { recursive: true });
          await fs.writeFile(
            path.join(projectDir, "weekly", "2026-03-06-weekly-review.md"),
            "# Weekly\n",
          );
          await fs.writeFile(path.join(projectDir, "heartbeat", "2026-03-06.md"), "# Heartbeat\n");
          await fs.writeFile(
            path.join(evidenceDir, "scheduled-codex-patch-20260306.diff.patch"),
            "--- diff\n",
          );
          await fs.writeFile(
            path.join(backfillEvidenceDir, "manual-backfill-codex-patch-2026w08.diff.patch"),
            "--- backfill diff\n",
          );
          await fs.writeFile(
            path.join(projectDir, "actions", "current.md"),
            [
              "# Growth Action Items",
              "",
              `- project: \`${displayProjectId}\``,
              "- status: `actionable`",
              "- updated_at: `2026-03-06T13:54:16+09:00`",
              `- latest-weekly: \`${weeklyRelPath}\``,
              `- latest-alert: \`${alertRelPath}\``,
              "",
              "## Priority Now",
              "",
              "- none",
              "",
              "## This Week",
              "",
              "- [ ] Review `queue-output-1`",
              "",
              "## Watch",
              "",
              "- none",
              "",
            ].join("\n"),
          );
          await fs.writeFile(
            path.join(projectDir, "alerts", "current.md"),
            [
              "# Growth Alert State",
              "",
              `- project: \`${displayProjectId}\``,
              "- status: `clear`",
              "- transition: `steady-clear`",
              "- updated_at: `2026-03-06T13:54:36+09:00`",
              `- heartbeat: \`${heartbeatRelPath}\``,
              `- weekly-review: \`${weeklyRelPath}\``,
            ].join("\n"),
          );
          await fs.writeFile(
            path.join(projectDir, "automation", "codex-patch-smoke-review-state.json"),
            JSON.stringify(
              {
                last_enqueued_period: "2026-W10",
                last_job_id: "scheduled-codex-review-20260306",
                source_job_id: "scheduled-codex-patch-20260306",
                updated_at: "2026-03-06T15:40:00+09:00",
                last_diff_relpath: diffRelPath,
              },
              null,
              2,
            ),
          );
          await fs.writeFile(
            path.join(projectDir, "automation", "codex-patch-smoke-review-backfill-state.json"),
            JSON.stringify(
              {
                entries: {
                  "2026-W08": {
                    job_id: "manual-backfill-codex-review-2026w08",
                    requested_at: "2026-03-06T16:05:00+09:00",
                    reason: "timer skipped",
                    source_job_id: "manual-backfill-codex-patch-2026w08",
                    source_origin: "patch-backfill",
                    diff_relpath: backfillDiffRelPath,
                  },
                },
              },
              null,
              2,
            ),
          );

          const { res, end } = makeMockHttpResponse();
          const handled = handleControlUiHttpRequest(
            { url: CONTROL_UI_GROWTH_FOUNDATION_PATH, method: "GET" } as IncomingMessage,
            res,
            {
              root: { kind: "resolved", path: tmp },
              config: { agents: { defaults: { workspace } } },
            },
          );

          expect(handled).toBe(true);
          expect(res.statusCode).toBe(200);
          const parsed = parseGrowthPayload(end);
          expect(parsed.projectId).toBe(displayProjectId);
          expect(parsed.workspaceProjectId).toBe(workspaceProjectId);
          expect(parsed.alertsPath).toBe(`memory/projects/${workspaceProjectId}/alerts/current.md`);
          expect(parsed.weeklyReviewPath).toBe(
            `memory/projects/${workspaceProjectId}/weekly/2026-03-06-weekly-review.md`,
          );
          expect(parsed.heartbeatPath).toBe(
            `memory/projects/${workspaceProjectId}/heartbeat/2026-03-06.md`,
          );
          expect(parsed.notificationItems[0]?.path).toBe(
            `memory/projects/${workspaceProjectId}/weekly/2026-03-06-weekly-review.md`,
          );
          expect(parsed.codexReviewSmokeDiffPath).toBe(
            `projects/${workspaceProjectId}/evidence/2026-03-06_scheduled-codex-review-smoke/` +
              "scheduled-codex-patch-20260306.diff.patch",
          );
          expect(parsed.codexReviewSmokeBackfillItems[0]?.diffRelpath).toBe(
            `projects/${workspaceProjectId}/evidence/2026-03-06_manual-backfill-codex-review-smoke/` +
              "manual-backfill-codex-patch-2026w08.diff.patch",
          );
        } finally {
          await fs.rm(home, { recursive: true, force: true });
        }
      },
    });
  });

  it("serves growth weekly review markdown from the configured workspace", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-growth-file-home-"));
        const workspace = path.join(home, ".openclaw", "workspace");
        const weeklyPath = path.join(
          workspace,
          "memory",
          "projects",
          "growth-foundation",
          "weekly",
          "2026-03-06-weekly-review.md",
        );
        try {
          await fs.mkdir(path.dirname(weeklyPath), { recursive: true });
          await fs.mkdir(
            path.join(workspace, "memory", "projects", "growth-foundation", "actions"),
            {
              recursive: true,
            },
          );
          await fs.mkdir(
            path.join(workspace, "memory", "projects", "growth-foundation", "alerts"),
            {
              recursive: true,
            },
          );
          await fs.writeFile(weeklyPath, "# Weekly Review\n\n- ok\n");
          await fs.writeFile(
            path.join(
              workspace,
              "memory",
              "projects",
              "growth-foundation",
              "actions",
              "current.md",
            ),
            [
              "# Growth Action Items",
              "",
              "- project: `growth-foundation`",
              "- status: `clear`",
              "- updated_at: `2026-03-06T13:54:16+09:00`",
              "- latest-weekly: `memory/projects/growth-foundation/weekly/2026-03-06-weekly-review.md`",
              "",
              "## Priority Now",
              "",
              "- none",
              "",
              "## This Week",
              "",
              "- none",
              "",
              "## Watch",
              "",
              "- none",
              "",
            ].join("\n"),
          );
          await fs.writeFile(
            path.join(workspace, "memory", "projects", "growth-foundation", "alerts", "current.md"),
            [
              "# Growth Alert State",
              "",
              "- project: `growth-foundation`",
              "- status: `clear`",
              "- transition: `steady-clear`",
              "- updated_at: `2026-03-06T13:54:36+09:00`",
              "- heartbeat: `memory/projects/growth-foundation/heartbeat/2026-03-06.md`",
              "- weekly-review: `memory/projects/growth-foundation/weekly/2026-03-06-weekly-review.md`",
              "",
            ].join("\n"),
          );

          const { res, end } = makeMockHttpResponse();
          const handled = handleControlUiHttpRequest(
            {
              url: `${CONTROL_UI_GROWTH_FILE_PATH}?path=${encodeURIComponent("memory/projects/growth-foundation/weekly/2026-03-06-weekly-review.md")}`,
              method: "GET",
            } as IncomingMessage,
            res,
            {
              root: { kind: "resolved", path: tmp },
              config: { agents: { defaults: { workspace } } },
            },
          );

          expect(handled).toBe(true);
          expect(res.statusCode).toBe(200);
          expect(end).toHaveBeenCalledWith("# Weekly Review\n\n- ok\n");
        } finally {
          await fs.rm(home, { recursive: true, force: true });
        }
      },
    });
  });

  it("serves surfaced growth files using the workspace project id when the display project differs", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-growth-file-alias-home-"));
        const workspace = path.join(home, ".openclaw", "workspace");
        const workspaceProjectId = "2026-03-06_growth-foundation";
        const weeklyRelPath =
          "memory/projects/2026-03-06_growth-foundation/weekly/2026-03-06-weekly-review.md";
        const weeklyPath = path.join(workspace, weeklyRelPath);
        try {
          await fs.mkdir(path.dirname(weeklyPath), { recursive: true });
          await fs.mkdir(
            path.join(workspace, "memory", "projects", workspaceProjectId, "actions"),
            { recursive: true },
          );
          await fs.mkdir(path.join(workspace, "memory", "projects", workspaceProjectId, "alerts"), {
            recursive: true,
          });
          await fs.writeFile(weeklyPath, "# Weekly Review\n\n- ok\n");
          await fs.writeFile(
            path.join(workspace, "memory", "projects", workspaceProjectId, "actions", "current.md"),
            [
              "# Growth Action Items",
              "",
              "- project: `growth-foundation`",
              "- status: `clear`",
              "- updated_at: `2026-03-06T13:54:16+09:00`",
              `- latest-weekly: \`${weeklyRelPath}\``,
              "",
              "## Priority Now",
              "",
              "- none",
              "",
              "## This Week",
              "",
              "- none",
              "",
              "## Watch",
              "",
              "- none",
              "",
            ].join("\n"),
          );
          await fs.writeFile(
            path.join(workspace, "memory", "projects", workspaceProjectId, "alerts", "current.md"),
            [
              "# Growth Alert State",
              "",
              "- project: `growth-foundation`",
              "- status: `clear`",
              "- transition: `steady-clear`",
              "- updated_at: `2026-03-06T13:54:36+09:00`",
              `- weekly-review: \`${weeklyRelPath}\``,
              "",
            ].join("\n"),
          );

          const { res, end } = makeMockHttpResponse();
          const handled = handleControlUiHttpRequest(
            {
              url: `${CONTROL_UI_GROWTH_FILE_PATH}?path=${encodeURIComponent(weeklyRelPath)}`,
              method: "GET",
            } as IncomingMessage,
            res,
            {
              root: { kind: "resolved", path: tmp },
              config: { agents: { defaults: { workspace } } },
            },
          );

          expect(handled).toBe(true);
          expect(res.statusCode).toBe(200);
          expect(end).toHaveBeenCalledWith("# Weekly Review\n\n- ok\n");
        } finally {
          await fs.rm(home, { recursive: true, force: true });
        }
      },
    });
  });

  it("serves growth write-back proposal JSON from the configured workspace", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-growth-json-home-"));
        const workspace = path.join(home, ".openclaw", "workspace");
        const projectId = "growth-foundation";
        const proposalPath = path.join(
          workspace,
          "memory",
          "projects",
          projectId,
          "github-writeback",
          "current-proposal.json",
        );
        try {
          await fs.mkdir(path.dirname(proposalPath), { recursive: true });
          await fs.mkdir(path.join(workspace, "memory", "projects", projectId, "actions"), {
            recursive: true,
          });
          await fs.mkdir(path.join(workspace, "memory", "projects", projectId, "alerts"), {
            recursive: true,
          });
          await fs.writeFile(
            proposalPath,
            '{\n  "issue_ref": "yui-stingray/growth-foundation#17"\n}\n',
          );
          await fs.writeFile(
            path.join(workspace, "memory", "projects", projectId, "actions", "current.md"),
            [
              "# Growth Action Items",
              "",
              "- project: `growth-foundation`",
              "- status: `clear`",
              "- updated_at: `2026-03-06T13:54:16+09:00`",
              "- latest-weekly: `memory/projects/growth-foundation/weekly/2026-03-06-weekly-review.md`",
              "",
              "## Priority Now",
              "",
              "- none",
              "",
              "## This Week",
              "",
              "- none",
              "",
              "## Watch",
              "",
              "- none",
              "",
            ].join("\n"),
          );
          await fs.writeFile(
            path.join(workspace, "memory", "projects", projectId, "alerts", "current.md"),
            [
              "# Growth Alert State",
              "",
              "- project: `growth-foundation`",
              "- status: `clear`",
              "- transition: `steady-clear`",
              "- updated_at: `2026-03-06T13:54:36+09:00`",
              "",
            ].join("\n"),
          );

          const { res, setHeader, end } = makeMockHttpResponse();
          const handled = handleControlUiHttpRequest(
            {
              url: `${CONTROL_UI_GROWTH_FILE_PATH}?path=${encodeURIComponent("memory/projects/growth-foundation/github-writeback/current-proposal.json")}`,
              method: "GET",
            } as IncomingMessage,
            res,
            {
              root: { kind: "resolved", path: tmp },
              config: { agents: { defaults: { workspace } } },
            },
          );

          expect(handled).toBe(true);
          expect(res.statusCode).toBe(200);
          expect(setHeader).toHaveBeenCalledWith("Content-Type", "application/json; charset=utf-8");
          expect(end).toHaveBeenCalledWith(
            '{\n  "issue_ref": "yui-stingray/growth-foundation#17"\n}\n',
          );
        } finally {
          await fs.rm(home, { recursive: true, force: true });
        }
      },
    });
  });

  it("serves growth issue-flow result JSON from the configured workspace", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-growth-result-home-"));
        const workspace = path.join(home, ".openclaw", "workspace");
        const projectId = "growth-foundation";
        const issueDir = path.join(
          workspace,
          "memory",
          "projects",
          projectId,
          "issue-flow",
          "issue-17",
        );
        const resultRelPath = "queue/results/issue-17-live-operator-run-v2.json";
        const resultPath = path.join(workspace, resultRelPath);
        try {
          await fs.mkdir(issueDir, { recursive: true });
          await fs.mkdir(path.dirname(resultPath), { recursive: true });
          await fs.mkdir(path.join(workspace, "memory", "projects", projectId, "actions"), {
            recursive: true,
          });
          await fs.mkdir(path.join(workspace, "memory", "projects", projectId, "alerts"), {
            recursive: true,
          });
          await fs.writeFile(
            path.join(issueDir, "outcome-bundle.json"),
            JSON.stringify(
              {
                issue_ref: "yui-stingray/growth-foundation#17",
                outcome_status: "needs-review",
                generated_at: "2026-03-07T21:47:50+09:00",
                primary_result_relpath: resultRelPath,
              },
              null,
              2,
            ) + "\n",
          );
          await fs.writeFile(resultPath, '{\n  "status": "ok"\n}\n');
          await fs.writeFile(
            path.join(workspace, "memory", "projects", projectId, "actions", "current.md"),
            [
              "# Growth Action Items",
              "",
              "- project: `growth-foundation`",
              "- status: `clear`",
              "- updated_at: `2026-03-06T13:54:16+09:00`",
              "",
              "## Priority Now",
              "",
              "- none",
              "",
              "## This Week",
              "",
              "- none",
              "",
              "## Watch",
              "",
              "- none",
              "",
            ].join("\n"),
          );
          await fs.writeFile(
            path.join(workspace, "memory", "projects", projectId, "alerts", "current.md"),
            [
              "# Growth Alert State",
              "",
              "- project: `growth-foundation`",
              "- status: `clear`",
              "- transition: `steady-clear`",
              "- updated_at: `2026-03-06T13:54:36+09:00`",
              "",
            ].join("\n"),
          );

          const { res, setHeader, end } = makeMockHttpResponse();
          const handled = handleControlUiHttpRequest(
            {
              url: `${CONTROL_UI_GROWTH_FILE_PATH}?path=${encodeURIComponent(resultRelPath)}`,
              method: "GET",
            } as IncomingMessage,
            res,
            {
              root: { kind: "resolved", path: tmp },
              config: { agents: { defaults: { workspace } } },
            },
          );

          expect(handled).toBe(true);
          expect(res.statusCode).toBe(200);
          expect(setHeader).toHaveBeenCalledWith("Content-Type", "application/json; charset=utf-8");
          expect(end).toHaveBeenCalledWith('{\n  "status": "ok"\n}\n');
        } finally {
          await fs.rm(home, { recursive: true, force: true });
        }
      },
    });
  });

  it("serves growth review diff patches from the configured workspace", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-growth-patch-home-"));
        const workspace = path.join(home, ".openclaw", "workspace");
        const projectId = "growth-foundation";
        const diffRelPath =
          "projects/growth-foundation/evidence/2026-03-06_scheduled-codex-review-smoke/scheduled-codex-patch-20260306.diff.patch";
        const diffPath = path.join(workspace, diffRelPath);
        const reviewStatePath = path.join(
          workspace,
          "memory",
          "projects",
          projectId,
          "automation",
          "codex-patch-smoke-review-state.json",
        );
        try {
          await fs.mkdir(path.dirname(diffPath), { recursive: true });
          await fs.mkdir(path.dirname(reviewStatePath), { recursive: true });
          await fs.mkdir(path.join(workspace, "memory", "projects", projectId, "actions"), {
            recursive: true,
          });
          await fs.mkdir(path.join(workspace, "memory", "projects", projectId, "alerts"), {
            recursive: true,
          });
          await fs.writeFile(diffPath, "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-ok\n+better\n");
          await fs.writeFile(
            reviewStatePath,
            JSON.stringify(
              {
                last_enqueued_period: "2026-W10",
                last_job_id: "scheduled-codex-review-20260306",
                updated_at: "2026-03-06T15:40:00+09:00",
                last_diff_relpath: diffRelPath,
              },
              null,
              2,
            ) + "\n",
          );
          await fs.writeFile(
            path.join(workspace, "memory", "projects", projectId, "actions", "current.md"),
            [
              "# Growth Action Items",
              "",
              "- project: `growth-foundation`",
              "- status: `clear`",
              "- updated_at: `2026-03-06T13:54:16+09:00`",
              "",
              "## Priority Now",
              "",
              "- none",
              "",
              "## This Week",
              "",
              "- none",
              "",
              "## Watch",
              "",
              "- none",
              "",
            ].join("\n"),
          );
          await fs.writeFile(
            path.join(workspace, "memory", "projects", projectId, "alerts", "current.md"),
            [
              "# Growth Alert State",
              "",
              "- project: `growth-foundation`",
              "- status: `clear`",
              "- transition: `steady-clear`",
              "- updated_at: `2026-03-06T13:54:36+09:00`",
              "",
            ].join("\n"),
          );

          const { res, setHeader, end } = makeMockHttpResponse();
          const handled = handleControlUiHttpRequest(
            {
              url: `${CONTROL_UI_GROWTH_FILE_PATH}?path=${encodeURIComponent(diffRelPath)}`,
              method: "GET",
            } as IncomingMessage,
            res,
            {
              root: { kind: "resolved", path: tmp },
              config: { agents: { defaults: { workspace } } },
            },
          );

          expect(handled).toBe(true);
          expect(res.statusCode).toBe(200);
          expect(setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
          expect(end).toHaveBeenCalledWith("--- a/file\n+++ b/file\n@@ -1 +1 @@\n-ok\n+better\n");
        } finally {
          await fs.rm(home, { recursive: true, force: true });
        }
      },
    });
  });

  it("accepts growth review action POSTs and returns the refreshed snapshot", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-growth-action-home-"));
        const workspace = path.join(home, ".openclaw", "workspace");
        const projectDir = path.join(workspace, "memory", "projects", "growth-foundation");
        const scriptsDir = path.join(workspace, "projects", "growth-foundation", "scripts");
        try {
          await fs.mkdir(path.join(projectDir, "actions"), { recursive: true });
          await fs.mkdir(path.join(projectDir, "alerts"), { recursive: true });
          await fs.mkdir(path.join(projectDir, "weekly"), { recursive: true });
          await fs.mkdir(scriptsDir, { recursive: true });
          await fs.writeFile(
            path.join(projectDir, "weekly", "2026-03-06-weekly-review.md"),
            "# Weekly\n",
          );
          await fs.writeFile(
            path.join(projectDir, "actions", "current.md"),
            [
              "# Growth Action Items",
              "",
              "- project: `growth-foundation`",
              "- status: `actionable`",
              "- updated_at: `2026-03-06T13:54:16+09:00`",
              "- latest-weekly: `memory/projects/growth-foundation/weekly/2026-03-06-weekly-review.md`",
              "",
              "## Priority Now",
              "",
              "- none",
              "",
              "## This Week",
              "",
              "- [ ] Review `queue-output-1`",
              "",
              "## Watch",
              "",
              "- none",
              "",
            ].join("\n"),
          );
          await fs.writeFile(
            path.join(projectDir, "alerts", "current.md"),
            [
              "# Growth Alert State",
              "",
              "- project: `growth-foundation`",
              "- status: `clear`",
              "- transition: `steady-clear`",
              "- updated_at: `2026-03-06T13:54:36+09:00`",
              "- heartbeat: `memory/projects/growth-foundation/heartbeat/2026-03-06.md`",
              "- weekly-review: `memory/projects/growth-foundation/weekly/2026-03-06-weekly-review.md`",
            ].join("\n"),
          );
          await fs.writeFile(path.join(scriptsDir, "complete_growth_action.py"), "print('ok')\n");

          const { res, end } = makeMockHttpResponse();
          const handled = handleControlUiHttpRequest(
            makePostRequest(CONTROL_UI_GROWTH_REVIEW_ACTION_PATH, {
              action: "complete",
              itemKey: "item-1",
              projectId: "growth-foundation",
            }),
            res,
            {
              root: { kind: "resolved", path: tmp },
              config: { agents: { defaults: { workspace } } },
            },
          );

          expect(handled).toBe(true);
          await new Promise((resolve) => setImmediate(resolve));
          const payload = JSON.parse(String(end.mock.calls[0]?.[0] ?? "")) as {
            success: boolean;
            action: string;
            snapshot: { projectId: string | null };
          };
          expect(res.statusCode).toBe(200);
          expect(payload.success).toBe(true);
          expect(payload.action).toBe("complete");
          expect(payload.snapshot.projectId).toBe("growth-foundation");
        } finally {
          await fs.rm(home, { recursive: true, force: true });
        }
      },
    });
  });

  it("uses the workspace project id for review actions when the display project differs", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-growth-action-alias-home-"));
        const workspace = path.join(home, ".openclaw", "workspace");
        const workspaceProjectId = "2026-03-06_growth-foundation";
        const projectDir = path.join(workspace, "memory", "projects", workspaceProjectId);
        const scriptsDir = path.join(workspace, "projects", workspaceProjectId, "scripts");
        try {
          await fs.mkdir(path.join(projectDir, "actions"), { recursive: true });
          await fs.mkdir(path.join(projectDir, "alerts"), { recursive: true });
          await fs.mkdir(path.join(projectDir, "weekly"), { recursive: true });
          await fs.mkdir(scriptsDir, { recursive: true });
          await fs.writeFile(
            path.join(projectDir, "weekly", "2026-03-06-weekly-review.md"),
            "# Weekly\n",
          );
          await fs.writeFile(
            path.join(projectDir, "actions", "current.md"),
            [
              "# Growth Action Items",
              "",
              "- project: `growth-foundation`",
              "- status: `actionable`",
              "- updated_at: `2026-03-06T13:54:16+09:00`",
              `- latest-weekly: \`memory/projects/${workspaceProjectId}/weekly/2026-03-06-weekly-review.md\``,
              "",
              "## Priority Now",
              "",
              "- none",
              "",
              "## This Week",
              "",
              "- [ ] Review `queue-output-1`",
              "",
              "## Watch",
              "",
              "- none",
              "",
            ].join("\n"),
          );
          await fs.writeFile(
            path.join(projectDir, "alerts", "current.md"),
            [
              "# Growth Alert State",
              "",
              "- project: `growth-foundation`",
              "- status: `clear`",
              "- transition: `steady-clear`",
              "- updated_at: `2026-03-06T13:54:36+09:00`",
              `- weekly-review: \`memory/projects/${workspaceProjectId}/weekly/2026-03-06-weekly-review.md\``,
            ].join("\n"),
          );
          await fs.writeFile(path.join(scriptsDir, "complete_growth_action.py"), "print('ok')\n");

          const { res, end } = makeMockHttpResponse();
          const handled = handleControlUiHttpRequest(
            makePostRequest(CONTROL_UI_GROWTH_REVIEW_ACTION_PATH, {
              action: "complete",
              itemKey: "item-1",
              projectId: workspaceProjectId,
            }),
            res,
            {
              root: { kind: "resolved", path: tmp },
              config: { agents: { defaults: { workspace } } },
            },
          );

          expect(handled).toBe(true);
          await new Promise((resolve) => setImmediate(resolve));
          const payload = JSON.parse(String(end.mock.calls[0]?.[0] ?? "")) as {
            success: boolean;
            action: string;
            snapshot: { projectId: string | null; workspaceProjectId?: string | null };
          };
          expect(res.statusCode).toBe(200);
          expect(payload.success).toBe(true);
          expect(payload.action).toBe("complete");
          expect(payload.snapshot.projectId).toBe("growth-foundation");
          expect(payload.snapshot.workspaceProjectId).toBe(workspaceProjectId);
        } finally {
          await fs.rm(home, { recursive: true, force: true });
        }
      },
    });
  });

  it("serves local avatar bytes through hardened avatar handler", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-http-"));
    try {
      const avatarPath = path.join(tmp, "main.png");
      await fs.writeFile(avatarPath, "avatar-bytes\n");

      const { res, end, handled } = runAvatarRequest({
        url: "/avatar/main",
        method: "GET",
        resolveAvatar: () => ({ kind: "local", filePath: avatarPath }),
      });

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(String(end.mock.calls[0]?.[0] ?? "")).toBe("avatar-bytes\n");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects avatar symlink paths from resolver", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-http-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-http-outside-"));
    try {
      const outsideFile = path.join(outside, "secret.txt");
      await fs.writeFile(outsideFile, "outside-secret\n");
      const linkPath = path.join(tmp, "avatar-link.png");
      await fs.symlink(outsideFile, linkPath);

      const { res, end, handled } = runAvatarRequest({
        url: "/avatar/main",
        method: "GET",
        resolveAvatar: () => ({ kind: "local", filePath: linkPath }),
      });

      expectNotFoundResponse({ handled, res, end });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects symlinked assets that resolve outside control-ui root", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const assetsDir = path.join(tmp, "assets");
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-outside-"));
        try {
          const outsideFile = path.join(outsideDir, "secret.txt");
          await fs.mkdir(assetsDir, { recursive: true });
          await fs.writeFile(outsideFile, "outside-secret\n");
          await fs.symlink(outsideFile, path.join(assetsDir, "leak.txt"));

          const { res, end } = makeMockHttpResponse();
          const handled = handleControlUiHttpRequest(
            { url: "/assets/leak.txt", method: "GET" } as IncomingMessage,
            res,
            {
              root: { kind: "resolved", path: tmp },
            },
          );
          expectNotFoundResponse({ handled, res, end });
        } finally {
          await fs.rm(outsideDir, { recursive: true, force: true });
        }
      },
    });
  });

  it("allows symlinked assets that resolve inside control-ui root", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { assetsDir, filePath } = await writeAssetFile(tmp, "actual.txt", "inside-ok\n");
        await fs.symlink(filePath, path.join(assetsDir, "linked.txt"));

        const { res, end, handled } = runControlUiRequest({
          url: "/assets/linked.txt",
          method: "GET",
          rootPath: tmp,
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(String(end.mock.calls[0]?.[0] ?? "")).toBe("inside-ok\n");
      },
    });
  });

  it("serves HEAD for in-root assets without writing a body", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        await writeAssetFile(tmp, "actual.txt", "inside-ok\n");

        const { res, end, handled } = runControlUiRequest({
          url: "/assets/actual.txt",
          method: "HEAD",
          rootPath: tmp,
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(end.mock.calls[0]?.length ?? -1).toBe(0);
      },
    });
  });

  it("rejects symlinked SPA fallback index.html outside control-ui root", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-index-outside-"));
        try {
          const outsideIndex = path.join(outsideDir, "index.html");
          await fs.writeFile(outsideIndex, "<html>outside</html>\n");
          await fs.rm(path.join(tmp, "index.html"));
          await fs.symlink(outsideIndex, path.join(tmp, "index.html"));

          const { res, end, handled } = runControlUiRequest({
            url: "/app/route",
            method: "GET",
            rootPath: tmp,
          });
          expectNotFoundResponse({ handled, res, end });
        } finally {
          await fs.rm(outsideDir, { recursive: true, force: true });
        }
      },
    });
  });

  it("rejects hardlinked index.html for non-package control-ui roots", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-index-hardlink-"));
        try {
          const outsideIndex = path.join(outsideDir, "index.html");
          await fs.writeFile(outsideIndex, "<html>outside-hardlink</html>\n");
          await fs.rm(path.join(tmp, "index.html"));
          await fs.link(outsideIndex, path.join(tmp, "index.html"));

          const { res, end, handled } = runControlUiRequest({
            url: "/",
            method: "GET",
            rootPath: tmp,
          });
          expectNotFoundResponse({ handled, res, end });
        } finally {
          await fs.rm(outsideDir, { recursive: true, force: true });
        }
      },
    });
  });

  it("rejects hardlinked asset files for custom/resolved roots (security boundary)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const assetsDir = path.join(tmp, "assets");
        await fs.mkdir(assetsDir, { recursive: true });
        await fs.writeFile(path.join(assetsDir, "app.js"), "console.log('hi');");
        await fs.link(path.join(assetsDir, "app.js"), path.join(assetsDir, "app.hl.js"));

        const { res, end, handled } = runControlUiRequest({
          url: "/assets/app.hl.js",
          method: "GET",
          rootPath: tmp,
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(404);
        expect(end).toHaveBeenCalledWith("Not Found");
      },
    });
  });

  it("serves hardlinked asset files for bundled roots (pnpm global install)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const assetsDir = path.join(tmp, "assets");
        await fs.mkdir(assetsDir, { recursive: true });
        await fs.writeFile(path.join(assetsDir, "app.js"), "console.log('hi');");
        await fs.link(path.join(assetsDir, "app.js"), path.join(assetsDir, "app.hl.js"));

        const { res, end, handled } = runControlUiRequest({
          url: "/assets/app.hl.js",
          method: "GET",
          rootPath: tmp,
          rootKind: "bundled",
        });

        expect(handled).toBe(true);
        expect(res.statusCode).toBe(200);
        expect(String(end.mock.calls[0]?.[0] ?? "")).toBe("console.log('hi');");
      },
    });
  });

  it("does not handle POST to root-mounted paths (plugin webhook passthrough)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        for (const webhookPath of ["/bluebubbles-webhook", "/custom-webhook", "/callback"]) {
          const { res } = makeMockHttpResponse();
          const handled = handleControlUiHttpRequest(
            { url: webhookPath, method: "POST" } as IncomingMessage,
            res,
            { root: { kind: "resolved", path: tmp } },
          );
          expect(handled, `POST to ${webhookPath} should pass through to plugin handlers`).toBe(
            false,
          );
        }
      },
    });
  });

  it("does not handle POST to paths outside basePath", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { res } = makeMockHttpResponse();
        const handled = handleControlUiHttpRequest(
          { url: "/bluebubbles-webhook", method: "POST" } as IncomingMessage,
          res,
          { basePath: "/openclaw", root: { kind: "resolved", path: tmp } },
        );
        expect(handled).toBe(false);
      },
    });
  });

  it("does not handle /api paths when basePath is empty", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        for (const apiPath of ["/api", "/api/sessions", "/api/channels/nostr"]) {
          const { handled } = runControlUiRequest({
            url: apiPath,
            method: "GET",
            rootPath: tmp,
          });
          expect(handled, `expected ${apiPath} to not be handled`).toBe(false);
        }
      },
    });
  });

  it("does not handle /plugins paths when basePath is empty", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        for (const pluginPath of ["/plugins", "/plugins/diffs/view/abc/def"]) {
          const { handled } = runControlUiRequest({
            url: pluginPath,
            method: "GET",
            rootPath: tmp,
          });
          expect(handled, `expected ${pluginPath} to not be handled`).toBe(false);
        }
      },
    });
  });

  it("falls through POST requests when basePath is empty", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        const { handled, end } = runControlUiRequest({
          url: "/webhook/bluebubbles",
          method: "POST",
          rootPath: tmp,
        });
        expect(handled).toBe(false);
        expect(end).not.toHaveBeenCalled();
      },
    });
  });

  it("falls through POST requests under configured basePath (plugin webhook passthrough)", async () => {
    await withControlUiRoot({
      fn: async (tmp) => {
        for (const route of ["/openclaw", "/openclaw/", "/openclaw/some-page"]) {
          const { handled, end } = runControlUiRequest({
            url: route,
            method: "POST",
            rootPath: tmp,
            basePath: "/openclaw",
          });
          expect(handled, `POST to ${route} should pass through to plugin handlers`).toBe(false);
          expect(end, `POST to ${route} should not write a response`).not.toHaveBeenCalled();
        }
      },
    });
  });

  it("rejects absolute-path escape attempts under basePath routes", async () => {
    await withBasePathRootFixture({
      siblingDir: "ui-secrets",
      fn: async ({ root, sibling }) => {
        const secretPath = path.join(sibling, "secret.txt");
        await fs.writeFile(secretPath, "sensitive-data");

        const secretPathUrl = secretPath.split(path.sep).join("/");
        const absolutePathUrl = secretPathUrl.startsWith("/") ? secretPathUrl : `/${secretPathUrl}`;
        const { res, end, handled } = runControlUiRequest({
          url: `/openclaw/${absolutePathUrl}`,
          method: "GET",
          rootPath: root,
          basePath: "/openclaw",
        });
        expectNotFoundResponse({ handled, res, end });
      },
    });
  });

  it("rejects symlink escape attempts under basePath routes", async () => {
    await withBasePathRootFixture({
      siblingDir: "outside",
      fn: async ({ root, sibling }) => {
        await fs.mkdir(path.join(root, "assets"), { recursive: true });
        const secretPath = path.join(sibling, "secret.txt");
        await fs.writeFile(secretPath, "sensitive-data");

        const linkPath = path.join(root, "assets", "leak.txt");
        try {
          await fs.symlink(secretPath, linkPath, "file");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EPERM") {
            return;
          }
          throw error;
        }

        const { res, end, handled } = runControlUiRequest({
          url: "/openclaw/assets/leak.txt",
          method: "GET",
          rootPath: root,
          basePath: "/openclaw",
        });
        expectNotFoundResponse({ handled, res, end });
      },
    });
  });
});
