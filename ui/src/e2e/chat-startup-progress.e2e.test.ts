import { writeFile } from "node:fs/promises";
import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import type { WorkerEnvironmentStartStatus } from "../../../packages/gateway-protocol/src/schema/environments.ts";
import { buildGatewaySessionSnapshot } from "../../../src/gateway/session-event-payload.ts";
import type { GatewaySessionRow } from "../../../src/gateway/session-utils.types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createChatFlowE2eSuite, installMockGateway } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
let proofDir: string;
beforeEach(() => {
  if (capture) {
    proofDir = createControlUiE2eArtifactDir("duplicate-session-naming");
  }
});
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

suite.define(() => {
  it("preserves tool and approval activity received before the send ACK", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
      ...(capture ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 900 } } } : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [],
      deferredMethods: ["exec.approval.list"],
    });
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      await gateway.waitForRequest("exec.approval.list");
      await gateway.deferNext("chat.send");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Inspect this synthetic workspace");
      await composer.press("Enter");
      const send = await gateway.waitForRequest("chat.send");
      const { idempotencyKey: runId, sessionKey } = send.params as {
        idempotencyKey: string;
        sessionKey: string;
      };
      await gateway.emitGatewayEvent("agent", {
        runId,
        sessionKey,
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
        request: { command: "pwd", agentId: "main", sessionKey, runId },
      });
      await gateway.emitGatewayEvent("agent", {
        runId,
        sessionKey,
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
      if (capture) {
        await writeFile(
          path.join(proofDir, "preack-pending.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [tool, working]),
        );
      }
      await gateway.resolveDeferred("chat.send", { status: "started", runId });
      if (capture) {
        await writeFile(
          path.join(proofDir, "preack-adopted.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [tool, working]),
        );
      }
      await expect.poll(() => tool.count()).toBe(1);
      await expect.poll(() => working.textContent()).toContain("Waiting for approval");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("retains current startup progress through delayed history", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
      ...(capture ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 900 } } } : {}),
    });
    const page = await context.newPage();
    const runId = "synthetic-workspace-run";
    const sessionKey = "agent:main:main";
    const sessionInfo = {
      key: sessionKey,
      kind: "direct",
      updatedAt: 1,
      status: "running",
      hasActiveRun: true,
      activeRunIds: [runId],
    };
    const inFlightRun = {
      runId,
      text: "",
      events: [
        {
          runId,
          sessionKey,
          seq: 2,
          stream: "run_status",
          ts: 1,
          data: { phase: "naming_worktree" },
        },
      ],
    };
    const gateway = await installMockGateway(page, {
      sessions: [sessionInfo],
      sessionInfo,
      inFlightRun,
      historyMessages: [],
    });
    try {
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
      if (capture) {
        await writeFile(
          path.join(proofDir, "history.png"),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [working]),
        );
      }
      await expect.poll(() => working.textContent()).not.toContain("Naming worktree…");
      await expect.poll(() => working.textContent()).toContain("Creating worktree…");
      await gateway.emitChatFinal({
        runId,
        sessionKey,
        text: "Workspace verification complete.",
      });
      await expect.poll(() => working.count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
  it("shows snapshot, first preparation, and capture in one startup line", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const sessionKey = "agent:main:main";
    const runId = "synthetic-cloud-start";
    const startedAt = Date.now();
    const session: GatewaySessionRow & { updatedAt: number } = {
      key: sessionKey,
      sessionId: "synthetic-cloud-session",
      kind: "direct",
      updatedAt: startedAt,
      status: "running",
      hasActiveRun: true,
      activeRunIds: [runId],
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
        runId,
        startedAt,
        text: "",
        events: [
          {
            runId,
            sessionKey,
            seq: 2,
            stream: "run_status",
            ts: startedAt,
            data: { phase: "provisioning_environment" },
          },
        ],
      },
    });
    const artifactDir = capture ? createControlUiE2eArtifactDir("cloud-start-status") : undefined;
    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const working = page.locator('.chat-working-indicator[role="status"]');
      await expect.poll(() => working.textContent()).toContain("Provisioning environment…");
      const screenshot = async (fileName: string) => {
        if (artifactDir) {
          await writeFile(
            path.join(artifactDir, fileName),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [working]),
          );
        }
      };
      await screenshot("00-before.png");
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
          state: "provisioning",
          environmentId: "worker:synthetic",
          providerId: "crabbox",
          generation: 1,
          createdAtMs: 1,
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
        await screenshot(fileName);
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
