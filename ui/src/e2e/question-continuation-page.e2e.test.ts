import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI retained question continuation document",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

suite.define(() => {
  it.each(["blocked", "interrupted"] as const)(
    "retains the newer %s receipt when the initial question read arrives late",
    async (status) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
        async ({ page }) => {
          const id = `late-question-document-${status}`;
          const createdAtMs = Date.now();
          const pending = {
            id,
            agentId: "main",
            sessionKey: "agent:main:question-proof",
            createdAtMs,
            expiresAtMs: createdAtMs + 15 * 60_000,
            status: "pending",
            questions: [
              {
                questionId: "environment",
                header: "Environment",
                question: "Which environment should receive the release?",
                options: [{ label: "Staging" }, { label: "Production" }],
              },
            ],
          };
          const answers = { answers: { environment: ["Staging"] } };
          const answered = { ...pending, status: "answered", answers };
          const reason = `The saved continuation is ${status}.`;
          const nextAction = "Start a new user turn using the saved answer.";
          const getSelector = { match: { id, includeContinuation: true }, exactParams: true };
          const listSelector = { match: { includeContinuation: true }, exactParams: true };
          const gateway = await installMockGateway(page, {
            basePath: "/operator",
            featureMethods: ["question.get", "question.list"],
            deferredRequests: [{ method: "question.get", ...getSelector }],
            methodResponses: {
              "question.get": { question: pending },
              "question.list": { questions: [pending] },
            },
          });
          await page.goto(new URL(`operator/ask/${id}`, suite.server.baseUrl).toString());
          await gateway.waitForRequest("question.get", getSelector);
          const document = page.locator("openclaw-question-page");
          await gateway.emitGatewayEvent("question.requested", pending);
          await document.locator('main[data-state="pending"]').waitFor();
          const after = await gateway.deferNext("question.list", listSelector.match, {
            exactParams: true,
          });
          await gateway.emitGatewayEvent("question.resolved", { id, status: "answered", answers });
          await gateway.waitForRequest("question.list", { ...listSelector, after });
          await gateway.resolveDeferred(
            "question.list",
            {
              questions: [answered],
              continuations: [{ questionId: id, status, reason, nextAction }],
            },
            listSelector,
          );
          await gateway.resolveDeferred("question.get", { question: pending }, getSelector);
          await document.getByRole("heading", { name: "Answered", exact: true }).waitFor();
          const summary = document.locator(".chat-question-summary");
          await expect
            .poll(() => summary.getByText(`${reason} ${nextAction}`, { exact: true }).count())
            .toBe(1);
          expect(await summary.locator(".chat-question-summary__line").textContent()).toContain(
            "Staging",
          );
          expect(await document.locator("openclaw-chat-question-panel").count()).toBe(0);
        },
      );
    },
  );
  it.each(["blocked", "interrupted"] as const)(
    "retains the %s receipt and accepted answer on the mounted question document after reload",
    async (status) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
        async ({ page }) => {
          const id = `question-document-${status}`;
          const createdAtMs = Date.now();
          const question = {
            id,
            agentId: "main",
            sessionKey: "agent:main:question-proof",
            createdAtMs,
            expiresAtMs: createdAtMs + 15 * 60_000,
            status: "answered",
            questions: [
              {
                questionId: "environment",
                header: "Environment",
                question: "Which environment should receive the release?",
                options: [{ label: "Staging" }, { label: "Production" }],
              },
            ],
            answers: { answers: { environment: ["Staging"] } },
          };
          const reason = `The saved continuation is ${status}.`;
          const nextAction = "Start a new user turn using the saved answer.";
          const continuation = { questionId: id, status, reason, nextAction };
          const gateway = await installMockGateway(page, {
            basePath: "/operator",
            featureMethods: ["question.get", "question.list"],
            methodResponses: {
              "question.get": { question, continuation },
              "question.list": { questions: [question], continuations: [continuation] },
            },
          });
          const url = new URL(`operator/ask/${encodeURIComponent(id)}`, suite.server.baseUrl);
          await page.goto(url.toString());
          for (const reload of [false, true]) {
            if (reload) {
              await page.reload();
            }
            const request = await gateway.waitForRequest("question.get");
            expect(request.params).toEqual({ id, includeContinuation: true });
            const document = page.locator("openclaw-question-page");
            await document.getByRole("heading", { name: "Answered", exact: true }).waitFor();
            const summary = document.locator(".chat-question-summary");
            await expect
              .poll(() => summary.getByText(`${reason} ${nextAction}`, { exact: true }).count())
              .toBe(1);
            expect(
              await document.getByText(`${reason} ${nextAction}`, { exact: true }).count(),
            ).toBe(1);
            expect(await summary.locator(".chat-question-summary__line").textContent()).toContain(
              "Staging",
            );
            expect(await document.locator("openclaw-chat-question-panel").count()).toBe(0);
            expect(new URL(page.url()).pathname).toBe(`/operator/ask/${id}`);
          }
        },
      );
    },
  );
});
