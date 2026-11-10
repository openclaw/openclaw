import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Gateway connect denial" });

suite.define(() => {
  it.each(["denied", "unavailable"])(
    "paces %s handshakes at a reachable Gateway",
    async (failure) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        await page.clock.install();
        await pauseVirtualClock(page);
        await page.addInitScript(() => {
          const fetch = window.fetch.bind(window);
          window.fetch = (input, init) => {
            const url = new URL(
              input instanceof Request ? input.url : String(input),
              location.href,
            );
            // Keep continuously live health out of real HTTP while retries use the virtual clock.
            return url.origin === location.origin && url.pathname === "/healthz"
              ? Promise.resolve(Response.json({ ok: true, status: "live" }))
              : fetch(input, init);
          };
        });
        const denied = failure === "denied";
        const gateway = await installMockGateway(page, {
          methodResponses: {
            connect: {
              __mockError: denied
                ? {
                    code: "FORBIDDEN",
                    message: "access denied",
                    details: { code: "OPERATOR_ACCESS_DENIED" },
                  }
                : { code: "UNAVAILABLE", message: "temporarily unavailable", retryable: true },
            },
          },
        });
        await page.goto(suite.server.baseUrl);
        const gate = page.locator(".login-gate");
        const recovery = denied ? gate : page.locator(".gateway-connection-view");
        // Request receipt precedes the queued response and recovery-surface rendering.
        await expect
          .poll(async () => {
            await page.clock.runFor(1);
            return {
              attempts: (await gateway.getRequests("connect")).length,
              visible: await recovery.isVisible(),
            };
          })
          .toEqual({ attempts: 1, visible: true });
        const initialAttempts = (await gateway.getRequests("connect")).length;
        for (let second = 0; second < 60; second++) {
          const attemptsBeforeTick = (await gateway.getRequests("connect")).length;
          await page.clock.runFor(1_000);
          // WebCrypto and fetch use real threads; settle the handshake before advancing again.
          await expect
            .poll(async () => {
              const handshake = await page.evaluate((previousAttempts) => {
                const mockGateway = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
                const sockets = mockGateway.socketStates();
                const requests = mockGateway.requests.filter(
                  (request) => request.method === "connect",
                ).length;
                return {
                  preparing:
                    requests === previousAttempts &&
                    sockets.some((socket) => socket.readyState === WebSocket.OPEN),
                  settled: sockets.every((socket) => socket.readyState === WebSocket.CLOSED),
                };
              }, attemptsBeforeTick);
              // Closed attempts may never send; only pump an unsettled handshake after signing.
              if (!handshake.preparing && !handshake.settled) {
                await page.clock.runFor(1);
              }
              return handshake.settled;
            })
            .toBe(true);
        }
        if (denied) {
          await gate.getByText("No access to this Gateway", { exact: true }).waitFor();
          const frame = await takeControlUiScreenshotFrame(
            page,
            gate,
            [gate.locator(".login-gate__failure")],
            {
              animations: "disabled",
            },
          );
          await writeFile(path.join(suite.artifactDir, "access-denied.png"), frame.png);
          expect(await gateway.getRequests("connect")).toHaveLength(initialAttempts);
          expect(await gate.getByRole("button", { name: "Connect", exact: true }).isEnabled()).toBe(
            true,
          );
          // Returning to the tab or regaining network connectivity is not new authorization.
          await page.evaluate(() => {
            window.dispatchEvent(new Event("online"));
            window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
          });
          await page.clock.runFor(30_000);
          expect(await gateway.getRequests("connect")).toHaveLength(initialAttempts);
        } else {
          const attempts = (await gateway.getRequests("connect")).length;
          expect(attempts).toBeGreaterThan(3);
          expect(attempts).toBeLessThanOrEqual(12);
        }
        await gateway.setMethodResponse("connect", { sequence: [] });
        if (denied) {
          await gate.getByRole("button", { name: "Connect", exact: true }).click();
        }
        await page.clock.runFor(15_000);
        await page.clock.resume();
        await waitForControlUiGatewayReady(page);
        await gate.waitFor({ state: "detached" });
      });
    },
  );
});
