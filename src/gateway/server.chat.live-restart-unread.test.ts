/**
 * LIVE E2E proof for #159285: a restart-safe Control-UI admission that terminalizes
 * through the real Gateway must advance `lastActivityAt`, which makes
 * `deriveSessionUnread` true so the session list shows the unread marker for a
 * turn the user never saw.
 *
 * The flow is a real in-process Gateway + real `chat.send` RPC from a browser
 * Control-UI client. The seeded session is an idle restart-safe admission target,
 * and a saved project repository that cannot be normalized fails dispatch before
 * agent session preparation or the agent run can own terminal persistence, so the
 * restart-safe claim terminalizes on the Gateway's own writer (no timing race).
 */
import path from "node:path";
import { expect, it, vi } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deriveSessionUnread } from "../shared/session-unread.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";

it("LIVE: a terminal restart-safe admission marks the Control UI session unread", async () => {
  const token = "live-restart-unread-token";
  const state = await createOpenClawTestState({
    label: "live-restart-unread",
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
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  try {
    const cfg = {
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          skipBootstrap: true,
          maxConcurrent: 1,
          model: { primary: "openai/gpt-4o-mini", fallbacks: [] },
        },
        entries: { main: { default: true } },
      },
      messages: { queue: { mode: "followup", debounceMsByChannel: { webchat: 0 } } },
      models: { mode: "replace", providers: {} },
      gateway: {
        auth: { mode: "token", token },
        controlUi: { allowedOrigins: ["http://localhost:18789"] },
      },
      plugins: { slots: { memory: "none" } },
    } satisfies OpenClawConfig;
    gateway = await startGatewayWithClient({
      cfg,
      configPath: state.configPath,
      token,
      clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      origin: "http://localhost:18789",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    await gateway.server.startupSettled;
    const client = gateway.client;
    const runId = "live-restart-unread-run";
    const sessionKey = "agent:main:dashboard:live-restart-unread";
    const sessionId = "live-restart-unread-session";
    const target = {
      agentId: "main",
      sessionKey,
      storePath: path.join(state.statePath("agents", "main", "sessions"), "sessions.json"),
    };
    const baselineAt = Date.now() - 60_000;
    await replaceSessionEntry(target, {
      sessionId,
      displayName: "Restart-safe unread probe",
      createdAt: baselineAt,
      updatedAt: baselineAt,
      status: "done",
      abortedLastRun: false,
      // Fails dispatch before the agent run starts, so the restart-safe claim
      // terminalizes on the Gateway's own writer instead of the agent's.
      pendingProjectGitUrl: "not a repository url",
    });
    // A read, idle row with no activity after its creation baseline.
    expect(deriveSessionUnread(loadSessionEntry(target))).toBe(false);

    await expect(
      client.request("chat.send", {
        sessionKey,
        sessionId,
        message: "Please answer this restart-safe live request.",
        idempotencyKey: runId,
        deliver: false,
      }),
    ).resolves.toMatchObject({ runId, status: "started" });

    // The restart-safe admission commits its durable claim, then terminalizes it
    // on the Gateway's writer because no agent run ever took over persistence.
    await vi.waitFor(
      () => {
        const entry = loadSessionEntry(target);
        expect(entry?.restartRecoveryDeliveryRunId).toBe(runId);
        expect(entry?.status).toBe("failed");
      },
      { timeout: 25_000 },
    );

    const row = loadSessionEntry(target);
    // eslint-disable-next-line no-console
    console.log(
      `LIVE_RESTART_UNREAD status=${String(row?.status)} claim=${String(row?.restartRecoveryDeliveryRunId)} unread=${deriveSessionUnread(row)} lastActivityAt=${String(row?.lastActivityAt)} lastInteractionAt=${String(row?.lastInteractionAt)} lastReadAt=${String(row?.lastReadAt)} createdAt=${String(row?.createdAt)}`,
    );
    // lastActivityAt is the #155690 gate: without controlUiVisible the terminal
    // restart-safe write advances no activity and the reply reads as seen.
    expect(row?.lastActivityAt).toBeGreaterThan(baselineAt);
    expect(deriveSessionUnread(row)).toBe(true);
  } finally {
    if (gateway) {
      await disconnectGatewayClient(gateway.client).catch(() => undefined);
      await gateway.server.close().catch(() => undefined);
    }
    await state.cleanup();
  }
}, 120_000);
