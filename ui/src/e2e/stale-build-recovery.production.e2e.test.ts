import { copyFileSync } from "node:fs";
import { cp, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, inject, it } from "vitest";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { createOpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { normalizeControlUiBuildInfo } from "../build-info-normalizers.ts";
import {
  buildProductionControlUiE2e,
  refreshProductionControlUiE2e,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

let obsoleteRoot: string;
let currentRoot: string;
const suite = createControlUiE2eSuite({
  name: "Control UI stale-build recovery E2E",
  startServerBeforeBrowser: true,
  async startServer() {
    const prebuilt = inject("controlUiE2ePrebuiltAssets");
    const currentBuild = prebuilt?.root ?? inject("controlUiE2eBuildRoot");
    const gateway = await createOpenClawTestInstance({
      name: "protocol-mismatch-recovery",
      // The producer owns these public runtime bytes; never trigger private-QA preparation.
      ...(prebuilt ? { entrypoint: ["dist/index.js"] } : {}),
    });
    try {
      obsoleteRoot = gateway.state.path("obsolete-ui");
      currentRoot = gateway.state.path("current-ui");
      await gateway.entrypoint();
      const { buildId } =
        prebuilt?.buildInfo ??
        normalizeControlUiBuildInfo(
          JSON.parse(await readFile(path.join(process.cwd(), "dist", "build-info.json"), "utf8")),
        );
      if (currentBuild) {
        await cp(currentBuild, currentRoot, { recursive: true });
        await refreshProductionControlUiE2e(currentRoot, buildId);
      } else {
        await buildProductionControlUiE2e(currentRoot, buildId);
      }
      await buildProductionControlUiE2e(obsoleteRoot, "obsolete-protocol-build", {
        protocolVersion: PROTOCOL_VERSION + 1,
      });
      // Both deployments keep their hashed assets; only the served document changes.
      await cp(path.join(currentRoot, "assets"), path.join(obsoleteRoot, "assets"), {
        recursive: true,
      });
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await gateway.state.writeConfig({
        plugins: { enabled: false },
        agents: { defaults: { model: { primary: "openai/gpt-4.1" } } },
        gateway: {
          port: gateway.port,
          auth: { mode: "none" },
          controlUi: { enabled: true, root: obsoleteRoot, allowedOrigins: [baseUrl] },
        },
      });
      await gateway.startGateway();
      return { baseUrl, close: () => gateway.cleanup() };
    } catch (error) {
      return await runQaGatewayFixture(
        async (): Promise<never> => {
          throw error;
        },
        () => gateway.cleanup(),
      );
    }
  },
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

suite.define(() => {
  it("reloads an incompatible production bundle from a real Gateway and connects", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const documents: string[] = [];
      const connects: Array<{ minProtocol: number; maxProtocol: number }> = [];
      const outcomes: Array<{ ok: boolean; error?: { details?: unknown } }> = [];
      page.on("request", (request) => {
        if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
          documents.push(request.url());
        }
      });
      await page.routeWebSocket(`${suite.server.baseUrl.replace("http:", "ws:")}/**`, (socket) => {
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
      await page.goto(`${suite.server.baseUrl}/new`);
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
  });
});
