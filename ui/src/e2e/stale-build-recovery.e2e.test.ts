import { copyFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import path from "node:path";
import { expect, inject, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";
import { getFreePort } from "../../../src/test-utils/ports.js";
import { resolveRuntimeServiceBuildId } from "../../../src/version.js";
import {
  buildProductionControlUiE2e,
  installMockGateway,
  refreshProductionControlUiE2e,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { deviceGatewayEnv } from "./device-gateway.test-support.ts";
import { closeContext } from "./login-gate-e2e.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI stale-build recovery E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

suite.define(() => {
  it("cache-busts stale-build recovery on a first dashboard navigation", async () => {
    const context = await suite.browser.newContext({
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const documentRequests: Array<{ fresh: boolean; pathname: string }> = [];
    const appOrigin = new URL(suite.server.baseUrl).origin;
    await page.route(`${appOrigin}/**`, async (route) => {
      const request = route.request();
      if (request.resourceType() === "document") {
        const url = new URL(request.url());
        documentRequests.push({
          fresh: url.searchParams.has("openclaw_mount_recovery"),
          pathname: url.pathname,
        });
      }
      await route.continue();
    });
    const gateway = await installMockGateway(page, {
      deferredMethods: ["connect"],
      sessionKey: "agent:example-agent:example-session",
    });
    const mismatch = {
      code: "UNAVAILABLE",
      message: "Control UI updated; reload this page to continue",
      details: {
        code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
        gatewayBuildId: "replacement-build",
        reloadRequired: true,
      },
      retryable: false,
    };
    const target = new URL("dashboard/example-agent/example-session", suite.server.baseUrl);

    try {
      await page.goto(target.href);
      await gateway.waitForRequest("connect");
      await gateway.rejectDeferred("connect", mismatch);

      await expect.poll(() => documentRequests.length).toBe(2);
      await gateway.waitForRequest("connect");
      expect(documentRequests).toEqual([
        { fresh: false, pathname: target.pathname },
        { fresh: true, pathname: target.pathname },
      ]);
      await gateway.resolveDeferred("connect");

      await page.locator("openclaw-app-shell").waitFor();
      expect(await page.locator("openclaw-login-gate").count()).toBe(0);
      await expect.poll(() => page.url()).toBe(target.href);
    } finally {
      await closeContext(context);
    }
  });

  it("reloads an incompatible production bundle from a real Gateway and connects", async (test) => {
    const currentBuild = inject("controlUiE2eBuildRoot");
    expect(currentBuild).toBeTruthy();
    const state = await createOpenClawTestState({
      label: "protocol-mismatch-recovery",
      layout: "home",
      env: deviceGatewayEnv,
    });
    let gateway: GatewayServer | undefined;
    await suite.runScenario(test, {
      retainedState: () => state.root,
      async run() {
        const obsoleteRoot = state.path("obsolete-ui");
        const currentRoot = state.path("current-ui");
        await buildProductionControlUiE2e(obsoleteRoot, "obsolete-protocol-build", {
          protocolVersion: PROTOCOL_VERSION + 1,
        });
        await cp(currentBuild!, currentRoot, { recursive: true });
        const buildId = resolveRuntimeServiceBuildId();
        if (buildId) {
          await refreshProductionControlUiE2e(currentRoot, buildId);
        }
        // Both deployments keep their hashed assets; only the served document changes.
        await cp(path.join(currentRoot, "assets"), path.join(obsoleteRoot, "assets"), {
          recursive: true,
        });
        const port = await getFreePort();
        const baseUrl = `http://127.0.0.1:${port}`;
        await state.writeConfig({
          plugins: { enabled: false },
          agents: { defaults: { model: { primary: "openai/gpt-4.1" } } },
          gateway: {
            port,
            auth: { mode: "none" },
            controlUi: { root: obsoleteRoot, allowedOrigins: [baseUrl] },
          },
        });
        state.applyEnv();
        const { startGatewayServer } = await import("../../../src/gateway/server.js");
        gateway = await startGatewayServer(port, {
          auth: { mode: "none" },
          bind: "loopback",
          controlUiEnabled: true,
          sidecarStartup: "defer",
        });
        await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
          const documents: string[] = [];
          const connects: Array<{ minProtocol: number; maxProtocol: number }> = [];
          const outcomes: Array<{ ok: boolean; error?: { details?: unknown } }> = [];
          page.on("request", (request) => {
            if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
              documents.push(request.url());
            }
          });
          await page.routeWebSocket(`ws://127.0.0.1:${port}/**`, (socket) => {
            const server = socket.connectToServer();
            const ids = new Set<string>();
            socket.onMessage((message) => {
              const frame = JSON.parse(String(message));
              if (frame.type === "req" && frame.method === "connect") {
                connects.push(frame.params);
                ids.add(frame.id);
              }
              server.send(message);
            });
            server.onMessage((message) => {
              const frame = JSON.parse(String(message));
              if (frame.type === "res" && ids.has(frame.id)) {
                outcomes.push(frame);
                if (!frame.ok) {
                  // Publish the complete current document before forwarding the real rejection.
                  // The custom asset root revalidates files rather than caching bundled bytes.
                  copyFileSync(
                    path.join(currentRoot, "index.html"),
                    path.join(obsoleteRoot, "index.html"),
                  );
                }
              }
              socket.send(message);
            });
          });
          await page.goto(`${baseUrl}/new`);
          await expect.poll(() => outcomes.map(({ ok }) => ok)).toEqual([false, true]);
          await page.locator("openclaw-app-shell").waitFor();
          expect(connects).toMatchObject([
            { minProtocol: PROTOCOL_VERSION + 1, maxProtocol: PROTOCOL_VERSION + 1 },
            { minProtocol: PROTOCOL_VERSION, maxProtocol: PROTOCOL_VERSION },
          ]);
          expect(outcomes[0]?.error?.details).toMatchObject({
            code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            reloadRequired: true,
          });
          expect(documents).toHaveLength(2);
          expect(new URL(documents[1]!).searchParams.has("openclaw_mount_recovery")).toBe(true);
          expect(await page.locator("openclaw-login-gate").count()).toBe(0);
        });
      },
      close: async () => {
        await gateway?.close({ reason: "protocol recovery proof complete" });
      },
      release: () => state.cleanup(),
    });
  }, 180_000);
});
