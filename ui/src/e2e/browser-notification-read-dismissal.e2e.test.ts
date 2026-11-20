import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { controlUiSessionUrl, installMockGateway, startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

let upgradeWorker = () => {};
// Exact released worker, not a reimplementation of its old notification behavior.
// v2026.11.5 = e13cf15ece9bbd969b7362927c315362c90c97ff, ui/public/sw.js.
const suite = createControlUiE2eSuite({
  name: "Browser completion read dismissal",
  startServer: async () => {
    const upstream = await startControlUiE2eServer();
    const legacy = await readFile(new URL("./fixtures/service-worker-v2026.11.5.txt", import.meta.url), "utf8");
    let upgraded = false;
    upgradeWorker = () => { upgraded = true; };
    const proxy = createServer((request, response) => {
      const url = new URL(request.url ?? "/", upstream.baseUrl);
      if (url.pathname === "/sw.js" && !upgraded) {
        response.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-store" });
        response.end(legacy);
        return;
      }
      void fetch(url).then(async (result) => {
        response.writeHead(result.status, Object.fromEntries(
          [...result.headers].filter(([name]) => !["content-encoding", "content-length", "transfer-encoding"].includes(name)),
        ));
        response.end(Buffer.from(await result.arrayBuffer()));
      }).catch((error: unknown) => { response.destroy(error instanceof Error ? error : undefined); });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        proxy.once("error", reject);
        proxy.listen(0, "127.0.0.1", resolve);
      });
      const address = proxy.address();
      if (!address || typeof address === "string") throw new Error("No upgrade proof port");
      return {
        baseUrl: `http://127.0.0.1:${address.port}/`,
        close: async () => {
          try {
            proxy.closeAllConnections();
            await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
          } finally { await upstream.close(); }
        },
      };
    } catch (error) {
      proxy.close();
      await upstream.close();
      throw error;
    }
  },
});
const sessionKey = "agent:main:notification-proof";
const answer = "The notification proof has finished.";
const message = {
  role: "assistant",
  stopReason: "stop",
  content: [{ type: "text", text: answer }],
  __openclaw: { id: "answer-row", runId: "proof-run", idempotencyKey: "proof-final" },
};
const tags = (page: Page) =>
  page.evaluate(async () =>
    (await (await navigator.serviceWorker.ready).getNotifications())
      .map((item) => item.tag)
      .toSorted(),
  );

// Real Chromium worker upgrade and notification APIs; CDP injects push payloads.
// Gateway transport and foreground transitions are fixtures, not live/device proof.
suite.define(() => {
  it("preserves released-worker alerts across upgrade and dismisses only viewed final identities", async () => {
    await suite.withPage(
      {
        permissions: ["notifications"],
        serviceWorkers: "allow",
        viewport: { width: 1280, height: 900 },
      },
      async ({ page, context }) => {
        const gateway = await installMockGateway(page, { sessionKey, historyMessages: [] });
        const protocol = await context.newCDPSession(page);
        let registrationId: string | undefined;
        protocol.on("ServiceWorker.workerRegistrationUpdated", ({ registrations }) => {
          const registration = registrations.find(
            (item) => item.scopeURL === suite.server.baseUrl && !item.isDeleted,
          );
          if (registration) {
            registrationId = registration.registrationId;
          }
        });
        await protocol.send("ServiceWorker.enable");
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await gateway.waitForRequest("sessions.messages.subscribe");
        await page.evaluate(async () => {
          await navigator.serviceWorker.register("/sw.js?v=upgrade-legacy", { scope: "/" });
          await navigator.serviceWorker.ready;
        });
        await expect.poll(() => registrationId).toBeTruthy();
        await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.endsWith("v=upgrade-legacy"));
        await protocol.send("ServiceWorker.deliverPushMessage", {
          origin: new URL(suite.server.baseUrl).origin,
          registrationId: registrationId!,
          data: JSON.stringify({ title: "Legacy alert", body: "Retained before upgrade", tag: "legacy", url: controlUiSessionUrl(suite.server.baseUrl, sessionKey) }),
        });
        await expect.poll(() => tags(page)).toEqual(["legacy"]);
        // Same registration and storage; no unregister, notification clearing or new context.
        const previousRegistration = registrationId;
        upgradeWorker();
        await page.evaluate(async () => {
          await navigator.serviceWorker.register("/sw.js?v=upgrade-candidate", { scope: "/" });
        });
        await page.waitForFunction(() => navigator.serviceWorker.controller?.state === "activated" &&
          navigator.serviceWorker.controller.scriptURL.endsWith("v=upgrade-candidate"));
        expect(registrationId).toBe(previousRegistration);
        expect(await page.evaluate(async () => {
          const [notification] = await (await navigator.serviceWorker.ready).getNotifications();
          return { tag: notification.tag, title: notification.title, body: notification.body, data: notification.data };
        })).toEqual({
          tag: "legacy", title: "Legacy alert", body: "Retained before upgrade",
          data: { url: controlUiSessionUrl(suite.server.baseUrl, sessionKey), explicitUrl: true },
        });
        const profileId = await evaluateControlUiContext(page, (app) => {
          if (app.gateway.snapshot.selfUser === undefined) {
            throw new Error("Notification reader identity is unresolved");
          }
          return app.gateway.snapshot.selfUser?.id ?? null;
        });
        const completion = {
          version: 1,
          agentId: "main",
          sessionKey,
          runId: "proof-run",
          messageId: "key:proof-final",
          profileId,
        };
        const deliver = async (tag: string, changes: Record<string, unknown> = {}) => {
          const displayed = page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                const listener = (event: MessageEvent) => {
                  if (event.data?.type === "openclaw-completion-delivered") {
                    navigator.serviceWorker.removeEventListener("message", listener);
                    resolve();
                  }
                };
                navigator.serviceWorker.addEventListener("message", listener);
              }),
          );
          await Promise.all([
            displayed,
            protocol.send("ServiceWorker.deliverPushMessage", {
              origin: new URL(suite.server.baseUrl).origin,
              registrationId: registrationId!,
              data: JSON.stringify({
                title: "OpenClaw proof",
                body: "Completion",
                tag,
                url: controlUiSessionUrl(suite.server.baseUrl, sessionKey),
                completion: { ...completion, ...changes },
              }),
            }),
          ]);
        };
        try {
          await deliver("unread");
          await deliver("newer", { messageId: "key:unseen-final" });
          await deliver("other", { sessionKey: "agent:main:another" });
          await expect.poll(() => tags(page)).toEqual(["legacy", "newer", "other", "unread"]);

          // Ordinary route opening alone did not consume a message absent from history.
          await gateway.setMethodResponse("chat.history", { messages: [message] });
          await page.reload();
          await page.locator(".chat-thread").getByText(answer, { exact: true }).waitFor();
          await expect.poll(() => tags(page)).toEqual(["legacy", "newer", "other"]);

          // Same visibility event boundary used by the existing worker-update E2E.
          // Emulate foreground lifecycle, not Notification or IntersectionObserver.
          await page.evaluate(() => {
            Object.defineProperty(document, "visibilityState", {
              configurable: true,
              get: () => "hidden",
            });
            document.dispatchEvent(new Event("visibilitychange"));
          });
          await deliver("while-hidden");
          await expect.poll(() => tags(page)).toEqual(["legacy", "newer", "other", "while-hidden"]);
          await page.evaluate(() => {
            delete (document as Partial<Document>).visibilityState;
            document.dispatchEvent(new Event("visibilitychange"));
          });
          await expect.poll(() => tags(page)).toEqual(["legacy", "newer", "other"]);

          // The answer is already viewed: the worker's after-display hint must reconcile it.
          await deliver("late");
          await expect.poll(() => tags(page)).toEqual(["legacy", "newer", "other"]);
        } finally {
          await page.evaluate(async () => {
            for (const notification of await (
              await navigator.serviceWorker.ready
            ).getNotifications()) {
              notification.close();
            }
          });
          await protocol.detach();
        }
      },
    );
  });
});
