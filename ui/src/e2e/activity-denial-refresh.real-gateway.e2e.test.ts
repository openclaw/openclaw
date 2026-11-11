import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ViteDevServer } from "vite";
import { expect, it } from "vitest";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import {
  acquireGatewayE2ePortBlock,
  startClaimedGateway,
} from "../../../src/gateway/test-helpers.listener.ts";
import {
  setDisplayName,
  setUserProfileRole,
} from "../../../src/state/user-profile-writes.worker.ts";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { activityPersonLocation } from "../app-route-paths.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { deviceGatewayEnv } from "./device-gateway-env.test-support.ts";
import { createGatewayProxy, gatewayProxyRoute } from "./gateway-proxy.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Activity denial real Gateway",
  startServerBeforeBrowser: true,
});
const scopes = ["operator.sessions.read", "operator.sessions.write"];

suite.define(() => {
  it("keeps a real guest timeline denial stable across unrelated session mutations", async (test) => {
    let cleanupState: (() => Promise<void>) | undefined;
    let gateway: GatewayServer | undefined;
    let proxy: ViteDevServer | undefined;
    await suite.runScenario(test, {
      async run() {
        const state = await createOpenClawTestState({
          label: "activity-denial",
          layout: "home",
          env: {
            ...deviceGatewayEnv,
            OPENCLAW_GATEWAY_PASSWORD: undefined,
            OPENCLAW_GATEWAY_TOKEN: undefined,
          },
        });
        cleanupState = state.cleanup;
        const email = "activity-guest@example.test";
        const guest = ensureProfileForEmail(email);
        const other = ensureProfileForEmail("activity-other@example.test");
        setUserProfileRole(guest.id, "guest");
        setDisplayName(guest.id, "Activity Reader");
        setDisplayName(other.id, "Other Person");
        const trustedProxy = {
          allowLoopback: true,
          allowUsers: [email],
          deviceAutoApprove: { enabled: true, scopes },
          requiredHeaders: ["x-forwarded-proto"],
          userHeader: "x-forwarded-user",
        };
        const claim = await acquireGatewayE2ePortBlock();
        const port = claim.port;
        gateway = await startClaimedGateway(claim, async () => {
          await state.writeConfig({
            agents: {
              ownership: "explicit",
              defaults: { workspace: state.workspaceDir },
              entries: { main: {} },
            },
            gateway: {
              port,
              auth: { mode: "trusted-proxy", trustedProxy },
              trustedProxies: ["127.0.0.1", "::1"],
              controlUi: { enabled: false, allowedOrigins: [new URL(suite.server.baseUrl).origin] },
              roles: {
                default: "guest",
                definitions: { guest: { agents: ["main"], sessions: { others: "view" }, scopes } },
              },
            },
          });
          const { startGatewayServer } = await import("../../../src/gateway/server.js");
          return await startGatewayServer(port, {
            auth: { mode: "trusted-proxy", trustedProxy },
            bind: "loopback",
            controlUiEnabled: false,
            sidecarStartup: "defer",
          });
        });
        const route = gatewayProxyRoute(port, email);
        proxy = await createGatewayProxy(state.workspaceDir, {
          "/": { ...route, headers: { ...route.headers, "x-openclaw-scopes": scopes.join(",") } },
        });
        await proxy.listen();
        const gatewayUrl = new URL(proxy.resolvedUrls!.local[0]!);
        gatewayUrl.protocol = "ws:";
        await suite.withPage(
          {
            viewport: { width: 1280, height: 900 },
            locale: "en-US",
            colorScheme: "dark",
            reducedMotion: "reduce",
          },
          async ({ page }) => {
            const requests: string[] = [];
            const changed: unknown[] = [];
            page.on("websocket", (socket) => {
              socket.on("framesent", (frame) => {
                const message = JSON.parse(frame.payload.toString());
                if (
                  message.type === "req" &&
                  message.method === "sessions.list" &&
                  message.params?.source === "activity"
                ) {
                  requests.push(message.id);
                }
              });
              socket.on("framereceived", (frame) => {
                const message = JSON.parse(frame.payload.toString());
                if (message.type === "event" && message.event === "sessions.changed") {
                  changed.push(message.payload);
                }
              });
            });
            const url = new URL(
              activityPersonLocation(other.id, "", "Other Person", 32).href,
              suite.server.baseUrl,
            );
            url.hash = new URLSearchParams({ gatewayUrl: gatewayUrl.href }).toString();
            await page.goto(url.href);
            await page
              .locator("openclaw-gateway-url-confirmation")
              .getByRole("button", { name: "Switch to " + gatewayUrl.host, exact: true })
              .click();
            await waitForControlUiGatewayReady(page);
            const alert = page.locator(".activity-feed__feedback [role=alert]");
            await alert.waitFor();
            const denial = await alert.textContent();
            expect(denial).toContain("Other people's activity is private.");
            const initial = requests.length;
            await page.clock.install();
            await pauseVirtualClock(page);
            await evaluateControlUiContext(page, async (app) => {
              await app.gateway.snapshot.client!.request("sessions.create", {
                key: "agent:main:unrelated",
                label: "Unrelated task",
              });
            });
            await expect.poll(() => changed.length).toBeGreaterThan(0);
            await page.clock.runFor(6000);
            const facts = {
              initial,
              requests: requests.length,
              skeleton: await page.locator(".activity-feed__loading").count(),
              alert: await alert.count(),
              changes: changed.length,
            };
            await page.clock.resume();
            if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
              const frame = await takeControlUiScreenshotFrame(
                page,
                page.locator(".activity-feed"),
                [page.locator(".activity-feed__search")],
                { animations: "disabled" },
              );
              await writeFile(path.join(suite.artifactDir, "real-denial.png"), frame.png);
              await writeFile(
                path.join(suite.artifactDir, "real-facts.json"),
                JSON.stringify(facts, null, 2),
              );
              console.log("Real Activity evidence", suite.artifactDir, facts);
            }
            expect(facts).toMatchObject({ initial, requests: initial, skeleton: 0, alert: 1 });
            await page
              .locator(".activity-feed__feedback")
              .getByRole("button", { name: "Retry", exact: true })
              .click();
            await expect.poll(() => requests.length).toBe(initial + 1);
            await alert.waitFor();
            expect(await alert.textContent()).toBe(denial);
          },
        );
      },
      close: () =>
        runQaGatewayFixture(
          async () => {},
          () => proxy?.close(),
          () => gateway?.close({ reason: "Activity proof cleanup" }),
        ),
      release: async () => cleanupState?.(),
    });
  });
});
