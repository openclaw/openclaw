import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type { WorkerEnvironmentStartStatus } from "../../../packages/gateway-protocol/src/schema/environments.ts";
import { buildGatewaySessionSnapshot } from "../../../src/gateway/session-event-payload.ts";
import type { GatewaySessionRow } from "../../../src/gateway/session-utils.types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const viewport = { width: 1280, height: 900 };
const sessionKey = "agent:main:main";
const activeSession = (
  runId: string,
  updatedAt = 1,
): GatewaySessionRow & { updatedAt: number } => ({
  key: sessionKey,
  kind: "direct",
  updatedAt,
  status: "running",
  hasActiveRun: true,
  activeRunIds: [runId],
});
const inFlight = (runId: string, phase: string, ts = 1) => ({
  runId,
  text: "",
  events: [{ runId, sessionKey, seq: 2, stream: "run_status", ts, data: { phase } }],
});
async function withPage(
  run: (
    page: Page,
    screenshot: (name: string, targets: Locator[]) => Promise<void>,
  ) => Promise<void>,
  video = true,
) {
  const proofDir = capture
    ? createControlUiE2eArtifactDir(video ? "duplicate-session-naming" : "cloud-start-status")
    : undefined;
  await suite.withPage(
    {
      locale: "en-US",
      serviceWorkers: "block",
      viewport,
      ...(proofDir && video ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
    },
    async ({ page }) => {
      await run(page, async (name, targets) => {
        if (proofDir) {
          await writeFile(
            path.join(proofDir, name),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), targets),
          );
        }
      });
    },
  );
}

suite.define(() => {
  it("preserves tool and approval activity received before the send ACK", async () => {
    await withPage(async (page, screenshot) => {
      const gateway = await installMockGateway(page, {
        historyMessages: [],
        deferredMethods: ["exec.approval.list"],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await gateway.waitForRequest("exec.approval.list");
      await gateway.deferNext("chat.send");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Inspect this synthetic workspace");
      await composer.press("Enter");
      const send = await gateway.waitForRequest("chat.send");
      const { idempotencyKey: runId, sessionKey: sendSessionKey } = send.params as {
        idempotencyKey: string;
        sessionKey: string;
      };
      await gateway.emitGatewayEvent("agent", {
        runId,
        sessionKey: sendSessionKey,
        seq: 2,
        ts: Date.now(),
        stream: "tool",
        data: {
          phase: "start",
          toolCallId: "synthetic-exec",
          name: "exec",
          args: { command: "pwd" },
        },
      });
      await gateway.emitGatewayEvent("exec.approval.requested", {
        id: "synthetic-approval",
        createdAtMs: Date.now(),
        expiresAtMs: Date.now() + 60_000,
        request: { command: "pwd", agentId: "main", sessionKey: sendSessionKey, runId },
      });
      await gateway.emitGatewayEvent("agent", {
        runId,
        sessionKey: sendSessionKey,
        seq: 3,
        ts: Date.now(),
        stream: "lifecycle",
        data: {
          phase: "waiting-approval",
          approvalId: "synthetic-approval",
          toolCallId: "synthetic-exec",
        },
      });
      const tool = page.locator(".chat-tool-msg-summary", { hasText: "pwd" });
      const working = page.locator('.chat-working-indicator[role="status"]');
      await expect.poll(() => tool.count()).toBe(1);
      await expect.poll(() => working.textContent()).toContain("Waiting for approval");
      // The initial snapshot predates registration; it must retain the newer live approval.
      await gateway.resolveDeferred("exec.approval.list", []);
      await expect.poll(() => working.textContent()).toContain("Waiting for approval");
      await screenshot("preack-pending.png", [tool, working]);
      await gateway.resolveDeferred("chat.send", { status: "started", runId });
      await screenshot("preack-adopted.png", [tool, working]);
      await expect.poll(() => tool.count()).toBe(1);
      await expect.poll(() => working.textContent()).toContain("Waiting for approval");
    });
  });

  it("retains current startup progress through delayed history", async () => {
    await withPage(async (page, screenshot) => {
      const runId = "synthetic-workspace-run";
      const sessionInfo = activeSession(runId);
      const inFlightRun = inFlight(runId, "naming_worktree");
      const gateway = await installMockGateway(page, {
        sessions: [sessionInfo],
        sessionInfo,
        inFlightRun,
        historyMessages: [],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const working = page.locator('.chat-working-indicator[role="status"]');
      await expect.poll(() => working.textContent()).toContain("Naming worktree…");
      const before = (await gateway.getRequests("chat.history")).length;
      await gateway.deferNext("chat.history");
      await gateway.emitGatewayEvent("session.message", {
        sessionKey,
        session: sessionInfo,
        hasActiveRun: true,
        activeRunIds: [runId],
        message: {
          role: "user",
          content: [{ type: "text", text: "Workspace check requested." }],
          __openclaw: { id: "synthetic-peer-message", seq: 3 },
        },
        messageId: "synthetic-peer-message",
        messageSeq: 3,
      });
      await gateway.waitForRequest("chat.history", { after: before });
      await gateway.emitGatewayEvent("chat", {
        runId,
        sessionKey,
        seq: 3,
        state: "status",
        phase: "creating_worktree",
      });
      await expect.poll(() => working.textContent()).toContain("Creating worktree…");
      await gateway.resolveDeferred("chat.history", { messages: [], sessionInfo, inFlightRun });
      // Capture the observed result before asserting so the red run leaves honest visual evidence.
      await screenshot("history.png", [working]);
      await expect.poll(() => working.textContent()).not.toContain("Naming worktree…");
      await expect.poll(() => working.textContent()).toContain("Creating worktree…");
      await gateway.emitChatFinal({
        runId,
        sessionKey,
        text: "Workspace verification complete.",
      });
      await expect.poll(() => working.count()).toBe(0);
    });
  });
  it("shows snapshot, first preparation, and capture in one startup line", async () => {
    await withPage(async (page, screenshot) => {
      const runId = "synthetic-cloud-start";
      const startedAt = Date.now();
      const session: GatewaySessionRow & { updatedAt: number } = {
        ...activeSession(runId, startedAt),
        sessionId: "synthetic-cloud-session",
        placement: {
          state: "provisioning",
          environmentId: "worker:synthetic",
          providerId: "crabbox",
          generation: 1,
          createdAtMs: 1,
          updatedAtMs: 1,
          stateChangedAtMs: 1,
        },
      };
      const gateway = await installMockGateway(page, {
        sessions: [session],
        sessionInfo: session,
        historyMessages: [],
        inFlightRun: {
          ...inFlight(runId, "provisioning_environment", startedAt),
          startedAt,
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const working = page.locator('.chat-working-indicator[role="status"]');
      await expect.poll(() => working.textContent()).toContain("Provisioning environment…");
      await screenshot("00-before.png", [working]);
      const states: Array<[WorkerEnvironmentStartStatus, string, string]> = [
        [{ mode: "snapshot" }, "Starting from snapshot…", "01-snapshot.png"],
        [
          { mode: "cold", reason: "no-snapshot-yet", phase: "preparing" },
          "Preparing cloud environment…",
          "02-preparing.png",
        ],
        [
          { mode: "cold", reason: "no-snapshot-yet", phase: "saving" },
          "Saving snapshot…",
          "03-saving.png",
        ],
      ];
      let revision = 1;
      for (const [startStatus, label, fileName] of states) {
        revision += 1;
        const now = await page.evaluate(() => Date.now());
        session.updatedAt = now;
        session.snapshotAt = now;
        session.placement = {
          ...session.placement!,
          updatedAtMs: revision,
          stateChangedAtMs: revision,
          startStatus,
        };
        await gateway.setSessionsListResponse({ sessions: [session], count: 1, ts: now });
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey,
          agentId: "main",
          reason: "dispatch",
          ts: now,
          ancestorSessions: [],
          ...buildGatewaySessionSnapshot({
            sessionRow: session,
            agentId: "main",
            includeSession: true,
          }),
          placement: session.placement,
          placementMove: null,
        });
        await expect.poll(() => working.textContent()).toContain(label);
        expect(await working.count()).toBe(1);
        expect(await working.textContent()).not.toContain("no-snapshot-yet");
        await screenshot(fileName, [working]);
      }
    }, false);
  });
});
