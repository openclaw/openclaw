import path from "node:path";
import { expect, it } from "vitest";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { writeAgentRunTerminalReceipt } from "../state/agent-run-terminal-receipts.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resetAgentJobStateForTest } from "./agent-turn/agent-job.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

it(
  "recovers terminal receipts across a live Gateway restart and denies stale owner shapes",
  { timeout: 120_000 },
  async () => {
    const token = "synthetic-terminal-receipt-token";
    const state = await createOpenClawTestState({
      label: "terminal-receipt-restart",
      env: {
        OPENCLAW_GATEWAY_TOKEN: token,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    const agentId = "main";
    const sessionKey = "agent:main:terminal-receipt-restart";
    const sessionId = "session-terminal-receipt-restart";
    const runId = "run-terminal-receipt-restart";
    const storePath = path.join(state.stateDir, "agents", agentId, "sessions", "sessions.json");
    const cfg = {
      agents: { entries: { main: {} } },
      gateway: { auth: { mode: "token", token } },
      plugins: { slots: { memory: "none" } },
    };
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;

    const stopGateway = async () => {
      if (!gateway) {
        return;
      }
      await disconnectGatewayClient(gateway.client).catch(() => undefined);
      await gateway.server.close({ reason: "terminal receipt restart proof" });
      gateway = undefined;
      resetAgentJobStateForTest();
      closeOpenClawStateDatabaseForTest();
    };
    const restartGateway = async () => {
      gateway = await startGatewayWithClient({ cfg, configPath: state.configPath, token });
      await gateway.server.startupSettled;
      return gateway.client;
    };

    try {
      await replaceSessionEntry({ agentId, sessionKey, storePath }, { sessionId, updatedAt: 42 });
      writeAgentRunTerminalReceipt({
        runId,
        owner: { agentId, sessionKey, sessionId },
        terminalJson: JSON.stringify({ status: "ok", startedAt: 10, endedAt: 20 }),
      });
      closeOpenClawStateDatabaseForTest();

      await restartGateway();
      await stopGateway();
      const recoveredClient = await restartGateway();
      await expect(recoveredClient.request("agent.wait", { runId, timeoutMs: 0 })).resolves.toEqual(
        {
          runId,
          status: "ok",
          startedAt: 10,
          endedAt: 20,
        },
      );
      await expect(
        recoveredClient.request("sessions.abort", {
          runId,
          key: "agent:main:unrelated-session",
        }),
      ).rejects.toThrow("unauthorized");
      console.log("TERMINAL_RECEIPT_RESTART_ALLOWED", JSON.stringify({ runId, status: "ok" }));
      console.log(
        "TERMINAL_RECEIPT_RESTART_UNRELATED_DENIED",
        JSON.stringify({ runId, error: "unauthorized" }),
      );
      await stopGateway();

      await replaceSessionEntry(
        { agentId, sessionKey, storePath },
        { sessionId: "session-terminal-receipt-replacement", updatedAt: 43 },
      );
      const replacementClient = await restartGateway();
      await expect(replacementClient.request("sessions.abort", { runId })).rejects.toThrow(
        "unauthorized",
      );
      console.log(
        "TERMINAL_RECEIPT_RESTART_REPLACEMENT_DENIED",
        JSON.stringify({ runId, error: "unauthorized" }),
      );
      await stopGateway();

      await deleteSessionEntryLifecycle({
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        archiveTranscript: false,
      });
      const revokedClient = await restartGateway();
      await expect(revokedClient.request("sessions.abort", { runId })).rejects.toThrow(
        "unauthorized",
      );
      console.log(
        "TERMINAL_RECEIPT_RESTART_REVOKED_DENIED",
        JSON.stringify({ runId, error: "unauthorized" }),
      );
    } finally {
      await stopGateway().catch(() => undefined);
      await state.cleanup();
    }
  },
);
