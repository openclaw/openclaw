import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectAutonomousInventory,
  runAutonomousInventoryCheck,
} from "../../scripts/openclaw-autonomous-inventory.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

const TELEGRAM_SHORTCUTS_MACHINE_LINE =
  "shortcutChecks=344 failed=0 assistantClosure=42 okxClosure=23 fixtureCoverage=4 reportMachine=22 growthReason=assistant+okx+fixture+report-machine";
const TELEGRAM_NEXT_COMMAND = "sc:tr:audit / sc:tr:paperloop / sc:tr:assist";
const TELEGRAM_NEXT_COMMAND_MACHINE_LINE =
  "nextCommandShortRow=sc:tr:audit/sc:tr:paperloop/sc:tr:assist gateVerified=true buttons=sc:tr:learn/sc:tr:audit/sc:tr:paperloop/sc:tr:assist";
const SCHEDULER_NEXT_RUN_AT = "2026-05-24T20:15:00.000Z";
const OKX_REFRESH_MACHINE_LINE =
  "okxCurrentReadinessRefresh=ready steps=7/7 failed=0 noOrderWrite=true";
const OKX_HEARTBEAT_MACHINE_LINE = `okxHeartbeatRefresh=sc:tr:okxrefresh command=pnpm okx:current-readiness:refresh schedulerNextRunAt=${SCHEDULER_NEXT_RUN_AT} executeRequired=false noOrderWrite=true`;
const OKX_SCHEDULER_CONTRACT_LINE = `okxSchedulerNoOrderContract=pass reports=3/3 schedulerNextRunAt=${SCHEDULER_NEXT_RUN_AT} current=pass refresh=pass heartbeat=pass noOrderWriteVerified=true noOrderWrite=true`;
const CAPITAL_OPERATOR_PACKET_MACHINE_LINE =
  "capitalOperatorPacket=blocked sha256=565FDF33D1974B6696304E733D2419C2A295BE8994BBAD745ED29F3977A7CE8F readiness=blocked adapterAck=blocked adapterHashOk=false adapterCanarySentOrder=false adapterRollbackFresh=true adapterApplyReceipt=pending_operator_apply adapterApplyReceiptVerified=false executorArm=expired executorArmed=false operatorCanExecute=false nextAction=adapter_apply_receipt noOrderWrite=true sentOrder=false blockers=13";
const CAPITAL_OPERATOR_PACKET_PUBLISH_LINE =
  "capitalOperatorPacket=blocked operatorCanExecute=false readiness=blocked adapterAck=blocked adapterApplyReceipt=pending_operator_apply adapterApplyReceiptVerified=false operatorMayApply=true dispatchPolicy=blocked_do_not_send sentOrder=false blockers=13";
const CAPITAL_POSITION_SNAPSHOT_LINE =
  "capitalVerifiedPositionSnapshot=blocked status=missing verifiedAt=2026-05-24T00:00:00.000Z next=sc:tr:directpos noOrderWrite=true";
const CAPITAL_FAILED_REPLAY_HISTORY_MACHINE_LINE =
  "capitalFailedReplayHistory=banned:BZ0000|CL0000 next=NQ0000 skipped=2 available=1 sameCase=blocked_no_candidates quality=blocked_no_candidates source=latest noOrderWrite=true";
const TRADING_READINESS_MACHINE_LINE =
  "tradingReadiness=quote:capital=ready,okx=pass simulation=READY orderMode=paper sent=false/write=false";
const TRADING_READINESS_ZH_TW =
  "交易就緒=報價:群益=ready,OKX=pass；模擬:READY；下單模式:paper；sent=false/write=false";
const DMAD_GATE_COMMAND = "pnpm dmad:run-test:timeout-smoke:gate:ultra:verify:ultra:full";
const DMAD_GATE_TOKEN = "timeout-smoke:gate:ultra:verify:ultra:full";
const DMAD_GATE_MACHINE_LINE = `dmadGate=${DMAD_GATE_TOKEN} readOnly=true`;
const DMAD_PUBLISH_MACHINE_LINE = `dmadPublish=verified;status=dry_run_ok;dmadGate=1;summaryDmad=true;okxContract=1;summaryOkxContract=true;schedulerNextRunAt=${SCHEDULER_NEXT_RUN_AT}`;

async function writeFile(rootDir: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

function buildTelegramTradingShortcutsReport() {
  return {
    schema: "openclaw.telegram-trading-shortcuts.v1",
    status: "pass",
    summary: {
      shortcuts: 18,
      checks: 344,
      failed: 0,
      shortcutCheckCountClosure: {
        machineLine: TELEGRAM_SHORTCUTS_MACHINE_LINE,
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
        machineLine: CAPITAL_OPERATOR_PACKET_MACHINE_LINE,
      },
      assistantClosure: {
        statusStripFixtureCoverage: {
          status: "pass",
          visibleInAssistantStatusStrip: true,
        },
        assistantLearningHint: {
          nextCommandShortRow: {
            command: TELEGRAM_NEXT_COMMAND,
            gateVerified: true,
            machineLine: TELEGRAM_NEXT_COMMAND_MACHINE_LINE,
          },
        },
      },
      okxCurrentReadinessRefreshWorkflowClosure: {
        status: "ready",
        machineLine: OKX_REFRESH_MACHINE_LINE,
        noOrderWrite: true,
      },
      okxCurrentReadinessInventoryProbeClosure: {
        machineLine:
          "okxInventoryProbe=pass summaryProbes=5/5 publishProbes=18/18 summary=telegram+controlled noOrderWrite=true",
      },
      okxSchedulerNoOrderContractProbeClosure: {
        status: "ready",
        machineLine: OKX_SCHEDULER_CONTRACT_LINE,
        noOrderWrite: true,
      },
      okxHeartbeatPublishTokenCountClosure: {
        status: "ready",
        summaryZhTw:
          "messageTokenCounts 快捷檢查=1 TradingAgents=1 回關收據命令=1 本地執行器=1 倉位快照=1 OKX刷新=1 OKX心跳=1 OKX合約=1 executeRequired=1 noOrderWrite=true=4 下一步指令=1 DMAD=1",
        noOrderWrite: true,
      },
    },
  };
}

function buildControlledRunnerTelegramSummary(
  options: {
    tradingShortcuts?: Record<string, unknown>;
    okxRefresh?: Record<string, unknown>;
    telegramSummaryOneline?: string;
    telegramSummaryOnelineZhTw?: string;
  } = {},
) {
  const tradingShortcuts = {
    exists: true,
    status: "pass",
    checks: 344,
    failed: 0,
    machineLine: TELEGRAM_SHORTCUTS_MACHINE_LINE,
    nextCommand: TELEGRAM_NEXT_COMMAND,
    nextCommandMachineLine: TELEGRAM_NEXT_COMMAND_MACHINE_LINE,
    gateVerified: true,
    okxHeartbeatRefreshMachineLine: OKX_HEARTBEAT_MACHINE_LINE,
    okxHeartbeatExecuteRequired: false,
    okxHeartbeatNoOrderWrite: true,
    capitalOperatorPacket: {
      exists: true,
      status: "visible_blocked",
      reportRead: true,
      machineLine: CAPITAL_OPERATOR_PACKET_MACHINE_LINE,
      publishMachineLine: CAPITAL_OPERATOR_PACKET_PUBLISH_LINE,
      operatorCanExecute: false,
      noOrderWrite: true,
      sentOrder: false,
      blockerCount: 17,
    },
    capitalOperatorPacketMachineLine: CAPITAL_OPERATOR_PACKET_MACHINE_LINE,
    capitalOperatorPacketPublishMachineLine: CAPITAL_OPERATOR_PACKET_PUBLISH_LINE,
    capitalOperatorPacketOperatorCanExecute: false,
    capitalOperatorPacketNoOrderWrite: true,
    capitalOperatorPacketSentOrder: false,
    capitalFailedReplayHistoryMachineLine: CAPITAL_FAILED_REPLAY_HISTORY_MACHINE_LINE,
    capitalFailedReplayHistoryNoOrderWrite: true,
    reportPath: "reports/hermes-agent/state/openclaw-telegram-trading-shortcuts-latest.json",
    ...options.tradingShortcuts,
  };
  const okxRefresh = {
    machineLine: OKX_REFRESH_MACHINE_LINE,
    noOrderWrite: true,
    ...options.okxRefresh,
  };
  const dmadValidationHint = {
    command: DMAD_GATE_COMMAND,
    machineLine: DMAD_GATE_MACHINE_LINE,
    gate: DMAD_GATE_TOKEN,
    readOnlyMode: true,
  };
  const dmadPublishStatus = {
    machineLine: DMAD_PUBLISH_MACHINE_LINE,
    verified: true,
    upstreamDmadGateCount: 1,
    upstreamDmadGateVerified: true,
    upstreamSummaryHasDmad: true,
    upstreamOkxContractCount: 1,
    upstreamOkxContractVerified: true,
    upstreamSummaryHasOkxContract: true,
    upstreamSchedulerNextRunAt: SCHEDULER_NEXT_RUN_AT,
    upstreamSchedulerNextRunAtVisible: true,
  };
  const tradingReadinessStatus = {
    machineLine: TRADING_READINESS_MACHINE_LINE,
    zhTw: TRADING_READINESS_ZH_TW,
  };
  return {
    schema: "openclaw.controlled-task-runner.telegram-summary.v1",
    generatedAt: "2026-05-24T00:00:00.000Z",
    readOnlyMode: true,
    telegram_trading_shortcuts: tradingShortcuts,
    capital_operator_packet: tradingShortcuts.capitalOperatorPacket,
    okx_current_readiness_refresh_workflow: okxRefresh,
    dmad_validation_hint: dmadValidationHint,
    dmad_publish_status: dmadPublishStatus,
    trading_readiness_status: tradingReadinessStatus,
    trading_readiness_status_zh_tw: tradingReadinessStatus.zhTw,
    telegram_summary_oneline:
      options.telegramSummaryOneline ??
      `[OpenClaw] BLOCKED | ${tradingReadinessStatus.machineLine} | tradingShortcuts=${tradingShortcuts.machineLine} | operatorPacket=${tradingShortcuts.capitalOperatorPacketPublishMachineLine} | okxRefresh=${okxRefresh.machineLine} | okxHeartbeat=${tradingShortcuts.okxHeartbeatRefreshMachineLine} | shortcutNext=${tradingShortcuts.nextCommandMachineLine} | dmadGate=${DMAD_GATE_TOKEN} | ${DMAD_PUBLISH_MACHINE_LINE}`,
    telegram_summary_oneline_zh_tw:
      options.telegramSummaryOnelineZhTw ??
      `[OpenClaw] 阻塞中｜${tradingReadinessStatus.zhTw}｜快捷檢查=${tradingShortcuts.machineLine}｜真單Packet=${tradingShortcuts.capitalOperatorPacketPublishMachineLine}｜OKX刷新=${okxRefresh.machineLine}｜OKX心跳=${tradingShortcuts.okxHeartbeatRefreshMachineLine}｜下一步指令=${tradingShortcuts.nextCommandMachineLine}｜DMAD=${DMAD_GATE_TOKEN}｜${DMAD_PUBLISH_MACHINE_LINE}`,
  };
}

function buildControlledRunnerTelegramPublishReport(
  options: {
    message?: string;
    status?: string;
    errorCode?: string;
  } = {},
) {
  const message =
    options.message ??
    `[OpenClaw] 阻塞中｜快捷檢查=${TELEGRAM_SHORTCUTS_MACHINE_LINE}｜真單Packet=${CAPITAL_OPERATOR_PACKET_PUBLISH_LINE}｜倉位快照=${CAPITAL_POSITION_SNAPSHOT_LINE}｜TradingAgents=tradingAgents=blocked noLiveOrderSent=true noOrderWrite=true noOrderWriteVerified=true brokerWriteAttempted=false｜回關收據命令=receiptPrompt=pending_explicit_execute_receipt action=verify_receipt_gate command=pnpm_capital:live-trading:operator:auto-deactivate:receipt:check receiptVerified=false heartbeatExecuteAllowed=false noLiveOrderSent=true sentOrder=false｜本地執行器=capitalLocalExecutorDispatch=blocked operatorCanExecute=false executorArmed=false dispatchPolicy=blocked_do_not_send sentOrder=false blockers=17 noOrderWrite=true brokerWriteAttempted=false｜OKX刷新=${OKX_REFRESH_MACHINE_LINE}｜OKX心跳=${OKX_HEARTBEAT_MACHINE_LINE}｜OKX合約=${OKX_SCHEDULER_CONTRACT_LINE}｜下一步指令=${TELEGRAM_NEXT_COMMAND_MACHINE_LINE}｜DMAD=${DMAD_GATE_TOKEN}`;
  return {
    schema: "openclaw.controlled-task-runner.telegram-publish.report.v1",
    generatedAt: "2026-05-24T00:00:00.000Z",
    status: options.status ?? "dry_run_ok",
    errorCode: options.errorCode ?? "OK",
    dryRun: true,
    dryRunNoSend: true,
    summaryPath: "reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-latest.json",
    reportPath:
      "reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-publish-latest.json",
    target: "dry-run-target",
    targetSource: "env",
    targetSourcePath: null,
    message,
    threadId: null,
    command: `node openclaw.mjs message send --channel telegram --target dry-run-target --message ${message} --dry-run`,
    commandExitCode: 0,
    commandDurationMs: 0,
    commandErrorCode: "DRY_RUN_NO_SEND",
    commandAttemptsUsed: 0,
    commandMaxAttempts: 2,
    commandRetryBaseDelayMs: 1500,
    messageTokenCounts: {
      shortcutChecks: 1,
      positionSnapshot: 1,
      tradingAgents: 1,
      receiptPrompt: 1,
      localExecutorDispatch: 1,
      okxRefresh: 1,
      okxHeartbeat: 1,
      okxContract: 1,
      executeRequired: 1,
      noOrderWrite: 4,
      dmadGate: 1,
    },
    messageTokenCountsSummaryZhTw:
      "messageTokenCounts 快捷檢查=1 倉位快照=1 TradingAgents=1 回關收據命令=1 本地執行器=1 OKX刷新=1 OKX心跳=1 OKX合約=1 executeRequired=1 noOrderWrite=true=4 下一步指令=1 DMAD=1",
    next_safe_task: "pnpm autonomous:controlled:run -- --json",
  };
}

async function createPassingFixture(rootDir: string): Promise<void> {
  for (const relativeDir of [
    ".agents/skills",
    "skills",
    "skills/tengyi-401-pdf-autonomous-trainer",
    "extensions/migrate-hermes",
    "src/hooks",
    "src/cron",
    "src/gateway",
    "runtime",
    "runtime/skills/source_indexer",
  ]) {
    await fs.mkdir(path.join(rootDir, relativeDir), { recursive: true });
  }

  await writeFile(rootDir, "docs/automation/autonomous-runtime.md", "# runtime\n");
  await writeFile(rootDir, "docs/automation/module-skill-inventory.md", "# inventory\n");
  await writeFile(rootDir, "scripts/openclaw-autonomous-inventory.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/openclaw-cron-direct-runner.mjs", "export {};\n");
  await writeFile(
    rootDir,
    "extensions/evolution-learning/hooks/post-cron-learner.js",
    "export function ingestCronReport() { return { ok: true }; }\n",
  );
  await writeFile(rootDir, "scripts/openclaw-controlled-task-runner.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/openclaw-blackbox-autonomy-tick.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/openclaw-blackbox-sync-bridge.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-openclaw-blackbox-autonomy.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/dmad-heartbeat-next-safe-readback.mjs", "export {};\n");
  await writeFile(
    rootDir,
    "scripts/dmad-heartbeat-next-safe-readback-self-test.mjs",
    "export {};\n",
  );
  await writeFile(rootDir, "scripts/check-dmad-heartbeat-next-safe-readback.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-openclaw-controlled-paths.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-openclaw-minimal-runtime-profile.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/openclaw-capital-service-status.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/openclaw-capital-telegram-owner-check.mjs", "export {};\n");
  await writeFile(
    rootDir,
    "scripts/openclaw-capital-live-trading-promotion-gate.mjs",
    "export {};\n",
  );
  await writeFile(
    rootDir,
    "scripts/openclaw-capital-full-chain-simulation-gate.mjs",
    "export {};\n",
  );
  await writeFile(rootDir, "scripts/openclaw-capital-active-page-refresh-plan.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-capital-active-page-refresh-plan.mjs", "export {};\n");
  await writeFile(
    rootDir,
    "scripts/openclaw-capital-core-product-freshness-matrix.mjs",
    "export {};\n",
  );
  await writeFile(
    rootDir,
    "scripts/check-capital-core-product-freshness-matrix.mjs",
    "export {};\n",
  );
  await writeFile(rootDir, "scripts/openclaw-capital-direct-operation-status.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-capital-direct-operation-status.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/openclaw-capital-direct-operation-inputs.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-capital-direct-operation-inputs.mjs", "export {};\n");
  await writeFile(
    rootDir,
    "scripts/openclaw-capital-direct-strategy-platform-gate.mjs",
    "export {};\n",
  );
  await writeFile(
    rootDir,
    "scripts/check-capital-direct-strategy-platform-gate.mjs",
    "export {};\n",
  );
  await writeFile(
    rootDir,
    "scripts/check-capital-strategy-equity-position-sizer.mjs",
    "export {};\n",
  );
  await writeFile(
    rootDir,
    "scripts/openclaw-capital-current-paper-intents-from-target-registry.mjs",
    "export {};\n",
  );
  await writeFile(
    rootDir,
    "scripts/check-capital-current-paper-intents-from-target-registry.mjs",
    "export {};\n",
  );
  await writeFile(
    rootDir,
    "scripts/openclaw-capital-high-confidence-paper-rerun-gate.mjs",
    "export {};\n",
  );
  await writeFile(
    rootDir,
    "scripts/check-capital-high-confidence-paper-rerun-gate.mjs",
    "export {};\n",
  );
  await writeFile(
    rootDir,
    "scripts/openclaw-capital-micro-alternative-paper-rerun-gate.mjs",
    "export {};\n",
  );
  await writeFile(
    rootDir,
    "scripts/check-capital-micro-alternative-paper-rerun-gate.mjs",
    "export {};\n",
  );
  await writeFile(
    rootDir,
    "scripts/openclaw-capital-risk-resized-paper-intent-rerun-gate.mjs",
    "export {};\n",
  );
  await writeFile(
    rootDir,
    "scripts/check-capital-risk-resized-paper-intent-rerun-gate.mjs",
    "export {};\n",
  );
  await writeFile(
    rootDir,
    "scripts/openclaw-capital-live-readiness-simulation.mjs",
    "export {};\n",
  );
  await writeFile(rootDir, "scripts/check-capital-live-readiness-simulation.mjs", "export {};\n");
  await writeFile(
    rootDir,
    "scripts/openclaw-capital-live-trading-operator-auto-deactivate-receipt-gate.mjs",
    "export {};\n",
  );
  await writeFile(
    rootDir,
    "scripts/check-capital-live-trading-operator-auto-deactivate-receipt-gate.mjs",
    "export {};\n",
  );
  await writeFile(rootDir, "scripts/check-openclaw-telegram-trading-shortcuts.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-openclaw-tradingagents-integration.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-openclaw-tradingagents-runtime.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-openclaw-tradingagents-upstream.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-openclaw-tradingagents-summary.mjs", "export {};\n");
  await writeFile(
    rootDir,
    "scripts/check-openclaw-evolution-learning-architecture.mjs",
    "export {};\n",
  );
  await writeFile(rootDir, "scripts/check-openclaw-card-framework.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/export-openclaw-card-framework-graph.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/generate-openclaw-card-module-dry-run.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/render-openclaw-card-framework-viewer.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/openclaw-source-watch-registry.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-openclaw-source-watch-registry.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/openclaw-resolver-candidates.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-openclaw-resolver-candidates.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/openclaw-resolver-evidence-lock.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-openclaw-resolver-evidence-lock.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/openclaw-resolution-workflow.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-openclaw-resolution-workflow.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/openclaw-weak-signal-intake-gate.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-openclaw-weak-signal-intake-gate.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/openclaw-okx-api-status-gate.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-openclaw-okx-api-status-gate.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/openclaw-okx-market-snapshot-loop.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-openclaw-okx-market-snapshot-loop.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/openclaw-okx-market-snapshot-gate.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-openclaw-okx-market-snapshot-gate.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/openclaw-okx-market-snapshot-scheduler.mjs", "export {};\n");
  await writeFile(
    rootDir,
    "scripts/check-openclaw-okx-market-snapshot-scheduler.mjs",
    "export {};\n",
  );
  await writeFile(rootDir, "scripts/openclaw-okx-paper-signal-gate.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-openclaw-okx-paper-signal-gate.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/openclaw-okx-order-proposal-gate.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-openclaw-okx-order-proposal-gate.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/openclaw-okx-order-status-gate.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-openclaw-okx-order-status-gate.mjs", "export {};\n");
  await writeFile(
    rootDir,
    "scripts/openclaw-okx-demo-order-simulation-result-gate.mjs",
    "export {};\n",
  );
  await writeFile(
    rootDir,
    "scripts/check-openclaw-okx-demo-order-simulation-result-gate.mjs",
    "export {};\n",
  );
  await writeFile(rootDir, "scripts/openclaw-okx-paper-audit-log-gate.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/check-openclaw-okx-paper-audit-log-gate.mjs", "export {};\n");
  await writeFile(rootDir, "scripts/openclaw-okx-paper-audit-summary-gate.mjs", "export {};\n");
  await writeFile(
    rootDir,
    "scripts/check-openclaw-okx-paper-audit-summary-gate.mjs",
    "export {};\n",
  );
  await writeFile(rootDir, "scripts/openclaw-okx-current-readiness-summary.mjs", "export {};\n");
  await writeFile(
    rootDir,
    "scripts/check-openclaw-okx-current-readiness-summary.mjs",
    "export {};\n",
  );
  await writeFile(
    rootDir,
    "scripts/openclaw-okx-current-readiness-refresh-workflow.mjs",
    "export {};\n",
  );
  await writeFile(
    rootDir,
    "scripts/check-openclaw-okx-current-readiness-refresh-workflow.mjs",
    "export {};\n",
  );
  await writeFile(
    rootDir,
    "scripts/openclaw-okx-current-readiness-heartbeat-operation.mjs",
    "export {};\n",
  );
  await writeFile(
    rootDir,
    "scripts/check-openclaw-okx-current-readiness-heartbeat-operation.mjs",
    "export {};\n",
  );
  await writeFile(
    rootDir,
    "reports/openclaw-card-framework-cards.json",
    JSON.stringify({ schemaVersion: 1, framework: "openclaw-card-framework", cards: [] }, null, 2),
  );
  await writeFile(
    rootDir,
    "reports/openclaw-card-framework-graph.json",
    JSON.stringify({ schemaVersion: 1, kind: "openclaw-card-framework-graph" }, null, 2),
  );
  await writeFile(rootDir, "reports/openclaw-card-framework-3d-viewer.html", "<!doctype html>\n");
  await writeFile(
    rootDir,
    "reports/openclaw-card-module-generator-dry-run-latest.json",
    JSON.stringify({ ok: true, dryRunOnly: true }, null, 2),
  );
  await writeFile(
    rootDir,
    "config/openclaw-minimal-runtime-profile.json",
    JSON.stringify({ schemaVersion: 1, profileId: "openclaw-minimal-runtime" }, null, 2),
  );
  await writeFile(
    rootDir,
    "config/openclaw-blackbox-autonomy.json",
    JSON.stringify(
      {
        schema: "openclaw.blackbox.autonomy.config.v1",
        mode: "paper_only_blackbox",
        safety: {
          allowLiveTrading: false,
          noOrderWrite: true,
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/openclaw-source-watch-registry-latest.json",
    JSON.stringify({ schema: "openclaw.source-watch-registry.v1", mode: "dry_run" }, null, 2),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-blackbox-autonomy-latest.json",
    JSON.stringify(
      {
        schema: "openclaw.blackbox.autonomy.tick.v1",
        status: "ready",
        cycleId: "cycle-fixture-001",
        nextSafeTask: "pnpm autonomous:controlled:next-safe",
        hardStop: false,
        safety: {
          allowLiveTrading: false,
          noOrderWrite: true,
        },
        machineLine:
          "blackboxAutonomy=status=ready hardStop=false nextSafeTask=pnpm autonomous:controlled:next-safe noOrderWrite=true",
      },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-blackbox-sync-latest.json",
    JSON.stringify(
      {
        schema: "openclaw.blackbox.sync-bridge.v1",
        upstreamVersion: "upstream-fixture-v1",
        downstreamVersion: "downstream-fixture-v1",
        syncStatus: "ok",
        lastAckAt: "2026-05-24T00:00:00.000Z",
        machineLine:
          "blackboxSync=ok upstream=upstream-fixture-v1 downstream=downstream-fixture-v1 noOrderWrite=true",
      },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/openclaw-resolver-candidates-latest.json",
    JSON.stringify({ schema: "openclaw.resolver-candidates.v1", mode: "dry_run" }, null, 2),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-controlled-task-runner-evidence-lock-latest.json",
    JSON.stringify(
      { schema: "openclaw.resolver-evidence-lock.v1", mode: "same_case_rerun_evidence_lock" },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/openclaw-resolution-workflow-latest.json",
    JSON.stringify(
      { schema: "openclaw.resolution-workflow.v1", mode: "integrated_resolution_workflow" },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/openclaw-resolution-workflow-checklist.md",
    "# OpenClaw Resolution Workflow Checklist\n",
  );
  await writeFile(
    rootDir,
    "reports/openclaw-weak-signal-intake-gate-latest.json",
    JSON.stringify(
      { schema: "openclaw.weak-signal-intake-gate.v1", status: "pass_needs_confirmation_locked" },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-okx-api-status-gate-latest.json",
    JSON.stringify({ schema: "openclaw.okx-api-status-gate.v1", status: "pass" }, null, 2),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-okx-market-snapshot-loop-latest.json",
    JSON.stringify({ schema: "openclaw.okx.market-snapshot-loop.v1", status: "pass" }, null, 2),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-okx-market-snapshot-gate-latest.json",
    JSON.stringify({ schema: "openclaw.okx.market-snapshot-gate.v1", status: "pass" }, null, 2),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-okx-market-snapshot-scheduler-latest.json",
    JSON.stringify(
      { schema: "openclaw.okx.market-snapshot-scheduler.v1", status: "pass" },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-okx-paper-signal-gate-latest.json",
    JSON.stringify({ schema: "openclaw.okx.paper-signal-gate.v1", status: "pass" }, null, 2),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-okx-order-proposal-gate-latest.json",
    JSON.stringify({ schema: "openclaw.okx-order-proposal-gate.v1", status: "pass" }, null, 2),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-okx-order-status-gate-latest.json",
    JSON.stringify({ schema: "openclaw.okx.order-status-gate.v1", status: "pass" }, null, 2),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-okx-demo-order-simulation-result-gate-latest.json",
    JSON.stringify(
      { schema: "openclaw.okx.demo-order-simulation-result-gate.v1", status: "pass" },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-okx-paper-audit-log-latest.json",
    JSON.stringify({ schema: "openclaw.okx.paper-audit-log.v1", status: "pass" }, null, 2),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-okx-paper-audit-summary-latest.json",
    JSON.stringify({ schema: "openclaw.okx.paper-audit-summary.v1", status: "pass" }, null, 2),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-okx-current-readiness-summary-latest.json",
    JSON.stringify(
      { schema: "openclaw.okx-current-readiness-summary.v1", status: "pass" },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-okx-current-readiness-refresh-workflow-latest.json",
    JSON.stringify(
      { schema: "openclaw.okx-current-readiness-refresh-workflow.v1", status: "pass" },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-okx-current-readiness-heartbeat-operation-latest.json",
    JSON.stringify(
      { schema: "openclaw.okx-current-readiness-heartbeat-operation.v1", status: "pass" },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-capital-service-status-latest.json",
    JSON.stringify({ ok: true }, null, 2),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-capital-telegram-owner-check-latest.json",
    JSON.stringify({ ok: true }, null, 2),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-capital-live-trading-approval-summary-latest.json",
    JSON.stringify({ ok: true }, null, 2),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-capital-active-page-refresh-plan-latest.json",
    JSON.stringify(
      {
        schema: "openclaw.capital.active-page-refresh-plan.v1",
        status: "paper_strategy_gate_ready",
        readOnly: true,
        liveTradingEnabled: false,
        writeTradingEnabled: false,
        sentOrder: false,
        safety: {
          readOnlyPlanOnly: true,
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-capital-direct-operation-status-latest.json",
    JSON.stringify(
      {
        schema: "openclaw.capital.direct-operation-status.v1",
        status: "blocked",
        summary: {
          safety: {
            noLiveOrderSent: true,
            sentOrder: false,
            liveTradingEnabled: false,
            writeBrokerOrders: false,
          },
          directEntryPoints: {
            telegram: "sc:tr:direct",
          },
          externalBrokerAdapter: {
            required: true,
            applyReceipt: {
              required: true,
              owner: "operator-owned-broker-adapter-only",
              noLiveOrderSent: true,
              sentOrder: false,
              validationCommand:
                "pnpm --dir D:\\OpenClaw capital:trade:adapter-ack-apply-receipt:check",
            },
          },
          sealedOrderIntent: {
            brokerWriteAllowedByOpenClaw: false,
          },
          autoDeactivateReceipt: {
            required: true,
            heartbeatExecuteAllowed: false,
            noLiveOrderSent: true,
            sentOrder: false,
            validationCommand:
              "pnpm --dir D:\\OpenClaw capital:live-trading:operator:auto-deactivate:receipt:check",
          },
          position: {
            verifiedAt: "2026-05-24T00:00:00.000Z",
            freshnessStatus: "fresh",
          },
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-capital-direct-strategy-platform-gate-latest.json",
    JSON.stringify(
      {
        schema: "openclaw.capital.direct-strategy-platform-gate.v1",
        status: "blocked_live_promotion_required",
        strategyPlatform: {
          requestedTrade: {
            instrument: "A50 202605",
            holdingMode: "day_trade",
          },
          targetRegistry: {
            scope: "all_registered_capital_futures_routes",
            summary: {
              liveWritableTargetCount: 0,
            },
          },
        },
        execution: {
          liveWriteAllowed: false,
          noLiveOrderSent: true,
          operatorCanExecute: false,
        },
        liveCompletion: {
          status: "blocked",
          noLiveOrderSent: true,
          writeBrokerOrders: false,
        },
        safety: {
          paperOnly: true,
          writeBrokerOrders: false,
          codexBrokerWriteAllowed: false,
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-capital-current-paper-intents-from-target-registry-latest.json",
    JSON.stringify(
      {
        schema: "openclaw.capital.current-paper-intents-from-target-registry.v1",
        status: "current_paper_intents_written",
        source: {
          noBrokerApiCalled: true,
        },
        targetRegistry: {
          scope: "all_registered_capital_futures_routes",
        },
        intentWrite: {
          activeIntentsPath: ".openclaw/trading/capital-paper-intents.jsonl",
          generatedPaperIntentsOnly: true,
        },
        safety: {
          paperOnly: true,
          noLiveOrderSent: true,
          writeBrokerOrders: false,
          liveTradingEnabled: false,
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-capital-live-readiness-simulation-latest.json",
    JSON.stringify(
      {
        schema: "openclaw.capital.live-readiness-simulation.v1",
        status: "blocked_live_readiness_incomplete",
        simulationRuns: 500,
        completion: {
          falseAccepted: 0,
          noLiveOrderSent: true,
          sentOrder: false,
        },
        safety: {
          reportOnly: true,
          simulatedOnly: true,
          allowLiveTrading: false,
          sentOrder: false,
          noLiveOrderSent: true,
          writeBrokerOrders: false,
        },
        sealedOrderIntent: {
          sha256: "fixture-sealed-order-intent-sha256",
        },
        quoteFreshness: {
          coreProductMatrix: {
            productCount: 11,
          },
        },
        sourceReports: {
          coreProductMatrix: {
            found: true,
          },
        },
        nextSafeTask: "pnpm capital:quote:core-products:check",
        machineLine:
          "capitalLiveReadiness=status=blocked_live_readiness_incomplete simulationRuns=500 noLiveOrderSent=true",
      },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-capital-live-trading-operator-auto-deactivate-receipt-gate-latest.json",
    JSON.stringify(
      {
        schema: "openclaw.capital.live-trading-operator-auto-deactivate-receipt-gate.v1",
        status: "pending_explicit_execute_receipt",
        auditId: "capital-auto-deactivate-5417f11f9d6d9e65d836",
        pendingExplicitExecuteReceipt: true,
        receiptVerified: false,
        heartbeatExecuteAllowed: false,
        safety: {
          reportOnly: true,
          noLiveOrderSent: true,
          sentOrder: false,
          writeBrokerOrders: false,
          liveTradingEnabled: false,
        },
        machineLine:
          "capitalAutoDeactivateReceipt=pending_explicit_execute_receipt audit=capital-auto-deactivate-5417f11f9d6d9e65d836 pendingExplicitExecuteReceipt=true receiptVerified=false heartbeatExecuteAllowed=false noOrderWrite=true sentOrder=false",
      },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-capital-direct-operation-inputs-latest.json",
    JSON.stringify(
      {
        schema: "openclaw.capital.direct-operation-inputs.v1",
        status: "ready",
        safety: {
          generatedTemplatesOnly: true,
          wroteActivePositionSnapshot: false,
          wroteActiveAdapterAck: false,
          sentOrder: false,
        },
        requestedTrade: {
          instrument: "A50 202605",
        },
        templates: {
          externalBrokerAdapterAckRequiredCurrent: {
            path: ".openclaw/trading/capital-external-broker-adapter-ack.required-current.json",
          },
        },
        activeTargets: {
          externalBrokerAdapterAck: {
            expectedSealedIntentSha256: "e515fixture",
          },
          verifiedPositionSnapshot: {
            freshnessStatus: "fresh",
          },
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-capital-risk-resized-paper-intent-rerun-gate-latest.json",
    JSON.stringify(
      {
        schema: "openclaw.capital.risk-resized-paper-intent-rerun-gate.v1",
        status: "blocked_no_rerun_ready",
        source: {
          riskNotionalReviewStatus: "blocked_no_candidate",
        },
        safetyLock: {
          paperOnly: true,
          simulatedOnly: true,
          writeBrokerOrders: false,
          noLiveOrderSent: true,
        },
        noOrderWrite: true,
      },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-capital-high-confidence-paper-rerun-gate-latest.json",
    JSON.stringify(
      {
        schema: "openclaw.capital.high-confidence-paper-rerun-gate.v1",
        status: "blocked_no_high_confidence_candidate",
        confidenceGate: {
          threshold: 0.6,
          requiredConfidenceStatus: "blocked_below_threshold",
        },
        safetyLock: {
          paperOnly: true,
          simulatedOnly: true,
          writeBrokerOrders: false,
          noLiveOrderSent: true,
        },
        noOrderWrite: true,
      },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-capital-micro-alternative-paper-rerun-gate-latest.json",
    JSON.stringify(
      {
        schema: "openclaw.capital.micro-alternative-paper-rerun-gate.v1",
        status: "blocked_no_micro_alternative_ready",
        source: {
          maxRiskNotional: 3000,
        },
        safetyLock: {
          paperOnly: true,
          simulatedOnly: true,
          writeBrokerOrders: false,
          noLiveOrderSent: true,
        },
        noOrderWrite: true,
      },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-telegram-trading-shortcuts-latest.json",
    JSON.stringify(buildTelegramTradingShortcutsReport(), null, 2),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-tradingagents-summary-latest.json",
    JSON.stringify(
      {
        schema: "openclaw.tradingagents.summary.v1",
        status: "blocked",
        integration: {
          status: "ok",
        },
        runtime: {
          status: "ok",
          provider: "fixture-provider",
          mode: "paper_signal_only",
          noOrderWrite: true,
          brokerWriteAttempted: false,
        },
        canAnalyzeNow: true,
        no_live_order_sent: true,
        brokerWriteAttempted: false,
        nextSafeTask: "pnpm openclaw:tradingagents:summary:check",
      },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-latest.json",
    JSON.stringify(buildControlledRunnerTelegramSummary(), null, 2),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-controlled-task-runner-latest.json",
    JSON.stringify(
      {
        schema: "openclaw.controlled-task-runner.report.v1",
        generatedAt: "2026-05-24T00:00:00.000Z",
        readOnlyMode: true,
        dmad_validation_hint: {
          command: DMAD_GATE_COMMAND,
          machineLine: DMAD_GATE_MACHINE_LINE,
        },
        dmad_publish_status: {
          machineLine: DMAD_PUBLISH_MACHINE_LINE,
          upstreamDmadGateCount: 1,
          upstreamDmadGateVerified: true,
          upstreamSummaryHasDmad: true,
          upstreamOkxContractCount: 1,
          upstreamOkxContractVerified: true,
          upstreamSummaryHasOkxContract: true,
          upstreamSchedulerNextRunAt: SCHEDULER_NEXT_RUN_AT,
          upstreamSchedulerNextRunAtVisible: true,
        },
        validation_result: {
          telegram_publish: {
            upstreamDmadGateVerified: true,
            upstreamOkxContractVerified: true,
            upstreamSchedulerNextRunAt: SCHEDULER_NEXT_RUN_AT,
          },
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-latest.md",
    `# OpenClaw controlled runner Telegram summary\n\n- capital_operator_packet: ${CAPITAL_OPERATOR_PACKET_PUBLISH_LINE}\n- capital_operator_packet_can_execute: false\n- capital_failed_replay_history: ${CAPITAL_FAILED_REPLAY_HISTORY_MACHINE_LINE}\n- capital_failed_replay_history_no_order_write: true\n- trading_readiness_status: ${TRADING_READINESS_MACHINE_LINE}\n- dmad_publish_status: ${DMAD_PUBLISH_MACHINE_LINE}\n- dmad_publish_probe: dmadGate=1;summaryDmad=true;okxContract=1;summaryOkxContract=true;schedulerNextRunAt=${SCHEDULER_NEXT_RUN_AT}\n`,
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-publish-latest.json",
    JSON.stringify(buildControlledRunnerTelegramPublishReport(), null, 2),
  );
  await writeFile(
    rootDir,
    "reports/hermes-agent/state/openclaw-dmad-heartbeat-next-safe-readback-latest.json",
    JSON.stringify(
      {
        schema: "openclaw.dmad.heartbeat-next-safe-readback.v1",
        generatedAt: new Date().toISOString(),
        status: "ready",
        nextSafe: "inventory-fixture",
        machineLine:
          "nextSafe=inventory-fixture dmadGate=timeout-smoke:gate:ultra:verify:ultra:full dmadPublish=verified",
        heartbeat: {
          nextSafe: "inventory-fixture",
          message: "next_safe=inventory-fixture",
          xml: "<heartbeat>\n  <message>next_safe=inventory-fixture</message>\n</heartbeat>",
        },
        automationReadPoint: {
          nextSafe: "inventory-fixture",
          stdoutRequired: false,
          dispatchable: true,
          selector: "heartbeat.xml",
          xml: "<heartbeat>\n  <message>next_safe=inventory-fixture</message>\n</heartbeat>",
        },
        fallbackReason: null,
        mode: "state_write",
        freshness: {
          status: "ok",
          maxAgeMs: 86400000,
        },
        readOnly: true,
        safety: {
          noExternalWrite: true,
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    rootDir,
    ".openclaw/quote/capital-service-status.json",
    JSON.stringify({ ok: true }, null, 2),
  );
  await writeFile(
    rootDir,
    ".openclaw/quote/capital-telegram-owner-check.json",
    JSON.stringify({ ok: true }, null, 2),
  );
  await writeFile(
    rootDir,
    "skills/openclaw-card-framework-builder/SKILL.md",
    [
      "---",
      "name: openclaw-card-framework-builder",
      "description: Build OpenClaw modules through linked cards.",
      'metadata: { "openclaw": { "criticality": "important" } }',
      "---",
      "",
    ].join("\n"),
  );
  await writeFile(
    rootDir,
    "skills/openclaw-okx-cex-status/SKILL.md",
    [
      "---",
      "name: openclaw-okx-cex-status",
      "description: Check OpenClaw OKX CEX status.",
      'metadata: { "openclaw": { "criticality": "important" } }',
      "---",
      "",
    ].join("\n"),
  );
  await writeFile(
    rootDir,
    "skills/openclaw-global-source-audit/SKILL.md",
    [
      "---",
      "name: openclaw-global-source-audit",
      "description: Validate global source audit surfaces for OpenClaw.",
      'metadata: { "openclaw": { "criticality": "important" } }',
      "---",
      "",
    ].join("\n"),
  );
  await writeFile(
    rootDir,
    "runtime/skills/source_indexer/source_indexer.py",
    "def collect_runtime_surface():\n    return {'status': 'available'}\n",
  );
  await writeFile(
    rootDir,
    "skills/tengyi-401-pdf-autonomous-trainer/SKILL.md",
    [
      "---",
      "name: tengyi-401-pdf-autonomous-trainer",
      "description: Train 401 PDF workflows.",
      'metadata: { "openclaw": { "criticality": "important" } }',
      "---",
      "",
    ].join("\n"),
  );
  await writeFile(
    rootDir,
    "extensions/migrate-hermes/openclaw.plugin.json",
    JSON.stringify(
      {
        id: "migrate-hermes",
        metadata: { openclaw: { criticality: "important" } },
        contracts: { migrationProviders: ["hermes"] },
      },
      null,
      2,
    ),
  );
}

describe("openclaw-autonomous-inventory", () => {
  it("passes when required autonomous paths and manifest are present", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-pass-");
    await createPassingFixture(rootDir);

    const report = await collectAutonomousInventory(rootDir);
    const failedChecks = report.checks
      .filter((entry) => entry.status === "fail")
      .map((entry) => `${entry.id}:${entry.message}`);

    expect(report.summary.ok, failedChecks.join(" | ")).toBe(true);
    expect(report.summary.failed).toBe(0);
  });

  it("fails when autonomous docs are missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-doc-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "docs/automation/autonomous-runtime.md"));

    const report = await collectAutonomousInventory(rootDir);
    const runtimeDocCheck = report.checks.find((entry) => entry.id === "docs-autonomous-runtime");

    expect(report.summary.ok).toBe(false);
    expect(runtimeDocCheck?.status).toBe("fail");
  });

  it("fails when the runtime anchor is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-runtime-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "runtime/skills/source_indexer/source_indexer.py"));

    const report = await collectAutonomousInventory(rootDir);
    const runtimeAnchorCheck = report.checks.find((entry) => entry.id === "runtime-source-indexer");

    expect(report.summary.ok).toBe(false);
    expect(runtimeAnchorCheck?.status).toBe("fail");
  });

  it("fails when the Tengyi 401 PDF skill is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-skill-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "skills/tengyi-401-pdf-autonomous-trainer/SKILL.md"));

    const report = await collectAutonomousInventory(rootDir);
    const skillCheck = report.checks.find((entry) => entry.id === "tengyi-401-pdf-skill");

    expect(report.summary.ok).toBe(false);
    expect(skillCheck?.status).toBe("fail");
  });

  it("fails when the source watch registry report is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-source-watch-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "reports/openclaw-source-watch-registry-latest.json"));

    const report = await collectAutonomousInventory(rootDir);
    const sourceWatchCheck = report.checks.find(
      (entry) => entry.id === "report-openclaw-source-watch-registry",
    );

    expect(report.summary.ok).toBe(false);
    expect(sourceWatchCheck?.status).toBe("fail");
  });

  it("fails when the resolver candidates report is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-resolver-candidates-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "reports/openclaw-resolver-candidates-latest.json"));

    const report = await collectAutonomousInventory(rootDir);
    const resolverCandidatesCheck = report.checks.find(
      (entry) => entry.id === "report-openclaw-resolver-candidates",
    );

    expect(report.summary.ok).toBe(false);
    expect(resolverCandidatesCheck?.status).toBe("fail");
  });

  it("fails when the resolver evidence lock report is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-resolver-evidence-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(
      path.join(
        rootDir,
        "reports/hermes-agent/state/openclaw-controlled-task-runner-evidence-lock-latest.json",
      ),
    );

    const report = await collectAutonomousInventory(rootDir);
    const evidenceLockCheck = report.checks.find(
      (entry) => entry.id === "report-openclaw-resolver-evidence-lock",
    );

    expect(report.summary.ok).toBe(false);
    expect(evidenceLockCheck?.status).toBe("fail");
  });

  it("fails when the resolution workflow report is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-resolution-workflow-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "reports/openclaw-resolution-workflow-latest.json"));

    const report = await collectAutonomousInventory(rootDir);
    const workflowCheck = report.checks.find(
      (entry) => entry.id === "report-openclaw-resolution-workflow",
    );

    expect(report.summary.ok).toBe(false);
    expect(workflowCheck?.status).toBe("fail");
  });

  it("fails when the weak-signal intake gate report is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-weak-signal-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "reports/openclaw-weak-signal-intake-gate-latest.json"));

    const report = await collectAutonomousInventory(rootDir);
    const weakSignalCheck = report.checks.find(
      (entry) => entry.id === "report-openclaw-weak-signal-intake-gate",
    );

    expect(report.summary.ok).toBe(false);
    expect(weakSignalCheck?.status).toBe("fail");
  });

  it("fails when the Telegram trading shortcuts report is not passing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-telegram-shortcuts-fail-");
    await createPassingFixture(rootDir);
    await writeFile(
      rootDir,
      "reports/hermes-agent/state/openclaw-telegram-trading-shortcuts-latest.json",
      JSON.stringify(
        {
          schema: "openclaw.telegram-trading-shortcuts.v1",
          status: "fail",
          summary: {
            shortcuts: 8,
            checks: 107,
            failed: 1,
          },
        },
        null,
        2,
      ),
    );

    const report = await collectAutonomousInventory(rootDir);
    const shortcutCheck = report.checks.find(
      (entry) => entry.id === "report-openclaw-telegram-trading-shortcuts",
    );

    expect(report.summary.ok).toBe(false);
    expect(shortcutCheck?.status).toBe("fail");
    expect(shortcutCheck?.message).toContain("JSON contract failed");
  });

  it("fails when the controlled runner Telegram summary is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-controlled-telegram-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(
      path.join(
        rootDir,
        "reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-latest.json",
      ),
    );

    const report = await collectAutonomousInventory(rootDir);
    const summaryCheck = report.checks.find(
      (entry) => entry.id === "report-openclaw-controlled-task-runner-telegram-summary",
    );

    expect(report.summary.ok).toBe(false);
    expect(summaryCheck?.status).toBe("fail");
  });

  it("fails when the controlled runner Telegram summary omits the next-command row", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-controlled-telegram-next-fail-");
    await createPassingFixture(rootDir);
    await writeFile(
      rootDir,
      "reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-latest.json",
      JSON.stringify(
        buildControlledRunnerTelegramSummary({
          tradingShortcuts: {
            nextCommandMachineLine: "unavailable",
          },
          telegramSummaryOneline: `[OpenClaw] BLOCKED | tradingShortcuts=${TELEGRAM_SHORTCUTS_MACHINE_LINE} | okxRefresh=${OKX_REFRESH_MACHINE_LINE} | shortcutNext=unavailable`,
          telegramSummaryOnelineZhTw: `[OpenClaw] 阻塞中｜快捷檢查=${TELEGRAM_SHORTCUTS_MACHINE_LINE}｜OKX刷新=${OKX_REFRESH_MACHINE_LINE}｜下一步指令=unavailable`,
        }),
        null,
        2,
      ),
    );

    const report = await collectAutonomousInventory(rootDir);
    const summaryCheck = report.checks.find(
      (entry) => entry.id === "report-openclaw-controlled-task-runner-telegram-summary",
    );

    expect(report.summary.ok).toBe(false);
    expect(summaryCheck?.status).toBe("fail");
    expect(summaryCheck?.message).toContain("telegram_trading_shortcuts.nextCommandMachineLine");
    expect(summaryCheck?.message).toContain('expected string containing "nextCommandShortRow="');
  });

  it("fails when the controlled runner Telegram publish dry-run report is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-controlled-publish-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(
      path.join(
        rootDir,
        "reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-publish-latest.json",
      ),
    );

    const report = await collectAutonomousInventory(rootDir);
    const publishCheck = report.checks.find(
      (entry) => entry.id === "report-openclaw-controlled-task-runner-telegram-publish",
    );

    expect(report.summary.ok).toBe(false);
    expect(publishCheck?.status).toBe("fail");
  });

  it("fails when the controlled runner Telegram publish dry-run message omits the next-command row", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-controlled-publish-next-fail-");
    await createPassingFixture(rootDir);
    await writeFile(
      rootDir,
      "reports/hermes-agent/state/openclaw-controlled-task-runner-telegram-publish-latest.json",
      JSON.stringify(
        buildControlledRunnerTelegramPublishReport({
          message: `[OpenClaw] 阻塞中｜快捷檢查=${TELEGRAM_SHORTCUTS_MACHINE_LINE}｜OKX刷新=${OKX_REFRESH_MACHINE_LINE}｜noOrderWrite=true｜下一步指令=unavailable`,
        }),
        null,
        2,
      ),
    );

    const report = await collectAutonomousInventory(rootDir);
    const publishCheck = report.checks.find(
      (entry) => entry.id === "report-openclaw-controlled-task-runner-telegram-publish",
    );

    expect(report.summary.ok).toBe(false);
    expect(publishCheck?.status).toBe("fail");
    expect(publishCheck?.message).toContain("message");
    expect(publishCheck?.message).toContain(
      'expected string containing "下一步指令=nextCommandShortRow="',
    );
  });

  it("fails when the cron direct runner script is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-cron-runner-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "scripts/openclaw-cron-direct-runner.mjs"));

    const report = await collectAutonomousInventory(rootDir);
    const cronRunnerCheck = report.checks.find(
      (entry) => entry.id === "script-openclaw-cron-direct-runner",
    );

    expect(report.summary.ok).toBe(false);
    expect(cronRunnerCheck?.status).toBe("fail");
  });

  it("fails when the post-cron learner hook is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-post-cron-learner-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "extensions/evolution-learning/hooks/post-cron-learner.js"));

    const report = await collectAutonomousInventory(rootDir);
    const postCronLearnerCheck = report.checks.find(
      (entry) => entry.id === "hook-post-cron-learner",
    );

    expect(report.summary.ok).toBe(false);
    expect(postCronLearnerCheck?.status).toBe("fail");
  });

  it("fails when the strategy equity position sizer check script is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-equity-sizer-check-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "scripts/check-capital-strategy-equity-position-sizer.mjs"));

    const report = await collectAutonomousInventory(rootDir);
    const equitySizerCheck = report.checks.find(
      (entry) => entry.id === "script-capital-strategy-equity-position-sizer-check",
    );

    expect(report.summary.ok).toBe(false);
    expect(equitySizerCheck?.status).toBe("fail");
  });

  it("fails when the controlled-paths check script is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-controlled-paths-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "scripts/check-openclaw-controlled-paths.mjs"));

    const report = await collectAutonomousInventory(rootDir);
    const controlledPathsCheck = report.checks.find(
      (entry) => entry.id === "script-openclaw-controlled-paths",
    );

    expect(report.summary.ok).toBe(false);
    expect(controlledPathsCheck?.status).toBe("fail");
  });

  it("fails when the evolution-learning architecture check script is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-evolution-check-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "scripts/check-openclaw-evolution-learning-architecture.mjs"));

    const report = await collectAutonomousInventory(rootDir);
    const evolutionCheck = report.checks.find(
      (entry) => entry.id === "script-evolution-learning-architecture",
    );

    expect(report.summary.ok).toBe(false);
    expect(evolutionCheck?.status).toBe("fail");
  });

  it("fails when the OpenClaw card framework check script is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-card-check-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "scripts/check-openclaw-card-framework.mjs"));

    const report = await collectAutonomousInventory(rootDir);
    const cardCheck = report.checks.find((entry) => entry.id === "script-openclaw-card-framework");

    expect(report.summary.ok).toBe(false);
    expect(cardCheck?.status).toBe("fail");
  });

  it("fails when the OpenClaw card framework registry is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-card-registry-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "reports/openclaw-card-framework-cards.json"));

    const report = await collectAutonomousInventory(rootDir);
    const registryCheck = report.checks.find(
      (entry) => entry.id === "report-openclaw-card-framework-registry",
    );

    expect(report.summary.ok).toBe(false);
    expect(registryCheck?.status).toBe("fail");
  });

  it("fails when the OpenClaw card graph export script is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-card-graph-script-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "scripts/export-openclaw-card-framework-graph.mjs"));

    const report = await collectAutonomousInventory(rootDir);
    const graphScriptCheck = report.checks.find(
      (entry) => entry.id === "script-openclaw-card-graph-export",
    );

    expect(report.summary.ok).toBe(false);
    expect(graphScriptCheck?.status).toBe("fail");
  });

  it("fails when the OpenClaw card graph export is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-card-graph-report-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "reports/openclaw-card-framework-graph.json"));

    const report = await collectAutonomousInventory(rootDir);
    const graphReportCheck = report.checks.find(
      (entry) => entry.id === "report-openclaw-card-framework-graph",
    );

    expect(report.summary.ok).toBe(false);
    expect(graphReportCheck?.status).toBe("fail");
  });

  it("fails when the OpenClaw card viewer render script is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-card-viewer-script-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "scripts/render-openclaw-card-framework-viewer.mjs"));

    const report = await collectAutonomousInventory(rootDir);
    const viewerScriptCheck = report.checks.find(
      (entry) => entry.id === "script-openclaw-card-viewer-render",
    );

    expect(report.summary.ok).toBe(false);
    expect(viewerScriptCheck?.status).toBe("fail");
  });

  it("fails when the OpenClaw card module dry-run generator is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-card-generator-script-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "scripts/generate-openclaw-card-module-dry-run.mjs"));

    const report = await collectAutonomousInventory(rootDir);
    const generatorScriptCheck = report.checks.find(
      (entry) => entry.id === "script-openclaw-card-module-generator",
    );

    expect(report.summary.ok).toBe(false);
    expect(generatorScriptCheck?.status).toBe("fail");
  });

  it("fails when the OpenClaw card module dry-run report is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-card-generator-report-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "reports/openclaw-card-module-generator-dry-run-latest.json"));

    const report = await collectAutonomousInventory(rootDir);
    const generatorReportCheck = report.checks.find(
      (entry) => entry.id === "report-openclaw-card-module-generator",
    );

    expect(report.summary.ok).toBe(false);
    expect(generatorReportCheck?.status).toBe("fail");
  });

  it("fails when the OpenClaw card viewer export is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-card-viewer-report-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "reports/openclaw-card-framework-3d-viewer.html"));

    const report = await collectAutonomousInventory(rootDir);
    const viewerReportCheck = report.checks.find(
      (entry) => entry.id === "report-openclaw-card-framework-viewer",
    );

    expect(report.summary.ok).toBe(false);
    expect(viewerReportCheck?.status).toBe("fail");
  });

  it("fails when the OpenClaw card framework builder skill is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-card-builder-skill-missing-");
    await createPassingFixture(rootDir);
    await fs.rm(path.join(rootDir, "skills/openclaw-card-framework-builder/SKILL.md"));

    const report = await collectAutonomousInventory(rootDir);
    const skillCheck = report.checks.find(
      (entry) => entry.id === "skill-openclaw-card-framework-builder",
    );

    expect(report.summary.ok).toBe(false);
    expect(skillCheck?.status).toBe("fail");
  });

  it("fails when required skill criticality metadata is missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-skill-criticality-missing-");
    await createPassingFixture(rootDir);
    await writeFile(
      rootDir,
      "skills/openclaw-card-framework-builder/SKILL.md",
      "---\nname: openclaw-card-framework-builder\ndescription: Build OpenClaw modules.\n---\n",
    );

    const report = await collectAutonomousInventory(rootDir);
    const criticalityCheck = report.checks.find(
      (entry) => entry.id === "skill-openclaw-card-framework-builder-criticality",
    );

    expect(report.summary.ok).toBe(false);
    expect(criticalityCheck?.status).toBe("fail");
  });

  it("returns non-zero in --check mode when required items are missing", async () => {
    const rootDir = createTempDir("openclaw-autonomous-inventory-check-fail-");
    await fs.mkdir(path.join(rootDir, "extensions"), { recursive: true });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runAutonomousInventoryCheck({
      argv: ["--check"],
      repoRoot: rootDir,
      io: {
        stdout: { write: (text: string) => stdout.push(text) },
        stderr: { write: (text: string) => stderr.push(text) },
      },
    });

    expect(exitCode).toBe(1);
    expect(stderr.join("")).toContain("autonomous inventory check failed");
    expect(stdout.join("")).toContain("OpenClaw autonomous inventory");
  });
});
