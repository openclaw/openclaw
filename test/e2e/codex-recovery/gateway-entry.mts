import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { loadSessionEntry } from "../../../src/config/sessions/session-accessor.ts";
import { callGateway } from "../../../src/gateway/call.ts";
import { startGatewayServer } from "../../../src/gateway/server.ts";
import { onAgentRuntimeEvent } from "../../../src/infra/agent-events.ts";
import { readVisibleSessionTranscriptMessageEntries } from "../../../src/plugin-sdk/session-transcript-runtime.ts";
import { normalizeInputProvenance } from "../../../src/sessions/input-provenance.ts";
import { acquireTestPortBlock } from "../../../src/test-utils/port-claims.ts";
const root = process.env.OC_REPRO_ROOT;
if (!root) {
  throw new Error("Missing isolated output directory");
}
const gatewayLogOffset = fs.statSync(root + "/openclaw.log").size;
const recoveryEvents: Array<{
  runId: string;
  sessionKey?: string;
  phase: unknown;
  automatic: boolean;
}> = [];
const off = onAgentRuntimeEvent((e) => {
  if (e.stream === "lifecycle") {
    recoveryEvents.push({
      runId: e.runId,
      sessionKey: e.sessionKey,
      phase: e.data.phase,
      automatic: e.mainSessionRestartRecovery === true,
    });
  }
  if (["lifecycle", "tool", "error"].includes(e.stream)) {
    const evidence =
      process.env.OC_REPRO_LIVE_SLACK === "1"
        ? {
            runId: e.runId,
            sessionKey: e.sessionKey,
            stream: e.stream,
            seq: e.seq,
            ts: e.ts,
            mainSessionRestartRecovery: e.mainSessionRestartRecovery === true,
            data: {
              phase: e.data.phase,
              name: e.data.name,
              toolCallId: e.data.toolCallId,
              isError: e.data.isError,
            },
          }
        : { ...e, mainSessionRestartRecovery: e.mainSessionRestartRecovery === true };
    fs.appendFileSync(root + "/agent-events.jsonl", JSON.stringify(evidence) + "\n");
  }
});
async function waitForAutomaticRecovery(originalRunId: string): Promise<void> {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("Missing isolated state directory");
  }
  const target = {
    agentId: "main",
    sessionKey: "agent:main:main",
    storePath: path.join(stateDir, "agents/main/sessions/sessions.json"),
  };
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const terminal = recoveryEvents.find(
      (event) =>
        event.automatic &&
        event.sessionKey === target.sessionKey &&
        event.runId !== originalRunId &&
        (event.phase === "error" || event.phase === "end"),
    );
    const entry = loadSessionEntry({ ...target, readConsistency: "latest" });
    if (
      terminal &&
      entry &&
      (entry.status === "failed" || entry.status === "done") &&
      entry.mainRestartRecovery === undefined &&
      entry.restartRecoveryDeliveryRunId === undefined &&
      entry.abortedLastRun !== true &&
      entry.restartRecoveryTerminalRunIds?.includes(terminal.runId)
    ) {
      const messages = await readVisibleSessionTranscriptMessageEntries({
        ...target,
        sessionId: entry.sessionId,
      });
      const actualInternalContinuation = messages.some(({ message }) => {
        const provenance = normalizeInputProvenance(
          (message as { provenance?: unknown }).provenance,
        );
        return (
          provenance?.kind === "internal_system" &&
          provenance.sourceTool === "main_session_restart_recovery"
        );
      });
      if (!actualInternalContinuation) {
        throw new Error("No actual startup continuation in durable transcript");
      }
      fs.writeFileSync(
        root + "/startup-recovery.json",
        JSON.stringify(
          {
            originalRunId,
            recoveryRunId: terminal.runId,
            terminalPhase: terminal.phase,
            status: entry.status,
            terminalRunIds: entry.restartRecoveryTerminalRunIds,
            actualInternalContinuation,
            runtimeStampedAutomaticContinuation: terminal.automatic,
            recoveryClaimCleared: true,
          },
          null,
          2,
        ),
      );
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  throw new Error("Automatic startup recovery did not reach durable terminal cleanup");
}
// This runs inside the real Gateway so the active storage backend is initialized.
// Export correlation/state only; raw transcript content and credentials stay private.
async function inspectLiveSession(sessionKey: string, probeId: string): Promise<void> {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  const prefix = process.env.OC_REPRO_SLACK_SESSION_PREFIX;
  if (
    process.env.OC_REPRO_LIVE_SLACK !== "1" ||
    !stateDir ||
    !prefix ||
    !sessionKey.startsWith("agent:main:") ||
    !(
      sessionKey.toLowerCase() === prefix ||
      sessionKey.toLowerCase().startsWith(prefix + ":thread:")
    ) ||
    !/^[a-z0-9-]{1,80}$/.test(probeId)
  ) {
    throw new Error("Invalid isolated live session probe");
  }
  const target = {
    agentId: "main",
    sessionKey,
    storePath: path.join(stateDir, "agents/main/sessions/sessions.json"),
  };
  const entry = loadSessionEntry({ ...target, readConsistency: "latest" });
  if (!entry) {
    throw new Error("Live Slack session has not been admitted");
  }
  const messages = await readVisibleSessionTranscriptMessageEntries({
    ...target,
    sessionId: entry.sessionId,
  });
  const userTurns = messages.flatMap(({ message }) => {
    const record = asOptionalRecord(message);
    if (record?.role !== "user") {
      return [];
    }
    const transport = asOptionalRecord(
      asOptionalRecord(Reflect.get(record, "__openclaw"))?.transport,
    );
    const provenance = normalizeInputProvenance(record.provenance);
    return [
      {
        idempotencyKey: record.idempotencyKey,
        provenanceKind: provenance?.kind,
        provenanceSourceTool: provenance?.sourceTool,
        transport: transport
          ? {
              channel: transport.channel,
              conversationRef: transport.conversationRef,
              messageId: transport.messageId,
              threadId: transport.threadId,
            }
          : undefined,
      },
    ];
  });
  const receipt = {
    probeId,
    capturedAt: Date.now(),
    sessionKey,
    sessionId: entry.sessionId,
    status: entry.status,
    lastRunId: entry.lastRunId,
    lifecycleRunId: entry.lifecycleRunId,
    abortedLastRun: entry.abortedLastRun === true,
    recoveryClaimPresent: entry.mainRestartRecovery !== undefined,
    recoveryDeliveryRunId: entry.restartRecoveryDeliveryRunId,
    recoverySourceRunId: entry.restartRecoveryDeliverySourceRunId,
    pendingFinalDelivery: entry.pendingFinalDelivery !== undefined,
    terminalRunIds: entry.restartRecoveryTerminalRunIds ?? [],
    userTurns,
    lifecycle: recoveryEvents.filter((event) => event.sessionKey === sessionKey),
    deliveredCheckpointReconciled: fs
      .readFileSync(root + "/openclaw.log")
      .subarray(gatewayLogOffset)
      .toString("utf8")
      .includes(`reconciled delivered terminal reply after restart: ${sessionKey}`),
  };
  fs.writeFileSync(root + `/live-session-${probeId}.json`, JSON.stringify(receipt, null, 2));
}
let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
let sibling: ReturnType<typeof callGateway> | undefined;
let claim: Awaited<ReturnType<typeof acquireTestPortBlock>> | undefined;
let ready: () => void = () => {};
let stopLive: () => void = () => {};
const liveStopped = new Promise<void>((resolve) => {
  stopLive = resolve;
});
let backendRestored: () => void = () => {};
const backendReady = new Promise<void>((resolve) => {
  backendRestored = resolve;
});
const siblingReady = new Promise<void>((resolve) => {
  ready = resolve;
});
process.on("message", (message) => {
  if (
    message &&
    typeof message === "object" &&
    "kind" in message &&
    message.kind === "inspect-live-session" &&
    "sessionKey" in message &&
    typeof message.sessionKey === "string" &&
    "probeId" in message &&
    typeof message.probeId === "string"
  ) {
    const probeId = message.probeId;
    void inspectLiveSession(message.sessionKey, probeId).catch((error: unknown) => {
      console.error("Live session evidence failed", error);
      process.send?.({ kind: "live-probe-failed", probeId });
    });
  }
  if (message && typeof message === "object" && "kind" in message && message.kind === "stop-live") {
    stopLive();
  }
  if (
    message &&
    typeof message === "object" &&
    "kind" in message &&
    message.kind === "backend-restored"
  ) {
    backendRestored();
  }
  if (
    message &&
    typeof message === "object" &&
    "kind" in message &&
    message.kind === "sibling-ready"
  ) {
    ready();
  }
});
try {
  const portClaim = await acquireTestPortBlock({ offsets: [0] });
  claim = portClaim;
  const port = portClaim.port;
  server = await startGatewayServer(port, {
    bind: "loopback",
    auth: { mode: "token", token: "synthetic-gateway-token" },
    controlUiEnabled: false,
  });
  if (process.env.OC_REPRO_LIVE_SLACK === "1") {
    fs.writeFileSync(
      root + "/gateway-ready.json",
      JSON.stringify({
        port,
        pid: process.pid,
        restarted: process.env.OC_REPRO_GATEWAY_PHASE === "recovered",
      }),
    );
    await liveStopped;
  } else {
    if (process.env.OC_REPRO_MODE?.includes("sibling")) {
      sibling = callGateway({
        url: `ws://127.0.0.1:${port}`,
        token: "synthetic-gateway-token",
        method: "agent",
        params: {
          message: "SIBLING_HOLD",
          sessionKey: "agent:main:sibling",
          idempotencyKey: randomUUID(),
          deliver: false,
        },
        expectFinal: true,
        timeoutMs: 120000,
      }).catch((e: unknown) => ({ error: String(e) }));
      await siblingReady;
    }
    const recoveringGateway = process.env.OC_REPRO_GATEWAY_PHASE === "recovered";
    const results: Array<Record<string, unknown>> = recoveringGateway
      ? [JSON.parse(fs.readFileSync(root + "/interrupted-request.json", "utf8"))]
      : [];
    if (recoveringGateway && process.env.OC_REPRO_MODE?.includes("automatic-startup")) {
      await waitForAutomaticRecovery(String(results[0]?.runId));
    }
    for (const [label, sessionKey] of [
      ["original", "agent:main:main"],
      ["subsequent", "agent:main:main"],
      ["independent", "agent:main:independent"],
    ] as const) {
      if (recoveringGateway && label === "original") {
        continue;
      }
      const runId = randomUUID();
      if (label === "original") {
        fs.writeFileSync(
          root + "/interrupted-request.json",
          JSON.stringify({
            label,
            runId,
            error: "Gateway process interrupted before terminal delivery",
          }),
        );
      }
      try {
        if (label === "subsequent") {
          process.send?.({ kind: "restore-backend" });
          await backendReady;
        }
        const result = await callGateway({
          url: `ws://127.0.0.1:${port}`,
          token: "synthetic-gateway-token",
          method: "agent",
          params: {
            message:
              label === "original"
                ? "Reply with RECOVERY_OK. This is an isolated overload recovery probe."
                : `New independent request: reply with FOLLOWUP_OK. RECOVERY_FOLLOWUP_${label}_${runId}`,
            sessionKey,
            idempotencyKey: runId,
            deliver: false,
          },
          expectFinal: true,
          timeoutMs: 120000,
        });
        results.push({ label, runId, result });
        console.log("REPRO_GATEWAY_RESULT " + JSON.stringify({ label, result }));
      } catch (error) {
        results.push({ label, runId, error: String(error) });
        console.log("REPRO_GATEWAY_RESULT " + JSON.stringify({ label, error: String(error) }));
      }
    }
    fs.writeFileSync(root + "/gateway-results.json", JSON.stringify(results, null, 2));
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (sibling) {
    process.send?.({ kind: "release-sibling" });
    const result = await sibling;
    fs.writeFileSync(root + "/sibling-result.json", JSON.stringify(result));
    console.log("SIBLING_RESULT " + JSON.stringify(result));
  }
  off();
  await server?.close({ reason: "isolated recovery reproduction complete" });
  await claim?.release();
  process.disconnect?.();
  process.exit(process.exitCode ?? 0);
}
