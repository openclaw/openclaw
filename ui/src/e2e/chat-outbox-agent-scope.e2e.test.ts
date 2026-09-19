import { writeSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  chatSessionListResponse,
  controlUiSessionPath,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("drains an inactive agent outbox while the selected global agent is active", async (testContext) => {
    const startedAt = performance.now();
    let timeoutStage = "starting";
    if (process.env.OPENCLAW_UI_E2E_DIAGNOSTIC_DIR?.trim()) {
      const reportTimeout = () => {
        writeSync(
          2,
          `${JSON.stringify({
            diagnostic: "inactive-agent-outbox-timeout",
            stage: timeoutStage,
            elapsedMs: Math.round(performance.now() - startedAt),
          })}\n`,
        );
      };
      // Vitest aborts this signal before timeout cleanup can advance the stage.
      testContext.signal.addEventListener("abort", reportTimeout, { once: true });
      testContext.onTestFinished(() =>
        testContext.signal.removeEventListener("abort", reportTimeout),
      );
    }
    const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const artifactDir = artifactRoot
      ? createControlUiE2eArtifactDir("chat-outbox-agent-scope", artifactRoot)
      : undefined;
    timeoutStage = "create browser context";
    const context = await suite.newBrowserContext({
      locale: "en-US",
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    timeoutStage = "create page";
    const page = await context.newPage();
    const activePane = page.locator(".chat-pane-cache__pane--active");
    const agentsList = {
      agents: [
        { id: "main", name: "Main" },
        { id: "work", name: "Work" },
      ],
      defaultId: "main",
      mainKey: "main",
      scope: "global",
    };
    const historyResponse = (agentId: "main" | "work", active: boolean) => ({
      messages: [],
      sessionId: `${agentId}-global-session`,
      sessionInfo: {
        activeRunIds: active ? [`${agentId}-active-run`] : [],
        hasActiveRun: active,
        key: "global",
        status: active ? "running" : "done",
      },
      thinkingLevel: null,
    });
    const sessionsResponse = (active: boolean) =>
      chatSessionListResponse([
        {
          activeRunIds: active ? ["main-active-run"] : [],
          hasActiveRun: active,
          key: "global",
          kind: "global",
          label: "Main Session",
          status: active ? "running" : "done",
          updatedAt: Date.now(),
        },
      ]);
    timeoutStage = "install mock Gateway";
    const gateway = await installMockGateway(page, {
      sessionScope: "global",
      mainSessionKey: "global",
      methodResponses: {
        "agents.list": agentsList,
        "chat.history": {
          cases: [
            {
              match: { agentId: "work", sessionKey: "global" },
              response: historyResponse("work", true),
            },
            {
              match: { agentId: "main", sessionKey: "global" },
              response: historyResponse("main", true),
            },
          ],
        },
        "chat.startup": {
          cases: [
            {
              match: { agentId: "work" },
              response: { ...historyResponse("work", false), agentsList },
            },
            {
              match: { agentId: "main" },
              response: { ...historyResponse("main", true), agentsList },
            },
          ],
        },
        "sessions.list": {
          cases: [
            { match: { agentId: "work" }, response: sessionsResponse(false) },
            { match: { agentId: "main" }, response: sessionsResponse(true) },
          ],
        },
      },
    });

    try {
      timeoutStage = "navigate to work agent";
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:work:main"));
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      timeoutStage = "wait for composer";
      await composer.waitFor({ state: "visible", timeout: 10_000 });
      timeoutStage = "go offline";
      await gateway.setOnline(false);
      timeoutStage = "wait for offline warning";
      await page
        .locator('.agent-chat__composer-status[data-tone="warn"] .agent-chat__composer-status-band')
        .waitFor({ timeout: 10_000 });

      const prompt = "deliver the work outbox independently";
      timeoutStage = "fill composer";
      await composer.fill(prompt);
      timeoutStage = "queue message";
      await page.getByRole("button", { name: "Send message" }).click();
      const queue = page.locator(".chat-queue");
      timeoutStage = "wait for queued outbox";
      await queue.getByText("Waiting for reconnect").waitFor({ timeout: 10_000 });
      if (artifactDir) {
        timeoutStage = "capture offline outbox";
        await writeFile(
          `${artifactDir}/inactive-agent-offline.png`,
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [queue]),
        );
      }
      timeoutStage = "navigate to main agent";
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:main"));
      timeoutStage = "select main agent";
      await page.evaluate(() => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: { context: { agentSelection: { set: (agentId: string) => void } } };
        };
        app.runtime?.context.agentSelection.set("main");
      });
      // A cold roster must not send the canonical global route back through its alias.
      const mainRoster = { agentId: "main", includeGlobal: true };
      timeoutStage = "defer main session roster";
      await gateway.deferNext("sessions.list", mainRoster);
      timeoutStage = "reconnect Gateway";
      await gateway.setOnline(true);
      timeoutStage = "wait for online composer";
      await page
        .locator('.agent-chat__composer-status[data-tone="warn"] .agent-chat__composer-status-band')
        .waitFor({ state: "detached", timeout: 10_000 });
      timeoutStage = "wait for transcript readiness";
      await expect
        .poll(() =>
          activePane.evaluate(
            (pane) => (pane as HTMLElement & { transcriptReady: boolean }).transcriptReady,
          ),
        )
        .toBe(true);
      timeoutStage = "wait for main session roster request";
      await gateway.waitForRequest("sessions.list", { match: mainRoster });
      timeoutStage = "resolve main session roster";
      await gateway.resolveDeferred("sessions.list", sessionsResponse(true));

      timeoutStage = "observe main session list";
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).some(
            (entry) => requireRecord(entry.params).agentId === "main",
          ),
        )
        .toBe(true);
      timeoutStage = "observe chat history";
      await expect
        .poll(async () => (await gateway.getRequests("chat.history")).length)
        .toBeGreaterThan(0);
      timeoutStage = "check no early send";
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      timeoutStage = "defer outbox send";
      await gateway.deferNext("chat.send");
      timeoutStage = "install idle work history";
      await gateway.setMethodResponse("chat.history", {
        cases: [
          {
            match: { agentId: "work", sessionKey: "global" },
            response: historyResponse("work", false),
          },
          {
            match: { agentId: "main", sessionKey: "global" },
            response: historyResponse("main", true),
          },
        ],
      });
      timeoutStage = "emit work completion";
      await gateway.emitGatewayEvent("sessions.changed", {
        activeRunIds: [],
        agentId: "work",
        hasActiveRun: false,
        key: "global",
        kind: "global",
        status: "done",
      });

      timeoutStage = "wait for outbox send";
      const request = await gateway.waitForRequest("chat.send");
      const params = requireRecord(request.params);
      expect(params).toMatchObject({ agentId: "work", message: prompt, sessionKey: "global" });
      const runId = requireString(params.idempotencyKey, "inactive-agent outbox run id");
      timeoutStage = "check single send";
      await expectRequestCountStable(gateway, "chat.send", 1);
      timeoutStage = "read recovery requests";
      const recoveryRequests = (await gateway.getRequests("chat.history"))
        .map((entry) => requireRecord(entry.params))
        .filter((historyParams) => Array.isArray(historyParams.inputRunIds));
      expect(recoveryRequests.length).toBeGreaterThan(0);
      for (const historyParams of recoveryRequests) {
        expect(historyParams).toMatchObject({
          agentId: "work",
          sessionKey: "global",
          inputRunIds: [runId],
        });
      }
      const workPath = controlUiSessionPath("agent:work:main");
      timeoutStage = "select and navigate work agent";
      await page.evaluate((pathname) => {
        const app = document.querySelector("openclaw-app") as HTMLElement & {
          runtime?: {
            context: {
              agentSelection: { set: (agentId: string) => void };
              navigate: (routeId: string, options: { pathname: string }) => void;
            };
          };
        };
        if (!app.runtime) {
          throw new Error("OpenClaw application runtime is unavailable");
        }
        app.runtime.context.agentSelection.set("work");
        app.runtime.context.navigate("chat", { pathname });
      }, workPath);
      timeoutStage = "wait for work URL";
      await page.waitForURL((url) => url.pathname === workPath);
      timeoutStage = "install user history";
      await gateway.setHistoryMessages([
        {
          content: prompt,
          idempotencyKey: `${runId}:user`,
          role: "user",
          timestamp: Date.now(),
        },
      ]);
      timeoutStage = "emit user message";
      await gateway.emitGatewayEvent("session.message", {
        agentId: "work",
        clientRunId: runId,
        hasActiveRun: true,
        message: {
          __openclaw: { id: "work-outbox-user", idempotencyKey: `${runId}:user`, seq: 1 },
          content: [{ text: prompt, type: "text" }],
          role: "user",
          timestamp: Date.now(),
        },
        messageId: "work-outbox-user",
        messageSeq: 1,
        sessionKey: "global",
        status: "running",
      });
      timeoutStage = "wait for user message";
      await activePane.locator(".chat-group.user").getByText(prompt).waitFor({ timeout: 10_000 });
      timeoutStage = "resolve outbox send";
      await gateway.resolveDeferred("chat.send", { runId, status: "started" });
      if (artifactDir) {
        timeoutStage = "capture dispatched outbox";
        await writeFile(
          `${artifactDir}/inactive-agent-dispatched.png`,
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
            activePane.locator(".chat-group.user").getByText(prompt),
          ]),
        );
      }

      timeoutStage = "emit final reply";
      await gateway.emitGatewayEvent("chat", {
        agentId: "work",
        message: {
          content: [{ text: "Work outbox delivered.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
        runId,
        sessionKey: "global",
        state: "final",
      });
      timeoutStage = "wait for outbox drain";
      await queue.waitFor({ state: "detached", timeout: 10_000 });
      // Retained panes also receive this conversation's events; assert its rendered owner.
      const reply = activePane
        .locator(".chat-group.assistant")
        .getByText("Work outbox delivered.", { exact: true });
      timeoutStage = "wait for assistant reply";
      await reply.waitFor({ timeout: 10_000 });
      timeoutStage = "check stable send count";
      await expectRequestCountStable(gateway, "chat.send", 1);
      timeoutStage = "check active pane";
      expect(await activePane.count()).toBe(1);
      timeoutStage = "check single reply";
      expect(await reply.count()).toBe(1);
      timeoutStage = "read rendered messages";
      const messages = await activePane.evaluate(
        (pane) => (pane as HTMLElement & { state: { chatMessages: unknown[] } }).state.chatMessages,
      );
      expect(messages.map(requireRecord).filter((message) => message.role === "assistant")).toEqual(
        [
          expect.objectContaining({
            content: [{ text: "Work outbox delivered.", type: "text" }],
          }),
        ],
      );
      if (artifactDir) {
        timeoutStage = "capture delivered outbox";
        await writeFile(
          `${artifactDir}/inactive-agent-delivered.png`,
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [reply]),
        );
      }
    } finally {
      timeoutStage = "close browser context";
      await suite.closeBrowserContext(context);
    }
  });
});
