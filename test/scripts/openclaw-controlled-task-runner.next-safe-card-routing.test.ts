import { describe, expect, it } from "vitest";
import {
  buildTelegramSummary,
  isControlledTaskCompleted,
  pickNextIncompleteTask,
  resolveNextSafeTaskCardIdFromGraph,
  resolveNextSafeTaskProposalCard,
  resolveNextSafeTaskResolverCandidate,
} from "../../scripts/openclaw-controlled-task-runner.mjs";

function createGraph(): Record<string, unknown> {
  return {
    kind: "openclaw-card-framework-graph",
    validation: { ok: true },
    graph: {
      nodes: [
        { id: "component-controlled-runner", type: "component", label: "Controlled runner" },
        { id: "component-validation-gate", type: "component", label: "Validation gate" },
        { id: "component-channel", type: "component", label: "Channel" },
        { id: "component-trading-runtime", type: "component", label: "Trading runtime" },
        { id: "component-trading-risk-gate", type: "component", label: "Trading risk gate" },
        { id: "component-memory", type: "component", label: "Memory" },
        { id: "component-report-state", type: "component", label: "Report state" },
      ],
      links: [],
      missingLinks: [],
      duplicateNodeIds: [],
    },
  };
}

function createResolverReport(): Record<string, unknown> {
  return {
    schema: "openclaw.resolver-candidates.v1",
    candidates: [
      {
        id: "controlled-runner-resolver-candidate-routing",
        status: "ready_for_review",
        priority: "P1",
        blocker: { id: "resolution-executor-not-wired" },
        sourceEvidence: [
          {
            sourceId: "local-source-gap-checklist",
            sourceType: "local_report",
            trustLevel: "high",
            path: "reports/openclaw-execution-automation-source-gap-checklist.md",
          },
        ],
        risk: {
          level: "P1",
          runtimeMutationAllowed: false,
          externalWriteAllowed: false,
          liveTradingAllowed: false,
          requiresHumanReviewBeforeApply: true,
        },
        proposedCommand: {
          mode: "planned_only",
          command: "pnpm autonomous:resolver-candidates:check",
          autoExecute: false,
        },
        sameCaseRerun: {
          required: true,
          commands: [
            "pnpm autonomous:resolver-candidates:check",
            "pnpm check:openclaw-controlled-task-runner",
          ],
        },
        rollbackPath: [
          "Remove-Item -LiteralPath scripts/openclaw-resolver-candidates.mjs",
          "Remove-Item -LiteralPath scripts/check-openclaw-resolver-candidates.mjs",
        ],
      },
    ],
  };
}

function createResolverReportWithNextSafeCandidate(): Record<string, unknown> {
  return {
    ...createResolverReport(),
    nextSafeTask: {
      id: "controlled-runner-resolver-candidate-routing",
    },
  };
}

describe("openclaw-controlled-task-runner next-safe card routing", () => {
  it("routes core controlled runner task to controlled-runner card", () => {
    const cardId = resolveNextSafeTaskCardIdFromGraph(
      "controlled_task_runner_check",
      createGraph(),
    );
    expect(cardId).toBe("component-controlled-runner");
  });

  it("routes quote status task to trading-runtime card", () => {
    const cardId = resolveNextSafeTaskCardIdFromGraph("capital_quote_status_check", createGraph());
    expect(cardId).toBe("component-trading-runtime");
  });

  it("routes dmad trend task to report-state card", () => {
    const cardId = resolveNextSafeTaskCardIdFromGraph("dmad-trend", createGraph());
    expect(cardId).toBe("component-report-state");
  });

  it("respects explicit card: prefix", () => {
    const cardId = resolveNextSafeTaskCardIdFromGraph(
      "card:module-3d-viewpoint-node-model",
      createGraph(),
    );
    expect(cardId).toBe("module-3d-viewpoint-node-model");
  });

  it("falls back to validation-gate for unknown task ids", () => {
    const cardId = resolveNextSafeTaskCardIdFromGraph("unknown_custom_task", createGraph());
    expect(cardId).toBe("component-validation-gate");
  });

  it("prefers next_safe_task.card_id when card exists", () => {
    const resolved = resolveNextSafeTaskProposalCard(
      "capital_quote_status_check",
      "component-memory",
      createGraph(),
    );
    expect(resolved.cardId).toBe("component-memory");
    expect(resolved.source).toBe("next_safe_task.card_id");
  });

  it("falls back to task-id mapping when next_safe_task.card_id is invalid", () => {
    const resolved = resolveNextSafeTaskProposalCard(
      "capital_quote_status_check",
      "component-does-not-exist",
      createGraph(),
    );
    expect(resolved.cardId).toBe("component-trading-runtime");
    expect(resolved.source).toBe("task_id_mapping_fallback_from_invalid_next_safe_task.card_id");
  });

  it("routes next-safe resolver candidate metadata without auto execution", () => {
    const resolved = resolveNextSafeTaskResolverCandidate(
      "controlled-runner-resolver-candidate-routing",
      createResolverReport(),
    );
    expect(resolved?.id).toBe("controlled-runner-resolver-candidate-routing");
    expect(resolved?.blocker_id).toBe("resolution-executor-not-wired");
    expect(resolved?.planned_only).toBe(true);
    expect(resolved?.auto_execute).toBe(false);
    expect(resolved?.runtime_mutation_allowed).toBe(false);
    expect(resolved?.same_case_rerun).toContain("pnpm check:openclaw-controlled-task-runner");
    expect(resolved?.rollback_path).toContain(
      "Remove-Item -LiteralPath scripts/openclaw-resolver-candidates.mjs",
    );
  });

  it("returns null when no resolver candidate matches the next-safe task", () => {
    const resolved = resolveNextSafeTaskResolverCandidate(
      "unknown_custom_task",
      createResolverReport(),
    );
    expect(resolved).toBeNull();
  });

  it("uses resolver report nextSafeTask id when executable task id is different", () => {
    const resolved = resolveNextSafeTaskResolverCandidate(
      "controlled_task_runner_check",
      createResolverReportWithNextSafeCandidate(),
    );
    expect(resolved?.id).toBe("controlled-runner-resolver-candidate-routing");
    expect(resolved?.planned_only).toBe(true);
    expect(resolved?.auto_execute).toBe(false);
  });

  it("adds Telegram trading shortcuts machine lines to publish summary", () => {
    const summary = buildTelegramSummary(
      {
        generatedAt: "2026-05-24T21:33:02.781Z",
        lane: "resilience_hardening",
        readOnlyMode: true,
        core_result: "success",
        task: {
          id: "controlled_task_runner_check",
          label: "Controlled task runner check",
          fullCommand: "pnpm check:openclaw-controlled-task-runner",
          exitCode: 0,
          durationMs: 123,
        },
        remaining_blockers: [],
        validation_result: {},
        next_safe_task: {
          id: "openclaw-d-big-repair-check",
          command: "pnpm autonomous:inventory:check",
          reason: "continue safest controlled loop",
          resolver_candidate_id: "cron-watch-source-check",
          resolver_candidate_report_path: "reports/openclaw-resolver-candidates-latest.json",
        },
        risk: "low",
      },
      {
        tradingShortcutsReport: {
          status: "pass",
          summary: {
            checks: 185,
            failed: 0,
            shortcutCheckCountClosure: {
              machineLine:
                "shortcutChecks=185 failed=0 assistantClosure=40 okxClosure=17 fixtureCoverage=4 reportMachine=10 growthReason=assistant+okx+fixture+report-machine",
            },
            capitalOperatorPacketClosure: {
              status: "visible_blocked",
              reportRead: true,
              operatorCanExecute: false,
              noOrderWrite: true,
              sentOrder: false,
              readinessStatus: "blocked",
              adapterAckStatus: "blocked",
              dispatchPolicy: "blocked_do_not_send",
              blockerCount: 17,
              machineLine:
                "capitalOperatorPacket=blocked sha256=E515 readiness=blocked adapterAck=blocked operatorCanExecute=false noOrderWrite=true sentOrder=false blockers=17",
            },
            assistantClosure: {
              assistantLearningHint: {
                nextCommandShortRow: {
                  command: "sc:tr:audit / sc:tr:paperloop / sc:tr:assist",
                  gateVerified: true,
                  machineLine:
                    "nextCommandShortRow=sc:tr:audit/sc:tr:paperloop/sc:tr:assist gateVerified=true buttons=sc:tr:learn/sc:tr:audit/sc:tr:paperloop/sc:tr:assist",
                },
              },
            },
            okxCurrentReadinessHeartbeatOperationClosure: {
              telegramCallback: "sc:tr:okxrefresh",
              refreshCommand: "pnpm okx:current-readiness:refresh",
              schedulerNextRunAt: "2026-05-24T20:15:00.000Z",
              executeRequired: false,
              noOrderWrite: true,
              machineLine:
                "okxCurrentReadinessHeartbeat=idle current=ready refresh=not_needed telegram=sc:tr:okxrefresh command=okx:current-readiness:refresh schedulerNextRunAt=2026-05-24T20:15:00.000Z inventoryProbe=ready noOrderWrite=true",
            },
          },
        },
      },
    );

    expect(summary.telegram_trading_shortcuts).toEqual(
      expect.objectContaining({
        exists: true,
        status: "pass",
        checks: 185,
        failed: 0,
        gateVerified: true,
        machineLine: expect.stringContaining("shortcutChecks=185 failed=0"),
        capitalOperatorPacketMachineLine: expect.stringContaining("capitalOperatorPacket=blocked"),
        capitalOperatorPacketPublishMachineLine: expect.stringContaining(
          "operatorCanExecute=false",
        ),
        capitalOperatorPacketOperatorCanExecute: false,
        capitalOperatorPacketSentOrder: false,
        okxHeartbeatRefreshMachineLine: expect.stringContaining("schedulerNextRunAt="),
        nextCommandMachineLine: expect.stringContaining("nextCommandShortRow=sc:tr:audit"),
      }),
    );
    expect(summary.telegram_summary_oneline_zh_tw).toContain("快捷檢查=shortcutChecks=185");
    expect(summary.telegram_summary_oneline_zh_tw).toContain(
      "真單Packet=capitalOperatorPacket=blocked",
    );
    expect(summary.telegram_summary_oneline_zh_tw).toContain("operatorCanExecute=false");
    expect(summary.telegram_summary_oneline_zh_tw).toContain(
      "OKX心跳=okxHeartbeatRefresh=sc:tr:okxrefresh",
    );
    expect(summary.telegram_summary_oneline_zh_tw).toContain(
      "schedulerNextRunAt=2026-05-24T20:15:00.000Z",
    );
    expect(summary.telegram_summary_oneline_zh_tw).toContain(
      "下一步指令=nextCommandShortRow=sc:tr:audit",
    );
    expect(summary.telegram_summary_oneline).toContain("tradingShortcuts=shortcutChecks=185");
    expect(summary.telegram_summary_oneline).toContain(
      "operatorPacket=capitalOperatorPacket=blocked",
    );
    expect(summary.telegram_summary_oneline).toContain("operatorCanExecute=false");
    expect(summary.telegram_summary_oneline).toContain(
      "okxHeartbeat=okxHeartbeatRefresh=sc:tr:okxrefresh",
    );
    expect(summary.telegram_summary_oneline).toContain(
      "schedulerNextRunAt=2026-05-24T20:15:00.000Z",
    );
    expect(summary.telegram_summary_oneline).toContain(
      "shortcutNext=nextCommandShortRow=sc:tr:audit",
    );
  });

  it("classifies completed Capital status tasks from live artifacts", () => {
    expect(
      isControlledTaskCompleted("capital_service_status", {
        capitalServiceStatus: {
          exists: true,
          ready: true,
          quoteReady: true,
          quoteStatus: "fresh",
          staleQuoteReturned: false,
        },
      }),
    ).toBe(true);

    expect(
      isControlledTaskCompleted("capital_telegram_owner_check", {
        capitalTelegramOwnerCheck: {
          ready: true,
          readOnly: true,
          liveTradingEnabled: false,
          writeTradingEnabled: false,
        },
      }),
    ).toBe(true);

    expect(
      isControlledTaskCompleted("capital_telegram_owner_contract_check", {
        capitalTelegramOwnerCheck: {
          ready: true,
          readOnly: true,
          liveTradingEnabled: false,
          writeTradingEnabled: false,
        },
      }),
    ).toBe(true);

    expect(
      isControlledTaskCompleted("autonomous_inventory_check", {
        autonomousInventory: {
          summary: { ok: true },
        },
      }),
    ).toBe(true);

    expect(
      isControlledTaskCompleted("paper_hft_fill_simulation", {
        capitalPaperFillSimulation: {
          exists: true,
          status: "ok",
          readOnly: true,
          liveTradingEnabled: false,
          writeTradingEnabled: false,
          brokerOrderPathEnabled: false,
        },
      }),
    ).toBe(true);

    expect(
      isControlledTaskCompleted("paper_hft_strategy_evaluate", {
        capitalPaperStrategyEvaluation: {
          exists: true,
          status: "evaluated",
          readOnly: true,
          liveTradingEnabled: false,
          writeTradingEnabled: false,
          brokerOrderPathEnabled: false,
        },
      }),
    ).toBe(true);

    expect(
      isControlledTaskCompleted("paper_hft_auto_review", {
        capitalPaperAutoReview: {
          exists: true,
          status: "already_approved",
          readOnly: true,
          liveTradingEnabled: false,
          writeTradingEnabled: false,
          brokerOrderPathEnabled: false,
        },
      }),
    ).toBe(true);

    expect(
      isControlledTaskCompleted("paper_loop_error_repair", {
        capitalPaperErrorRepair: {
          exists: true,
          repairStatus: "healthy",
          readOnly: true,
          liveTradingEnabled: false,
          writeTradingEnabled: false,
          brokerOrderPathEnabled: false,
        },
      }),
    ).toBe(true);

    expect(
      isControlledTaskCompleted("strategy_fill_simulation", {
        capitalStrategyFillSimulation: {
          exists: true,
          status: "ok",
          liveTradingEnabled: false,
          writeTradingEnabled: false,
          brokerOrderPathEnabled: false,
        },
      }),
    ).toBe(true);

    expect(
      isControlledTaskCompleted("hermes-nuwa-bridge", {
        hermesNuwaBridge: {
          exists: true,
          status: "ok",
          errors: [],
        },
      }),
    ).toBe(true);
  });

  it("skips completed Capital monitor tasks when choosing next-safe", () => {
    const task = pickNextIncompleteTask(
      [
        { id: "capital_service_status" },
        { id: "capital_telegram_owner_check" },
        { id: "capital_telegram_owner_contract_check" },
        { id: "autonomous_inventory_check" },
        { id: "paper_hft_fill_simulation" },
        { id: "paper_hft_strategy_evaluate" },
        { id: "paper_hft_auto_review" },
        { id: "paper_loop_error_repair" },
        { id: "strategy_bar_accumulator" },
        { id: "strategy_fill_simulation" },
        { id: "hermes-nuwa-bridge" },
        { id: "strategy_engine" },
      ],
      "capital_service_status",
      {
        capitalServiceStatus: {
          exists: true,
          ready: true,
          quoteReady: true,
          quoteStatus: "fresh",
          staleQuoteReturned: false,
        },
        capitalTelegramOwnerCheck: {
          ready: true,
          readOnly: true,
          liveTradingEnabled: false,
          writeTradingEnabled: false,
        },
        autonomousInventory: {
          summary: { ok: true },
        },
        capitalPaperFillSimulation: {
          exists: true,
          status: "ok",
          readOnly: true,
          liveTradingEnabled: false,
          writeTradingEnabled: false,
          brokerOrderPathEnabled: false,
        },
        capitalPaperStrategyEvaluation: {
          exists: true,
          status: "evaluated",
          readOnly: true,
          liveTradingEnabled: false,
          writeTradingEnabled: false,
          brokerOrderPathEnabled: false,
        },
        capitalPaperAutoReview: {
          exists: true,
          status: "already_approved",
          readOnly: true,
          liveTradingEnabled: false,
          writeTradingEnabled: false,
          brokerOrderPathEnabled: false,
        },
        capitalPaperErrorRepair: {
          exists: true,
          repairStatus: "healthy",
          readOnly: true,
          liveTradingEnabled: false,
          writeTradingEnabled: false,
          brokerOrderPathEnabled: false,
        },
        capitalStrategyFillSimulation: {
          exists: true,
          status: "ok",
          liveTradingEnabled: false,
          writeTradingEnabled: false,
          brokerOrderPathEnabled: false,
        },
        hermesNuwaBridge: {
          exists: true,
          status: "ok",
          errors: [],
        },
      },
    );

    expect(task?.id).toBe("strategy_bar_accumulator");
  });
});
