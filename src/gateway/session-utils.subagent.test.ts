import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../agents/subagent-registry.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, type SessionEntry } from "../config/sessions.js";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../infra/agent-events.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { withEnv } from "../test-utils/env.js";
import {
  buildGatewaySessionRow,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  resolveGatewayModelSupportsImages,
} from "./session-utils.js";

describe("listSessionsFromStore subagent metadata", () => {
  afterEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    resetAgentRunContextForTest();
  });
  beforeEach(() => {
    resetSubagentRegistryForTests({ persist: false });
    resetAgentRunContextForTest();
  });

  const cfg = {
    session: { mainKey: "main" },
    agents: { list: [{ id: "main", default: true }] },
  } as OpenClawConfig;

  test("projects Judge guard audit entries into dashboard session rows", () => {
    const row = buildGatewaySessionRow({
      cfg,
      storePath: "/tmp/sessions.json",
      store: {},
      key: "agent:main:main",
      entry: {
        sessionId: "sess-main",
        updatedAt: 10,
        judgeGuardAudit: [
          {
            ts: 9,
            runId: "run-judge-guard",
            action: "rewrote_final_success_claim",
            verdictStatus: "parsed",
            verdict: "REJECT",
            scope: "build completion",
            risk: "medium",
            conditions: "rerun build",
            payloadsChecked: 1,
            payloadsRewritten: 1,
          },
        ],
      } as SessionEntry,
    });

    expect(row.judgeGuardAudit).toEqual([
      expect.objectContaining({
        runId: "run-judge-guard",
        verdict: "REJECT",
        scope: "build completion",
        payloadsRewritten: 1,
      }),
    ]);
  });

  test("projects Control Director guard audit entries into dashboard session rows", () => {
    const row = buildGatewaySessionRow({
      cfg,
      storePath: "/tmp/sessions.json",
      store: {},
      key: "agent:main:main",
      entry: {
        sessionId: "sess-main",
        updatedAt: 10,
        controlDirectorGuardAudit: [
          {
            ts: 9,
            runId: "run-control-director-guard",
            action: "rewrote_unsupported_complete",
            originalStatus: "complete",
            nextStatus: "blocked",
            missing: ["evidence"],
            payloadsChecked: 1,
            payloadsRewritten: 1,
          },
        ],
      } as SessionEntry,
    });

    expect(row.controlDirectorGuardAudit).toEqual([
      expect.objectContaining({
        runId: "run-control-director-guard",
        action: "rewrote_unsupported_complete",
        nextStatus: "blocked",
        payloadsRewritten: 1,
      }),
    ]);
  });

  test("projects Control Director liveness audit and mission ledger into dashboard session rows", () => {
    const row = buildGatewaySessionRow({
      cfg,
      storePath: "/tmp/sessions.json",
      store: {},
      key: "agent:main:main",
      entry: {
        sessionId: "sess-main",
        updatedAt: 10,
        controlDirectorLivenessAudit: [
          {
            ts: 9,
            runId: "run-control-director-liveness",
            action: "queued_safe_continuation",
            reason: "empty final response",
            classification: "empty",
            nextStatus: "blocked",
            continuationCount: 0,
            continuationQueued: true,
            payloadsChecked: 0,
            payloadsSynthesized: 1,
          },
        ],
        controlDirectorMissionLedger: [
          {
            missionId: "control-director:run-control-director-liveness",
            runId: "run-control-director-liveness",
            requestSummary: "continue until done",
            status: "continuation_queued",
            startedAt: 8,
            updatedAt: 9,
            continuationCount: 1,
            finalStatus: "blocked",
            verifiedEvidenceSummary: "liveness watchdog synthesized a blocked report",
            nextBuildGap: "queued continuation must verify evidence",
            completionGrade: 7,
            criticality: 10,
            judgeCompletionGate: {
              status: "blocked",
              reason:
                "Judge approval is missing or invalid for this exact mission completion claim.",
              expectedClaimHash: "claim-hash-1",
              missing: ["Judge approval metadata"],
            },
            truthAudit: {
              ts: 9,
              runId: "run-control-director-liveness",
              status: "blocked",
              claims: [
                {
                  claim: "Remote proof passed on GitHub Actions.",
                  claimHash: "truth-claim-hash-1",
                  claimType: "remote_proof",
                  requiredEvidenceType: "github_run",
                  matchStatus: "missing",
                  missingCondition: "successful GitHub run evidence for the implementation SHA",
                  rewriteAction: "blocked_unsupported_truth_claim",
                },
              ],
              missing: ["successful GitHub run evidence for the implementation SHA"],
              payloadsChecked: 1,
              payloadsRewritten: 1,
            },
            watchdogActions: ["queued_safe_continuation:queued"],
          },
        ],
        controlDirectorJudgeCompletionApproval: {
          judgeStatus: "approved",
          judgeVerdict: "APPROVE",
          judgeRunId: "judge-run-1",
          missionId: "control-director:run-control-director-liveness",
          approvedClaimHash: "claim-hash-1",
          evidenceSummary: "verified remote proof",
          scope: "Control Director completion",
          approvedAt: 123,
        },
        controlDirectorTruthAudit: [
          {
            ts: 9,
            runId: "run-control-director-liveness",
            status: "blocked",
            claims: [
              {
                claim: "Remote proof passed on GitHub Actions.",
                claimHash: "truth-claim-hash-1",
                claimType: "remote_proof",
                requiredEvidenceType: "github_run",
                matchStatus: "missing",
                missingCondition: "successful GitHub run evidence for the implementation SHA",
                rewriteAction: "blocked_unsupported_truth_claim",
              },
            ],
            missing: ["successful GitHub run evidence for the implementation SHA"],
            payloadsChecked: 1,
            payloadsRewritten: 1,
          },
        ],
      } as SessionEntry,
    });

    expect(row.controlDirectorLivenessAudit).toEqual([
      expect.objectContaining({
        runId: "run-control-director-liveness",
        action: "queued_safe_continuation",
        continuationQueued: true,
      }),
    ]);
    expect(row.controlDirectorMissionLedger).toEqual([
      expect.objectContaining({
        missionId: "control-director:run-control-director-liveness",
        status: "continuation_queued",
        continuationCount: 1,
        judgeCompletionGate: expect.objectContaining({
          status: "blocked",
          expectedClaimHash: "claim-hash-1",
        }),
        truthAudit: expect.objectContaining({
          status: "blocked",
          payloadsRewritten: 1,
        }),
      }),
    ]);
    expect(row.controlDirectorJudgeCompletionApproval).toEqual(
      expect.objectContaining({
        judgeStatus: "approved",
        judgeVerdict: "APPROVE",
        judgeRunId: "judge-run-1",
        approvedClaimHash: "claim-hash-1",
      }),
    );
    expect(row.controlDirectorTruthAudit).toEqual([
      expect.objectContaining({
        runId: "run-control-director-liveness",
        status: "blocked",
        payloadsRewritten: 1,
      }),
    ]);
  });

  test("searches channel-derived display names before row enrichment", () => {
    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store: {
        "agent:main:slack:group:general": {
          sessionId: "slack-general-session",
          updatedAt: 2,
          channel: "slack",
        } as SessionEntry,
        "agent:main:discord:group:random": {
          sessionId: "discord-random-session",
          updatedAt: 1,
          channel: "discord",
        } as SessionEntry,
      },
      opts: { search: "slack:g-general" },
    });

    expect(result.sessions.map((session) => session.key)).toEqual([
      "agent:main:slack:group:general",
    ]);
    expect(result.sessions[0]?.displayName).toBe("slack:g-general");
  });

  test("applies limit before transcript enrichment", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:newest": {
        sessionId: "newest-session",
        sessionFile: "/tmp/newest-session.jsonl",
        updatedAt: 300,
      } as SessionEntry,
      "agent:main:middle": {
        sessionId: "middle-session",
        sessionFile: "/tmp/middle-session.jsonl",
        updatedAt: 200,
      } as SessionEntry,
      "agent:main:oldest": {
        sessionId: "old-session",
        sessionFile: "/tmp/old-session.jsonl",
        updatedAt: 100,
      } as SessionEntry,
    };
    const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    try {
      const result = listSessionsFromStore({
        cfg,
        storePath: "/tmp/sessions.json",
        store,
        opts: { limit: 2 },
      });

      expect(result.sessions.map((session) => session.sessionId)).toEqual([
        "newest-session",
        "middle-session",
      ]);
      expect(existsSpy.mock.calls.flat().join("\n")).not.toContain("old-session");
    } finally {
      existsSpy.mockRestore();
    }
  });

  test("projects Control Director diagnostic fields onto session rows", () => {
    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store: {
        "agent:main:main": {
          sessionId: "sess-control-director",
          updatedAt: 123,
          controlDirectorGuardAudit: [
            {
              ts: 10,
              runId: "run-1",
              action: "blocked_missing_judge_approval",
              originalStatus: "complete",
              nextStatus: "blocked",
              missing: ["judge approval"],
              payloadsChecked: 1,
              payloadsRewritten: 1,
            },
          ],
          controlDirectorLivenessAudit: [
            {
              ts: 11,
              runId: "run-1",
              action: "synthesized_blocked_no_visible_output",
              reason: "empty final output",
              source: "terminal_empty",
              classification: "empty",
              nextStatus: "blocked",
              continuationCount: 0,
              continuationQueued: false,
              payloadsChecked: 1,
              payloadsSynthesized: 1,
            },
          ],
          controlDirectorMissionLedger: [
            {
              missionId: "mission-1",
              runId: "run-1",
              requestSummary: "verify completion",
              status: "blocked",
              startedAt: 1,
              updatedAt: 12,
              continuationCount: 0,
              finalStatus: "blocked",
              nextBuildGap: "obtain Judge approval",
              completionGrade: 8,
              criticality: 10,
            },
          ],
          controlDirectorJudgeCompletionApproval: {
            judgeStatus: "rejected",
            judgeVerdict: "REQUEST_MORE_EVIDENCE",
            judgeRunId: "judge-1",
            missionId: "mission-1",
            evidenceSummary: "missing command proof",
          },
          controlDirectorTruthAudit: [
            {
              ts: 12,
              runId: "run-1",
              status: "blocked",
              missing: ["command exit code 0"],
              payloadsChecked: 1,
              payloadsRewritten: 1,
              claims: [
                {
                  claim: "tests passed",
                  claimHash: "hash-1",
                  claimType: "verification",
                  requiredEvidenceType: "command",
                  matchStatus: "missing",
                  missingCondition: "missing command evidence with exit code 0",
                  rewriteAction: "blocked_unsupported_truth_claim",
                },
              ],
            },
          ],
        } as SessionEntry,
      },
      opts: {},
    });

    const row = result.sessions[0];
    expect(row?.controlDirectorGuardAudit?.[0]?.action).toBe("blocked_missing_judge_approval");
    expect(row?.controlDirectorLivenessAudit?.[0]?.source).toBe("terminal_empty");
    expect(row?.controlDirectorMissionLedger?.[0]?.nextBuildGap).toBe("obtain Judge approval");
    expect(row?.controlDirectorJudgeCompletionApproval?.judgeVerdict).toBe("REQUEST_MORE_EVIDENCE");
    expect(row?.controlDirectorTruthAudit?.[0]?.claims[0]?.missingCondition).toBe(
      "missing command evidence with exit code 0",
    );
  });

  test("includes subagent status timing and direct child session keys", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:parent": {
        sessionId: "sess-parent",
        updatedAt: now - 2_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:child": {
        sessionId: "sess-child",
        updatedAt: now - 1_000,
        spawnedBy: "agent:main:subagent:parent",
        spawnedWorkspaceDir: "/tmp/child-workspace",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
      } as SessionEntry,
      "agent:main:subagent:failed": {
        sessionId: "sess-failed",
        updatedAt: now - 500,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-parent",
      childSessionKey: "agent:main:subagent:parent",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "parent task",
      cleanup: "keep",
      createdAt: now - 10_000,
      startedAt: now - 9_000,
      model: "openai/gpt-5.4",
    });
    registerAgentRunContext("run-parent", {
      sessionKey: "agent:main:subagent:parent",
    });
    addSubagentRunForTests({
      runId: "run-child",
      childSessionKey: "agent:main:subagent:child",
      controllerSessionKey: "agent:main:subagent:parent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "child task",
      cleanup: "keep",
      createdAt: now - 8_000,
      startedAt: now - 7_500,
      endedAt: now - 2_500,
      outcome: { status: "ok" },
      model: "openai/gpt-5.4",
    });
    addSubagentRunForTests({
      runId: "run-failed",
      childSessionKey: "agent:main:subagent:failed",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "failed task",
      cleanup: "keep",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 500,
      outcome: { status: "error", error: "boom" },
      model: "openai/gpt-5.4",
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const main = result.sessions.find((session) => session.key === "agent:main:main");
    expect(main?.childSessions).toEqual([
      "agent:main:subagent:parent",
      "agent:main:subagent:failed",
    ]);
    expect(main?.status).toBeUndefined();

    const parent = result.sessions.find((session) => session.key === "agent:main:subagent:parent");
    expect(parent?.status).toBe("running");
    expect(parent?.startedAt).toBe(now - 9_000);
    expect(parent?.endedAt).toBeUndefined();
    expect(parent?.runtimeMs).toBeGreaterThanOrEqual(9_000);
    expect(parent?.childSessions).toEqual(["agent:main:subagent:child"]);

    const child = result.sessions.find((session) => session.key === "agent:main:subagent:child");
    expect(child?.status).toBe("done");
    expect(child?.startedAt).toBe(now - 7_500);
    expect(child?.endedAt).toBe(now - 2_500);
    expect(child?.runtimeMs).toBe(5_000);
    expect(child?.spawnedWorkspaceDir).toBe("/tmp/child-workspace");
    expect(child?.forkedFromParent).toBe(true);
    expect(child?.spawnDepth).toBe(2);
    expect(child?.subagentRole).toBe("orchestrator");
    expect(child?.subagentControlScope).toBe("children");
    expect(child?.childSessions).toBeUndefined();

    const failed = result.sessions.find((session) => session.key === "agent:main:subagent:failed");
    expect(failed?.status).toBe("failed");
    expect(failed?.runtimeMs).toBe(5_000);
  });

  test("does not show stale registry-only subagent runs as actively running", () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:stale-display";
    const store: Record<string, SessionEntry> = {
      [childSessionKey]: {
        sessionId: "sess-stale-display",
        updatedAt: now - 250,
        spawnedBy: "agent:main:main",
        status: "done",
        startedAt: now - 4_000,
        endedAt: now - 500,
        runtimeMs: 3_500,
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-stale-display",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale display task",
      cleanup: "keep",
      createdAt: now - 5_000,
      startedAt: now - 4_000,
      model: "openai/gpt-5.4",
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const row = result.sessions.find((session) => session.key === childSessionKey);
    expect(row?.status).toBe("done");
    expect(row?.subagentRunState).toBe("historical");
    expect(row?.hasActiveSubagentRun).toBe(false);
    expect(row?.endedAt).toBe(now - 500);
    expect(row?.runtimeMs).toBe(3_500);
  });

  test("does not keep childSessions attached to a stale older controller row", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:old-parent": {
        sessionId: "sess-old-parent",
        updatedAt: now - 4_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:new-parent": {
        sessionId: "sess-new-parent",
        updatedAt: now - 3_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:shared-child": {
        sessionId: "sess-shared-child",
        updatedAt: now - 1_000,
        spawnedBy: "agent:main:subagent:new-parent",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-old-parent",
      childSessionKey: "agent:main:subagent:old-parent",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old parent task",
      cleanup: "keep",
      createdAt: now - 10_000,
      startedAt: now - 9_000,
    });
    addSubagentRunForTests({
      runId: "run-new-parent",
      childSessionKey: "agent:main:subagent:new-parent",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new parent task",
      cleanup: "keep",
      createdAt: now - 8_000,
      startedAt: now - 7_000,
    });
    addSubagentRunForTests({
      runId: "run-child-stale-parent",
      childSessionKey: "agent:main:subagent:shared-child",
      controllerSessionKey: "agent:main:subagent:old-parent",
      requesterSessionKey: "agent:main:subagent:old-parent",
      requesterDisplayKey: "old-parent",
      task: "shared child stale parent",
      cleanup: "keep",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 4_500,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-child-current-parent",
      childSessionKey: "agent:main:subagent:shared-child",
      controllerSessionKey: "agent:main:subagent:new-parent",
      requesterSessionKey: "agent:main:subagent:new-parent",
      requesterDisplayKey: "new-parent",
      task: "shared child current parent",
      cleanup: "keep",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const oldParent = result.sessions.find(
      (session) => session.key === "agent:main:subagent:old-parent",
    );
    const newParent = result.sessions.find(
      (session) => session.key === "agent:main:subagent:new-parent",
    );

    expect(oldParent?.childSessions).toBeUndefined();
    expect(newParent?.childSessions).toEqual(["agent:main:subagent:shared-child"]);
  });

  test("does not reattach moved children through stale spawnedBy store metadata", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:old-parent-store": {
        sessionId: "sess-old-parent-store",
        updatedAt: now - 4_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:new-parent-store": {
        sessionId: "sess-new-parent-store",
        updatedAt: now - 3_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:shared-child-store": {
        sessionId: "sess-shared-child-store",
        updatedAt: now - 1_000,
        spawnedBy: "agent:main:subagent:old-parent-store",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-old-parent-store",
      childSessionKey: "agent:main:subagent:old-parent-store",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old parent store task",
      cleanup: "keep",
      createdAt: now - 10_000,
      startedAt: now - 9_000,
    });
    addSubagentRunForTests({
      runId: "run-new-parent-store",
      childSessionKey: "agent:main:subagent:new-parent-store",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new parent store task",
      cleanup: "keep",
      createdAt: now - 8_000,
      startedAt: now - 7_000,
    });
    addSubagentRunForTests({
      runId: "run-child-store-stale-parent",
      childSessionKey: "agent:main:subagent:shared-child-store",
      controllerSessionKey: "agent:main:subagent:old-parent-store",
      requesterSessionKey: "agent:main:subagent:old-parent-store",
      requesterDisplayKey: "old-parent-store",
      task: "shared child stale store parent",
      cleanup: "keep",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 4_500,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-child-store-current-parent",
      childSessionKey: "agent:main:subagent:shared-child-store",
      controllerSessionKey: "agent:main:subagent:new-parent-store",
      requesterSessionKey: "agent:main:subagent:new-parent-store",
      requesterDisplayKey: "new-parent-store",
      task: "shared child current store parent",
      cleanup: "keep",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const oldParent = result.sessions.find(
      (session) => session.key === "agent:main:subagent:old-parent-store",
    );
    const newParent = result.sessions.find(
      (session) => session.key === "agent:main:subagent:new-parent-store",
    );

    expect(oldParent?.childSessions).toBeUndefined();
    expect(newParent?.childSessions).toEqual(["agent:main:subagent:shared-child-store"]);
  });

  test("does not return moved child sessions from stale spawnedBy filters", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:old-parent-filter": {
        sessionId: "sess-old-parent-filter",
        updatedAt: now - 4_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:new-parent-filter": {
        sessionId: "sess-new-parent-filter",
        updatedAt: now - 3_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      "agent:main:subagent:shared-child-filter": {
        sessionId: "sess-shared-child-filter",
        updatedAt: now - 1_000,
        spawnedBy: "agent:main:subagent:old-parent-filter",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-old-parent-filter",
      childSessionKey: "agent:main:subagent:old-parent-filter",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old parent filter task",
      cleanup: "keep",
      createdAt: now - 10_000,
      startedAt: now - 9_000,
    });
    addSubagentRunForTests({
      runId: "run-new-parent-filter",
      childSessionKey: "agent:main:subagent:new-parent-filter",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "new parent filter task",
      cleanup: "keep",
      createdAt: now - 8_000,
      startedAt: now - 7_000,
    });
    addSubagentRunForTests({
      runId: "run-child-filter-stale-parent",
      childSessionKey: "agent:main:subagent:shared-child-filter",
      controllerSessionKey: "agent:main:subagent:old-parent-filter",
      requesterSessionKey: "agent:main:subagent:old-parent-filter",
      requesterDisplayKey: "old-parent-filter",
      task: "shared child stale filter parent",
      cleanup: "keep",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 4_500,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-child-filter-current-parent",
      childSessionKey: "agent:main:subagent:shared-child-filter",
      controllerSessionKey: "agent:main:subagent:new-parent-filter",
      requesterSessionKey: "agent:main:subagent:new-parent-filter",
      requesterDisplayKey: "new-parent-filter",
      task: "shared child current filter parent",
      cleanup: "keep",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {
        spawnedBy: "agent:main:subagent:old-parent-filter",
      },
    });

    expect(result.sessions.map((session) => session.key)).toStrictEqual([]);
  });

  test("reports the newest run owner for moved child session rows", () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:shared-child-owner";
    const store: Record<string, SessionEntry> = {
      [childSessionKey]: {
        sessionId: "sess-shared-child-owner",
        updatedAt: now,
        spawnedBy: "agent:main:subagent:old-parent-owner",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-child-owner-stale-parent",
      childSessionKey,
      controllerSessionKey: "agent:main:subagent:old-parent-owner",
      requesterSessionKey: "agent:main:subagent:old-parent-owner",
      requesterDisplayKey: "old-parent-owner",
      task: "shared child stale owner parent",
      cleanup: "keep",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 4_500,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-child-owner-current-parent",
      childSessionKey,
      controllerSessionKey: "agent:main:subagent:new-parent-owner",
      requesterSessionKey: "agent:main:subagent:new-parent-owner",
      requesterDisplayKey: "new-parent-owner",
      task: "shared child current owner parent",
      cleanup: "keep",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      key: childSessionKey,
      spawnedBy: "agent:main:subagent:new-parent-owner",
    });
  });

  test("reports the newest parentSessionKey for moved child session rows", () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:shared-child-parent";
    const store: Record<string, SessionEntry> = {
      [childSessionKey]: {
        sessionId: "sess-shared-child-parent",
        updatedAt: now,
        parentSessionKey: "agent:main:subagent:old-parent-parent",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-child-parent-stale-parent",
      childSessionKey,
      controllerSessionKey: "agent:main:subagent:old-parent-parent",
      requesterSessionKey: "agent:main:subagent:old-parent-parent",
      requesterDisplayKey: "old-parent-parent",
      task: "shared child stale parentSessionKey parent",
      cleanup: "keep",
      createdAt: now - 6_000,
      startedAt: now - 5_500,
      endedAt: now - 4_500,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-child-parent-current-parent",
      childSessionKey,
      controllerSessionKey: "agent:main:subagent:new-parent-parent",
      requesterSessionKey: "agent:main:subagent:new-parent-parent",
      requesterDisplayKey: "new-parent-parent",
      task: "shared child current parentSessionKey parent",
      cleanup: "keep",
      createdAt: now - 2_000,
      startedAt: now - 1_500,
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      key: childSessionKey,
      parentSessionKey: "agent:main:subagent:new-parent-parent",
    });
  });

  test("preserves original session timing across follow-up replacement runs", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:followup": {
        sessionId: "sess-followup",
        updatedAt: now,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-followup-new",
      childSessionKey: "agent:main:subagent:followup",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "follow-up task",
      cleanup: "keep",
      createdAt: now - 10_000,
      startedAt: now - 30_000,
      sessionStartedAt: now - 150_000,
      accumulatedRuntimeMs: 120_000,
      model: "openai/gpt-5.4",
    });
    registerAgentRunContext("run-followup-new", {
      sessionKey: "agent:main:subagent:followup",
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const followup = result.sessions.find(
      (session) => session.key === "agent:main:subagent:followup",
    );
    expect(followup?.status).toBe("running");
    expect(followup?.startedAt).toBe(now - 150_000);
    expect(followup?.runtimeMs).toBeGreaterThanOrEqual(150_000);
  });

  test("uses the newest child-session row for stale/current replacement pairs", () => {
    const now = Date.now();
    const childSessionKey = "agent:main:subagent:stale-current";
    const store: Record<string, SessionEntry> = {
      [childSessionKey]: {
        sessionId: "sess-stale-current",
        updatedAt: now,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-stale-active",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale active row",
      cleanup: "keep",
      createdAt: now - 5_000,
      startedAt: now - 4_500,
      model: "openai/gpt-5.4",
    });
    addSubagentRunForTests({
      runId: "run-current-ended",
      childSessionKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current ended row",
      cleanup: "keep",
      createdAt: now - 1_000,
      startedAt: now - 900,
      endedAt: now - 200,
      outcome: { status: "ok" },
      model: "openai/gpt-5.4",
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      key: childSessionKey,
      status: "done",
      startedAt: now - 900,
      endedAt: now - 200,
    });
  });

  test("prefers persisted terminal session state when only stale active subagent snapshots remain", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-session-utils-subagent-"));
    const stateDir = path.join(tempRoot, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    try {
      const now = Date.now();
      const childSessionKey = "agent:main:subagent:disk-live";
      const registryPath = path.join(stateDir, "subagents", "runs.json");
      fs.mkdirSync(path.dirname(registryPath), { recursive: true });
      fs.writeFileSync(
        registryPath,
        JSON.stringify(
          {
            version: 2,
            runs: {
              "run-complete": {
                runId: "run-complete",
                childSessionKey,
                requesterSessionKey: "agent:main:main",
                requesterDisplayKey: "main",
                task: "finished too early",
                cleanup: "keep",
                createdAt: now - 2_000,
                startedAt: now - 1_900,
                endedAt: now - 1_800,
                outcome: { status: "ok" },
              },
              "run-live": {
                runId: "run-live",
                childSessionKey,
                requesterSessionKey: "agent:main:main",
                requesterDisplayKey: "main",
                task: "still running",
                cleanup: "keep",
                createdAt: now - 10_000,
                startedAt: now - 9_000,
              },
            },
          },
          null,
          2,
        ),
        "utf-8",
      );

      const row = withEnv(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK: "1",
        },
        () => {
          const result = listSessionsFromStore({
            cfg,
            storePath: "/tmp/sessions.json",
            store: {
              [childSessionKey]: {
                sessionId: "sess-disk-live",
                updatedAt: now,
                spawnedBy: "agent:main:main",
                status: "done",
                endedAt: now - 1_800,
                runtimeMs: 100,
              } as SessionEntry,
            },
            opts: {},
          });
          return result.sessions.find((session) => session.key === childSessionKey);
        },
      );

      expect(row?.status).toBe("done");
      expect(row?.subagentRunState).toBe("historical");
      expect(row?.hasActiveSubagentRun).toBe(false);
      expect(row?.startedAt).toBe(now - 9_000);
      expect(row?.endedAt).toBe(now - 1_800);
      expect(row?.runtimeMs).toBe(100);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("reuses one subagent registry disk snapshot across sessions.list filtering and row enrichment", () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-session-utils-subagent-cache-"),
    );
    const stateDir = path.join(tempRoot, "state");
    const registryPath = path.join(stateDir, "subagents", "runs.json");
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    const now = Date.now();
    const controllerSessionKey = "agent:main:main";
    const childKeys = [
      "agent:main:subagent:cache-child-a",
      "agent:main:subagent:cache-child-b",
      "agent:main:subagent:cache-child-c",
    ];
    fs.writeFileSync(
      registryPath,
      JSON.stringify(
        {
          version: 2,
          runs: Object.fromEntries(
            childKeys.map((childSessionKey, index) => [
              `run-cache-child-${index}`,
              {
                runId: `run-cache-child-${index}`,
                childSessionKey,
                controllerSessionKey,
                requesterSessionKey: controllerSessionKey,
                requesterDisplayKey: "main",
                task: "cache test child",
                cleanup: "keep",
                createdAt: now - 5_000 + index,
                startedAt: now - 4_000 + index,
              },
            ]),
          ),
        },
        null,
        2,
      ),
      "utf-8",
    );

    const store: Record<string, SessionEntry> = {
      [controllerSessionKey]: {
        updatedAt: now,
      } as SessionEntry,
      [childKeys[0]]: {
        updatedAt: now - 1_000,
        spawnedBy: controllerSessionKey,
      } as SessionEntry,
      [childKeys[1]]: {
        updatedAt: now - 2_000,
        spawnedBy: controllerSessionKey,
      } as SessionEntry,
      [childKeys[2]]: {
        updatedAt: now - 3_000,
        spawnedBy: controllerSessionKey,
      } as SessionEntry,
    };

    const statSpy = vi.spyOn(fs, "statSync");
    try {
      const result = withEnv(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK: "1",
        },
        () =>
          listSessionsFromStore({
            cfg,
            storePath: "/tmp/sessions.json",
            store,
            opts: { spawnedBy: controllerSessionKey },
          }),
      );

      expect(result.sessions.map((session) => session.key)).toEqual(childKeys);
      const registryStatCount = statSpy.mock.calls.filter(
        ([pathname]) => path.normalize(String(pathname)) === path.normalize(registryPath),
      ).length;
      expect(registryStatCount).toBe(1);
    } finally {
      statSpy.mockRestore();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("does not read the subagent registry when raw filters drop every session", () => {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-session-utils-subagent-cache-empty-"),
    );
    const stateDir = path.join(tempRoot, "state");
    const registryPath = path.join(stateDir, "subagents", "runs.json");
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify({ version: 2, runs: {} }, null, 2), "utf-8");

    const statSpy = vi.spyOn(fs, "statSync");
    try {
      const result = withEnv(
        {
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_DISK: "1",
        },
        () =>
          listSessionsFromStore({
            cfg,
            storePath: "/tmp/sessions.json",
            store: {
              "agent:main:filtered-out": {
                label: "keep-me-out",
                updatedAt: Date.now(),
              } as SessionEntry,
            },
            opts: { label: "wanted-label" },
          }),
      );

      expect(result.sessions).toStrictEqual([]);
      const registryStatCount = statSpy.mock.calls.filter(
        ([pathname]) => path.normalize(String(pathname)) === path.normalize(registryPath),
      ).length;
      expect(registryStatCount).toBe(0);
    } finally {
      statSpy.mockRestore();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("includes explicit parentSessionKey relationships for dashboard child sessions", () => {
    resetSubagentRegistryForTests({ persist: false });
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:dashboard:child": {
        sessionId: "sess-child",
        updatedAt: now - 1_000,
        parentSessionKey: "agent:main:main",
      } as SessionEntry,
    };

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const main = result.sessions.find((session) => session.key === "agent:main:main");
    const child = result.sessions.find((session) => session.key === "agent:main:dashboard:child");
    expect(main?.childSessions).toEqual(["agent:main:dashboard:child"]);
    expect(child?.parentSessionKey).toBe("agent:main:main");
  });

  test("returns dashboard child sessions when filtering by parentSessionKey owner", () => {
    resetSubagentRegistryForTests({ persist: false });
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:dashboard:child": {
        sessionId: "sess-dashboard-child",
        updatedAt: now - 1_000,
        parentSessionKey: "agent:main:main",
      } as SessionEntry,
    };

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {
        spawnedBy: "agent:main:main",
      },
    });

    expect(result.sessions.map((session) => session.key)).toEqual(["agent:main:dashboard:child"]);
  });

  test("does not reattach stale terminal store-only child links", () => {
    resetSubagentRegistryForTests({ persist: false });
    const now = Date.now();
    const staleAt = now - 2 * 60 * 60_000;
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:claude:acp:done-child": {
        sessionId: "sess-done-child",
        updatedAt: staleAt,
        spawnedBy: "agent:main:main",
        status: "done",
        endedAt: staleAt,
      } as SessionEntry,
    };

    const all = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });
    const main = all.sessions.find((session) => session.key === "agent:main:main");
    expect(main?.childSessions).toBeUndefined();

    const filtered = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {
        spawnedBy: "agent:main:main",
      },
    });
    expect(filtered.sessions.map((session) => session.key)).toStrictEqual([]);
  });

  test("does not reattach stale orphan store-only child links without lifecycle fields", () => {
    resetSubagentRegistryForTests({ persist: false });
    const now = Date.now();
    const staleAt = now - 2 * 60 * 60_000;
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:orphan": {
        sessionId: "sess-orphan",
        updatedAt: staleAt,
        parentSessionKey: "agent:main:main",
      } as SessionEntry,
    };

    const all = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });
    const main = all.sessions.find((session) => session.key === "agent:main:main");
    expect(main?.childSessions).toBeUndefined();

    const filtered = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {
        spawnedBy: "agent:main:main",
      },
    });
    expect(filtered.sessions.map((session) => session.key)).toStrictEqual([]);
  });

  test("does not keep old ended registry runs attached as child sessions", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      "agent:main:subagent:old-ended": {
        sessionId: "sess-old-ended",
        updatedAt: now - 60 * 60_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-old-ended",
      childSessionKey: "agent:main:subagent:old-ended",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "old ended task",
      cleanup: "keep",
      createdAt: now - 60 * 60_000,
      startedAt: now - 59 * 60_000,
      endedAt: now - 31 * 60_000,
      outcome: { status: "ok" },
    });

    const all = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });
    const main = all.sessions.find((session) => session.key === "agent:main:main");
    expect(main?.childSessions).toBeUndefined();

    const filtered = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {
        spawnedBy: "agent:main:main",
      },
    });
    expect(filtered.sessions.map((session) => session.key)).toStrictEqual([]);
  });

  test("keeps ended parents attached while live descendants are still running", () => {
    const now = Date.now();
    const parentKey = "agent:main:subagent:ended-parent";
    const childKey = "agent:main:subagent:ended-parent:subagent:live-child";
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "sess-main",
        updatedAt: now,
      } as SessionEntry,
      [parentKey]: {
        sessionId: "sess-ended-parent",
        updatedAt: now - 31 * 60_000,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
      [childKey]: {
        sessionId: "sess-live-child",
        updatedAt: now,
        spawnedBy: parentKey,
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-ended-parent",
      childSessionKey: parentKey,
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "ended parent task",
      cleanup: "keep",
      createdAt: now - 60 * 60_000,
      startedAt: now - 59 * 60_000,
      endedAt: now - 31 * 60_000,
      outcome: { status: "ok" },
    });
    addSubagentRunForTests({
      runId: "run-live-child",
      childSessionKey: childKey,
      controllerSessionKey: parentKey,
      requesterSessionKey: parentKey,
      requesterDisplayKey: "ended-parent",
      task: "live child task",
      cleanup: "keep",
      createdAt: now - 1_000,
      startedAt: now - 900,
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });
    const main = result.sessions.find((session) => session.key === "agent:main:main");
    expect(main?.childSessions).toEqual([parentKey]);
  });

  test("falls back to persisted subagent timing after run archival", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:archived": {
        sessionId: "sess-archived",
        updatedAt: now,
        spawnedBy: "agent:main:main",
        startedAt: now - 20_000,
        endedAt: now - 5_000,
        runtimeMs: 15_000,
        status: "done",
      } as SessionEntry,
    };

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const archived = result.sessions.find(
      (session) => session.key === "agent:main:subagent:archived",
    );
    expect(archived?.status).toBe("done");
    expect(archived?.startedAt).toBe(now - 20_000);
    expect(archived?.endedAt).toBe(now - 5_000);
    expect(archived?.runtimeMs).toBe(15_000);
  });

  test("maps timeout outcomes to timeout status and clamps negative runtime", () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:subagent:timeout": {
        sessionId: "sess-timeout",
        updatedAt: now,
        spawnedBy: "agent:main:main",
      } as SessionEntry,
    };

    addSubagentRunForTests({
      runId: "run-timeout",
      childSessionKey: "agent:main:subagent:timeout",
      controllerSessionKey: "agent:main:main",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "timeout task",
      cleanup: "keep",
      createdAt: now - 10_000,
      startedAt: now - 1_000,
      endedAt: now - 2_000,
      outcome: { status: "timeout" },
      model: "openai/gpt-5.4",
    });

    const result = listSessionsFromStore({
      cfg,
      storePath: "/tmp/sessions.json",
      store,
      opts: {},
    });

    const timeout = result.sessions.find(
      (session) => session.key === "agent:main:subagent:timeout",
    );
    expect(timeout?.status).toBe("timeout");
    expect(timeout?.runtimeMs).toBe(0);
  });

  test("fails closed when model lookup misses", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "gpt-5.4",
        provider: "openai",
        loadGatewayModelCatalog: async () => [
          { id: "gpt-5.4", name: "GPT-5.4", provider: "other", input: ["text", "image"] },
        ],
      }),
    ).resolves.toBe(false);
  });

  test("fails closed when model catalog load throws", async () => {
    await expect(
      resolveGatewayModelSupportsImages({
        model: "gpt-5.4",
        provider: "openai",
        loadGatewayModelCatalog: async () => {
          throw new Error("catalog unavailable");
        },
      }),
    ).resolves.toBe(false);
  });
});

describe("loadCombinedSessionStoreForGateway includes disk-only agents (#32804)", () => {
  test("ACP agent sessions are visible even when agents.list is configured", async () => {
    await withStateDirEnv("openclaw-acp-vis-", async ({ stateDir }) => {
      const customRoot = path.join(stateDir, "custom-state");
      const agentsDir = path.join(customRoot, "agents");
      const mainDir = path.join(agentsDir, "main", "sessions");
      const codexDir = path.join(agentsDir, "codex", "sessions");
      fs.mkdirSync(mainDir, { recursive: true });
      fs.mkdirSync(codexDir, { recursive: true });

      fs.writeFileSync(
        path.join(mainDir, "sessions.json"),
        JSON.stringify({
          "agent:main:main": { sessionId: "s-main", updatedAt: 100 },
        }),
        "utf8",
      );

      fs.writeFileSync(
        path.join(codexDir, "sessions.json"),
        JSON.stringify({
          "agent:codex:acp-task": { sessionId: "s-codex", updatedAt: 200 },
        }),
        "utf8",
      );

      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: {
          list: [{ id: "main", default: true }],
        },
      } as OpenClawConfig;

      const { store } = loadCombinedSessionStoreForGateway(cfg);
      expect(store["agent:main:main"]).toMatchObject({ sessionId: "s-main" });
      expect(store["agent:codex:acp-task"]).toMatchObject({ sessionId: "s-codex" });
    });
  });

  test("agent-scoped loads read only matching agent stores", async () => {
    await withStateDirEnv("openclaw-acp-scoped-", async ({ stateDir }) => {
      const customRoot = path.join(stateDir, "custom-state");
      const agentsDir = path.join(customRoot, "agents");
      const mainDir = path.join(agentsDir, "main", "sessions");
      const codexDir = path.join(agentsDir, "codex", "sessions");
      fs.mkdirSync(mainDir, { recursive: true });
      fs.mkdirSync(codexDir, { recursive: true });

      const mainStorePath = path.join(mainDir, "sessions.json");
      const codexStorePath = path.join(codexDir, "sessions.json");
      fs.writeFileSync(
        mainStorePath,
        JSON.stringify({
          "agent:main:main": { sessionId: "s-main", updatedAt: 100 },
        }),
        "utf8",
      );
      fs.writeFileSync(
        codexStorePath,
        JSON.stringify({
          "agent:codex:acp-task": { sessionId: "s-codex", updatedAt: 200 },
        }),
        "utf8",
      );

      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: {
          list: [{ id: "main", default: true }],
        },
      } as OpenClawConfig;

      const readSpy = vi.spyOn(fs, "readFileSync");

      const { store, storePath } = loadCombinedSessionStoreForGateway(cfg, { agentId: "codex" });

      expect(storePath).toBe(fs.realpathSync.native(codexStorePath));
      expect(store["agent:codex:acp-task"]).toMatchObject({ sessionId: "s-codex" });
      expect(store["agent:main:main"]).toBeUndefined();
      const readPaths = readSpy.mock.calls
        .map((call) => call[0])
        .filter((arg): arg is string => typeof arg === "string");
      expect(readPaths).toContain(fs.realpathSync.native(codexStorePath));
      expect(readPaths).not.toContain(fs.realpathSync.native(mainStorePath));

      readSpy.mockRestore();
    });
  });

  test("keeps canonical single-target entries by reference", async () => {
    await withStateDirEnv("openclaw-acp-canonical-", async ({ stateDir }) => {
      const customRoot = path.join(stateDir, "custom-state");
      const codexDir = path.join(customRoot, "agents", "codex", "sessions");
      fs.mkdirSync(codexDir, { recursive: true });

      const codexStorePath = path.join(codexDir, "sessions.json");
      fs.writeFileSync(
        codexStorePath,
        JSON.stringify({
          "agent:codex:acp-task": {
            sessionId: "s-codex",
            updatedAt: 200,
            spawnedBy: "agent:codex:main",
          },
        }),
        "utf8",
      );

      const cfg = {
        session: {
          mainKey: "main",
          store: path.join(customRoot, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        agents: {
          list: [{ id: "codex", default: true }],
        },
      } as OpenClawConfig;

      const cachedStore = loadSessionStore(fs.realpathSync.native(codexStorePath), {
        clone: false,
      });
      const { store } = loadCombinedSessionStoreForGateway(cfg, { agentId: "codex" });

      expect(store["agent:codex:acp-task"]).toBe(cachedStore["agent:codex:acp-task"]);
    });
  });
});
