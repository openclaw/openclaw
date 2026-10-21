import type { QuestionRecord } from "@openclaw/gateway-protocol";
import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionList } from "./panel-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Home attention",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const mainSessionKey = "agent:main:main";
const rosterMatch = { includeGlobal: true };

function sessionRow(overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key: mainSessionKey,
    kind: "direct",
    label: "Home",
    displayName: "Quiet control state",
    updatedAt: Date.now(),
    status: "done",
    ...overrides,
  };
}

async function publishSessionRow(
  gateway: MockGatewayControls,
  overrides: Partial<GatewaySessionRow>,
): Promise<void> {
  const row = sessionRow(overrides);
  await gateway.setSessionsListResponse(sessionList(row, "gpt-5.6-luna"));
  const requestCount = (await gateway.getRequests("sessions.list", rosterMatch)).length;
  await gateway.emitGatewayEvent("sessions.changed", {
    key: row.key,
    reason: "home-attention-proof",
    updatedAt: row.updatedAt,
  });
  await expect
    .poll(async () => (await gateway.getRequests("sessions.list", rosterMatch)).length)
    .toBeGreaterThan(requestCount);
}

suite.define(() => {
  it("projects question, failure, and agent-declared attention onto Home", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["question.get", "question.list", "question.resolve"],
      methodResponses: {
        "question.list": { questions: [] },
        "sessions.list": sessionList(sessionRow(), "gpt-5.6-luna"),
      },
      sessionKey: mainSessionKey,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, mainSessionKey));
    await gateway.waitForRequest("sessions.list", { match: rosterMatch });
    const home = page.locator(".sidebar-footer-bar__home");
    await home.waitFor();
    const attentionCount = async () => {
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      return home.locator("[data-session-attention]").count();
    };
    const quiet = await attentionCount();

    await publishSessionRow(gateway, {
      displayName: "Declared attention state",
      status: "running",
      hasActiveRun: true,
      agentStatus: {
        note: "Blocked: operator input required",
        attention: "flag",
        expiresAt: Date.now() + 60_000,
      },
    });
    const agent = await attentionCount();

    const now = Date.now();
    const question = {
      id: "home-attention-question",
      agentId: "main",
      sessionKey: mainSessionKey,
      questions: [
        {
          questionId: "continue_run",
          header: "Continue",
          question: "Should the run continue?",
          options: [{ label: "Continue" }],
        },
      ],
      createdAtMs: now,
      expiresAtMs: now + 60_000,
      status: "pending",
    } satisfies QuestionRecord;
    await gateway.emitGatewayEvent("question.requested", question);
    const questionPanel = page.locator(".chat-question-panel");
    await questionPanel.getByText("Should the run continue?", { exact: true }).waitFor();
    const pendingQuestion = await attentionCount();

    await gateway.emitGatewayEvent("question.resolved", {
      id: question.id,
      status: "cancelled",
    });
    await expect
      .poll(() => questionPanel.getByText("Should the run continue?", { exact: true }).count())
      .toBe(0);
    await publishSessionRow(gateway, {
      displayName: "Failed run state",
      endedAt: Date.now(),
      lastRunError: "Release validation failed",
      status: "failed",
    });
    const error = await attentionCount();

    expect([quiet, agent, pendingQuestion, error]).toEqual([0, 1, 1, 1]);
  });
});
