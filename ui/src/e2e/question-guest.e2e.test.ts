import type { Page } from "playwright";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  createGuestQuestionFixture,
  guestQuestionPrompt,
  guestQuestionScopes,
  guestQuestionSessionKey as sessionKey,
} from "./question-guest.test-support.ts";

declare global {
  interface Window {
    dispatchGuestQuestion: Awaited<ReturnType<typeof createGuestQuestionFixture>>["request"];
  }
}

const suite = createControlUiE2eSuite({
  name: "Guest ordinary question lifecycle",
  startServerBeforeBrowser: true,
});
const settle = (turn: Promise<unknown>) =>
  turn.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

async function releaseQuestionBridge(page: Page, gateway: MockGatewayControls) {
  await gateway.waitForRequest("connect");
  await page.evaluate(() => {
    const owner: MockGatewayWindow = window;
    if (!owner.openclawControlUiE2eGateway) {
      throw new Error("question browser fixture is not installed");
    }
    for (const method of ["question.list", "question.get", "question.resolve"]) {
      owner.openclawControlUiE2eGateway.setRequestHandler(method, ({ params, respond }) => {
        void owner.dispatchGuestQuestion(method, params).then((result) => {
          respond(result.ok ? result.payload : { __mockError: result.error });
        });
      });
    }
  });
  await gateway.resolveDeferred("connect");
}

suite.define(() => {
  it("recovers and answers its own admitted run's question and settles cancellation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        colorScheme: "dark",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
      });
      const page = await context.newPage();
      let gateway: MockGatewayControls | undefined;
      const fixture = await createGuestQuestionFixture(async (frame) => {
        if (!gateway) {
          throw new Error("question event arrived before its browser recipient");
        }
        await gateway.deliverLatest(frame);
      });
      const turns: Promise<unknown>[] = [];
      const run = new AbortController();
      try {
        await page.exposeFunction("dispatchGuestQuestion", fixture.request);
        gateway = await installMockGateway(page, {
          heldMethods: ["connect"],
          operatorScopes: guestQuestionScopes,
          sessionKey,
          mainSessionKey: "agent:main:main",
          featureMethods: [
            "chat.startup",
            "chat.metadata",
            "question.list",
            "question.get",
            "question.resolve",
          ],
          presenceUsers: [
            {
              self: true,
              id: fixture.profileId,
              identity: { type: "profile", id: fixture.profileId },
            },
          ],
          sessions: [
            {
              key: sessionKey,
              sessionId: "guest-question-session",
              kind: "direct",
              visibility: "shared",
              sharingRole: "owner",
            },
          ],
          historyMessages: [],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await releaseQuestionBridge(page, gateway);
        await page.locator(".agent-chat__composer-combobox textarea").waitFor();
        const result = settle(fixture.ask("summary-format", run.signal));
        turns.push(result);
        expect(await fixture.registration).toMatchObject({ ok: true });
        await fixture.flushEvents();
        const panel = page.locator(".agent-chat__question-dock openclaw-chat-question-panel");
        await panel.getByText(guestQuestionPrompt, { exact: true }).waitFor();
        const listCount = () =>
          fixture.requests.filter(({ method }) => method === "question.list").length;
        const initialLists = listCount();

        fixture.disconnect();
        await page.reload();
        fixture.reconnect();
        await releaseQuestionBridge(page, gateway);
        await panel.getByText(guestQuestionPrompt, { exact: true }).waitFor();
        expect(listCount()).toBeGreaterThan(initialLists);
        await panel.getByRole("radio", { name: /Concise/ }).click();
        await panel.getByRole("button", { name: "Submit", exact: true }).click();
        expect(await result).toMatchObject({
          ok: true,
          value: { details: { status: "answered", answers: { answers: { format: ["Concise"] } } } },
        });
        await page.locator(".chat-question-summary").filter({ hasText: "Concise" }).waitFor();
        expect(await panel.count()).toBe(0);

        const cancelled = settle(fixture.ask("cancelled-format", run.signal));
        turns.push(cancelled);
        await panel.getByText(guestQuestionPrompt, { exact: true }).waitFor();
        run.abort(new Error("Synthetic run stopped"));
        expect(await cancelled).toMatchObject({ ok: false });
        await fixture.flushEvents();
        await page.locator(".chat-question-summary").filter({ hasText: "Skipped" }).waitFor();
        expect(await panel.count()).toBe(0);
        expect(
          fixture.requests.findLast((request) => request.method === "question.resolve"),
        ).toMatchObject({ params: { cancel: true }, result: { ok: true } });
      } finally {
        run.abort();
        await fixture.close();
        await Promise.allSettled(turns);
        await suite.closeBrowserContext(context);
      }
    });
  });
});
