import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

let upgradeWorker = () => {};
// Exact released worker, not a reimplementation of its old notification behavior.
// v2026.11.5 = e13cf15ece9bbd969b7362927c315362c90c97ff, ui/public/sw.js.
const suite = createControlUiE2eSuite({
  name: "Browser completion read dismissal",
  startServer: async () => {
    const upstream = await startControlUiE2eServer();
    const legacy = await readFile(
      new URL("./fixtures/service-worker-v2026.11.5.txt", import.meta.url),
      "utf8",
    );
    let upgraded = false;
    upgradeWorker = () => {
      upgraded = true;
    };
    const proxy = createServer((request, response) => {
      const url = new URL(request.url ?? "/", upstream.baseUrl);
      if (url.pathname === "/sw.js" && !upgraded) {
        response.writeHead(200, {
          "Content-Type": "application/javascript",
          "Cache-Control": "no-store",
        });
        response.end(legacy);
        return;
      }
      void fetch(url, { signal: AbortSignal.timeout(10_000) })
        .then(async (result) => {
          response.writeHead(
            result.status,
            Object.fromEntries(
              [...result.headers].filter(
                ([name]) =>
                  !["content-encoding", "content-length", "transfer-encoding"].includes(name),
              ),
            ),
          );
          response.end(Buffer.from(await result.arrayBuffer()));
        })
        .catch((error: unknown) => {
          console.error("[upgrade-proof] proxy request failed", url.pathname, error);
          response.destroy(error instanceof Error ? error : undefined);
        });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        proxy.once("error", reject);
        proxy.listen(0, "127.0.0.1", resolve);
      });
      const address = proxy.address();
      if (!address || typeof address === "string") {
        throw new Error("No upgrade proof port");
      }
      return {
        baseUrl: `http://127.0.0.1:${address.port}/`,
        close: async () => {
          try {
            proxy.closeAllConnections();
            await phase(
              "proxy close",
              () =>
                new Promise<void>((resolve, reject) => {
                  proxy.close((error) => (error ? reject(error) : resolve()));
                }),
              5_000,
            );
          } finally {
            await phase("upstream close", () => upstream.close(), 5_000);
          }
        },
      };
    } catch (error) {
      proxy.close();
      await upstream.close();
      throw error;
    }
  },
});
async function phase<T>(name: string, action: () => Promise<T>, timeoutMs = 20_000): Promise<T> {
  console.info("[upgrade-proof] start", name);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      action(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Upgrade phase timed out: ${name}`)), timeoutMs);
      }),
    ]);
    console.info("[upgrade-proof] passed", name);
    return result;
  } catch (error) {
    console.error("[upgrade-proof] failed", name, error);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

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
        await phase("navigate", () =>
          page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey)),
        );
        await phase("gateway subscription", () =>
          gateway.waitForRequest("sessions.messages.subscribe"),
        );
        await phase("legacy registration", () =>
          page.evaluate(async () => {
            await navigator.serviceWorker.register("/sw.js?v=upgrade-legacy", { scope: "/" });
            await navigator.serviceWorker.ready;
          }),
        );
        await expect.poll(() => registrationId).toBeTruthy();
        await page.waitForFunction(() =>
          navigator.serviceWorker.controller?.scriptURL.endsWith("v=upgrade-legacy"),
        );
        await protocol.send("ServiceWorker.deliverPushMessage", {
          origin: new URL(suite.server.baseUrl).origin,
          registrationId: registrationId!,
          data: JSON.stringify({
            title: "Legacy alert",
            body: "Retained before upgrade",
            tag: "legacy",
            url: controlUiSessionUrl(suite.server.baseUrl, sessionKey),
          }),
        });
        await expect.poll(() => tags(page)).toEqual(["legacy"]);
        // Same registration and storage; no unregister, notification clearing or new context.
        const previousRegistration = registrationId;
        upgradeWorker();
        await phase("candidate registration", () =>
          page.evaluate(async () => {
            await navigator.serviceWorker.register("/sw.js?v=upgrade-candidate", { scope: "/" });
          }),
        );
        // Running build identity, not a registration URL, owns upgrade completion.
        const candidateScript = await (
          await phase("candidate script", () =>
            page.request.get(new URL("/sw.js", suite.server.baseUrl).href, { timeout: 10_000 }),
          )
        ).text();
        const candidateBuild = candidateScript.match(
          /const EMBEDDED_CACHE_VERSION = "([^"]+)"/,
        )?.[1];
        expect(candidateBuild).toBeTruthy();
        expect(candidateBuild).not.toBe("__OPENCLAW_CONTROL_UI_BUILD_ID__");
        try {
          console.info("[upgrade-proof] start candidate activation");
          await page.waitForFunction(async (buildId) => {
            const registration = await navigator.serviceWorker.getRegistration();
            const worker = registration?.active;
            if (
              !worker ||
              worker.state !== "activated" ||
              registration.installing ||
              navigator.serviceWorker.controller !== worker
            ) {
              return false;
            }
            const channel = new MessageChannel();
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
              const result = await new Promise<{ type?: string; version?: string } | null>(
                (resolve) => {
                  timeout = setTimeout(() => resolve(null), 1_000);
                  channel.port1.addEventListener("message", (event) => resolve(event.data), {
                    once: true,
                  });
                  channel.port1.start();
                  worker.postMessage({ type: "sw-version-probe" }, [channel.port2]);
                },
              );
              return (
                registration.active === worker &&
                navigator.serviceWorker.controller === worker &&
                !registration.installing &&
                result?.type === "sw-updated" &&
                result.version === buildId
              );
            } finally {
              clearTimeout(timeout);
              channel.port1.close();
              channel.port2.close();
            }
          }, candidateBuild);
          console.info("[upgrade-proof] passed candidate activation");
        } catch (error) {
          console.error(
            "Upgrade worker state",
            await phase(
              "activation diagnostics",
              () =>
                page.evaluate(async () => {
                  const registration = await navigator.serviceWorker.getRegistration();
                  const describe = (worker: ServiceWorker | null | undefined) =>
                    worker ? { url: worker.scriptURL, state: worker.state } : null;
                  return {
                    controller: describe(navigator.serviceWorker.controller),
                    active: describe(registration?.active),
                    installing: describe(registration?.installing),
                    waiting: describe(registration?.waiting),
                  };
                }),
              5_000,
            ),
          );
          throw error;
        }
        expect(registrationId).toBe(previousRegistration);
        expect(
          await phase("retained legacy notification", () =>
            page.evaluate(async () => {
              const [notification] = await (await navigator.serviceWorker.ready).getNotifications();
              return {
                tag: notification.tag,
                title: notification.title,
                body: notification.body,
                data: notification.data,
              };
            }),
          ),
        ).toEqual({
          tag: "legacy",
          title: "Legacy alert",
          body: "Retained before upgrade",
          data: { url: controlUiSessionUrl(suite.server.baseUrl, sessionKey), explicitUrl: true },
        });
        console.info("[upgrade-proof] passed retained legacy notification");
        const profileId = await phase("reader identity", () =>
          evaluateControlUiContext(page, (app) => {
            if (app.gateway.snapshot.selfUser === undefined) {
              throw new Error("Notification reader identity is unresolved");
            }
            return app.gateway.snapshot.selfUser?.id ?? null;
          }),
        );
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
              new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                  navigator.serviceWorker.removeEventListener("message", listener);
                  reject(new Error("No worker after-display hint within 10 seconds"));
                }, 10_000);
                const listener = (event: MessageEvent) => {
                  if (event.data?.type === "openclaw-completion-delivered") {
                    clearTimeout(timer);
                    navigator.serviceWorker.removeEventListener("message", listener);
                    resolve();
                  }
                };
                navigator.serviceWorker.addEventListener("message", listener);
              }),
          );
          await phase(`delivery hint: ${tag}`, () =>
            Promise.all([
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
            ]),
          );
        };
        try {
          await deliver("unread");
          await deliver("newer", { messageId: "key:unseen-final" });
          await deliver("other", { sessionKey: "agent:main:another" });
          await expect.poll(() => tags(page)).toEqual(["legacy", "newer", "other", "unread"]);

          // Ordinary route opening alone did not consume a message absent from history.
          await gateway.setMethodResponse("chat.history", { messages: [message] });
          await phase("reload history", () => page.reload());
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
          try {
            await phase(
              "notification cleanup",
              () =>
                page.evaluate(async () => {
                  const registration = await navigator.serviceWorker.getRegistration();
                  for (const notification of (await registration?.getNotifications()) ?? []) {
                    notification.close();
                  }
                }),
              5_000,
            );
          } finally {
            await phase("protocol detach", () => protocol.detach(), 5_000);
          }
        }
      },
    );
  });
});
