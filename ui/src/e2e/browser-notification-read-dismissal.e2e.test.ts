import type { Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Browser completion read dismissal" });
const sessionKey = "agent:main:notification-proof";
const answer = "The notification proof has finished.";
const message = {
  role: "assistant", stopReason: "stop", content: [{ type: "text", text: answer }],
  __openclaw: { id: "answer-row", runId: "proof-run", idempotencyKey: "proof-final" },
};
const tags = (page: Page) => page.evaluate(async () =>
  (await (await navigator.serviceWorker.ready).getNotifications()).map((item) => item.tag).toSorted(),
);

// Exercise actual Chromium push delivery, showNotification/getNotifications/close,
// and the shipped worker's post-display hint. Only the Gateway transport is a fixture.
suite.define(() => {
  it("dismisses only a visibly read final, including foreground return and a late push", async () => {
    await suite.withPage({
      permissions: ["notifications"], serviceWorkers: "allow",
      viewport: { width: 1280, height: 900 },
    }, async ({ page, context }) => {
      const gateway = await installMockGateway(page, { sessionKey, historyMessages: [] });
      const protocol = await context.newCDPSession(page);
      let registrationId: string | undefined;
      protocol.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
        const registration = registrations.find((item) =>
          item.scopeURL === suite.server.baseUrl && !item.isDeleted,
        );
        if (registration) {
          registrationId = registration.registrationId;
        }
      });
      await protocol.send("ServiceWorker.enable");
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("sessions.messages.subscribe");
      await page.evaluate(async () => {
        await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        await navigator.serviceWorker.ready;
      });
      await expect.poll(() => registrationId).toBeTruthy();
      const profileId = await evaluateControlUiContext(page, (app) => {
        if (app.gateway.snapshot.selfUser === undefined) {
          throw new Error("Notification reader identity is unresolved");
        }
        return app.gateway.snapshot.selfUser?.id ?? null;
      });
      const completion = {
        version: 1, agentId: "main", sessionKey, runId: "proof-run",
        messageId: "key:proof-final", profileId,
      };
      const deliver = async (tag: string, changes: Record<string, unknown> = {}) => {
        const displayed = page.evaluate(() => new Promise<void>((resolve) => {
          const listener = (event: MessageEvent) => {
            if (event.data?.type === "openclaw-completion-delivered") {
              navigator.serviceWorker.removeEventListener("message", listener);
              resolve();
            }
          };
          navigator.serviceWorker.addEventListener("message", listener);
        }));
        await Promise.all([displayed, protocol.send("ServiceWorker.deliverPushMessage", {
          origin: new URL(suite.server.baseUrl).origin,
          registrationId: registrationId!,
          data: JSON.stringify({
            title: "OpenClaw proof", body: "Completion", tag,
            url: controlUiSessionUrl(suite.server.baseUrl, sessionKey),
            completion: { ...completion, ...changes },
          }),
        })]);
      };
      try {
        await deliver("unread");
        await deliver("newer", { messageId: "key:unseen-final" });
        await deliver("other", { sessionKey: "agent:main:another" });
        await expect.poll(() => tags(page)).toEqual(["newer", "other", "unread"]);

        // Ordinary route opening alone did not consume a message absent from history.
        await gateway.setMethodResponse("chat.history", { messages: [message] });
        await page.reload();
        await page.locator(".chat-thread").getByText(answer, { exact: true }).waitFor();
        await expect.poll(() => tags(page)).toEqual(["newer", "other"]);

        // Same visibility event boundary used by the existing worker-update E2E.
        // Emulate foreground lifecycle, not Notification or IntersectionObserver.
        await page.evaluate(() => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true, get: () => "hidden",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await deliver("while-hidden");
        await expect.poll(() => tags(page)).toEqual(["newer", "other", "while-hidden"]);
        await page.evaluate(() => {
          delete (document as Partial<Document>).visibilityState;
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await expect.poll(() => tags(page)).toEqual(["newer", "other"]);

        // The answer is already viewed: the worker's after-display hint must reconcile it.
        await deliver("late");
        await expect.poll(() => tags(page)).toEqual(["newer", "other"]);
      } finally {
        await page.evaluate(async () => {
          for (const notification of await (await navigator.serviceWorker.ready).getNotifications()) {
            notification.close();
          }
        });
        await protocol.detach();
      }
    });
  });
});
