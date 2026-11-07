import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished } from "vitest";
import { buildMockOpenAiResponsesProvider } from "../../../src/gateway/test-openai-responses-model.ts";
import { writeGatewayRestartIntentSync } from "../../../src/infra/restart-intent.ts";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.ts";
import { startGatewayRestartProvider } from "../../../test/helpers/gateway-restart-provider.ts";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { assertServedUi } from "./chat-lifecycle.test-support.ts";
import { connectChatGateway } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { startDisposableGatewayIngress } from "./gateway-fresh-visit-ingress.test-support.ts";

const controller = new AbortController();
let provider: Awaited<ReturnType<typeof startGatewayRestartProvider>>;
let instance: OpenClawTestInstance;
let client: Awaited<ReturnType<typeof connectChatGateway>>;
const suite = createControlUiE2eSuite({
  name: "Fresh visits during real Gateway maintenance",
  startServerBeforeBrowser: true,
  resources: {
    async run(signal) {
      client = await connectChatGateway(instance, signal);
    },
    async close() {
      await client?.stopAndWait();
    },
  },
  async startServer() {
    provider = await startGatewayRestartProvider(controller.signal, { held: 1, execs: 0 });
    const model = buildMockOpenAiResponsesProvider(provider.baseUrl, "fixture-model");
    const modelRef = "openai/fixture-model";
    instance = await createOpenClawTestInstance({
      reserveIdlePort: false,
      name: "fresh-visit-restart",
      entrypoint: ["dist/index.js"],
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        VITEST: undefined,
        NODE_ENV: undefined,
        NODE_OPTIONS: undefined,
        OPENCLAW_SKIP_PROVIDERS: undefined,
        OPENCLAW_SKIP_CRON: undefined,
        OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENAI_API_KEY: "synthetic-maintenance-fixture",
      },
      config: {
        gateway: { controlUi: { enabled: true } },
        cron: { enabled: false },
        update: { checkOnStart: false },
        browser: { enabled: false },
        discovery: { mdns: { mode: "off" } },
        agents: {
          defaults: {
            model: { primary: modelRef },
            models: {
              [modelRef]: {
                agentRuntime: { id: "openclaw" },
                params: { transport: "sse", openaiWsWarmup: false },
              },
            },
          },
        },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            openai: {
              ...model.config,
              agentRuntime: { id: "openclaw" },
              request: { allowPrivateNetwork: true },
            },
          },
        },
        plugins: {
          enabled: true,
          entries: {
            browser: { enabled: false },
            "memory-core": { config: { dreaming: { enabled: false } } },
          },
        },
        tools: { codeMode: false, exec: { host: "gateway", security: "full", ask: "off" } },
      },
    });
    instance.env.OPENCLAW_NO_RESPAWN = "1";
    for (const key of ["INVOCATION_ID", "SYSTEMD_EXEC_PID", "OPENCLAW_SUPERVISOR_MODE"]) {
      delete instance.env[key];
    }
    ensureGatewayOwnerProfile("Synthetic maintainer", { env: instance.env });
    const close = async () => {
      provider.releaseRecovery();
      try {
        await instance.cleanup();
      } finally {
        controller.abort();
        await provider.close();
      }
    };
    try {
      await instance.startGateway();
      return { baseUrl: "http://127.0.0.1:" + instance.port + "/", close };
    } catch (error) {
      await close();
      throw error;
    }
  },
});

suite.define(() => {
  it("retains the open chat and draft across a real Gateway restart", async () => {
    let phase = "agent inference";
    onTestFinished(() => {
      if (phase !== "complete") {
        console.error(
          "Fresh-visit proof stopped at " + phase,
          instance
            .logs()
            .replaceAll(instance.gatewayToken, "[fixture-auth]")
            .replaceAll(instance.hookToken, "[fixture-hook]"),
        );
      }
    });
    await client.request("sessions.create", {
      agentId: "main",
      key: "agent:main:fresh-visit-proof",
      label: "Restart proof",
    });
    try {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
        async ({ page }) => {
          let connections = 0;
          page.on("websocket", () => connections++);
          await page.goto(
            suite.server.baseUrl + "new#token=" + encodeURIComponent(instance.gatewayToken),
          );
          await waitForControlUiGatewayReady(page);
          await page
            .locator("openclaw-app-sidebar")
            .getByRole("link", { name: /Restart proof/ })
            .click();
          const url = page.url();
          const shell = await page.locator("openclaw-app-shell").elementHandle();
          const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
          const draft = "Keep this draft across the real Gateway restart.";
          await composer.fill(draft);
          const connectionsBeforeRestart = connections;
          await client.request("chat.send", {
            sessionKey: "agent:main:fresh-visit-proof",
            message: "RESTART_HANDOFF_0: reply briefly after this local proof.",
            idempotencyKey: "fresh-visit-announced-restart",
          });
          await provider.ready;
          provider.beginRecovery();
          phase = "announced drain";
          const pid = instance.child?.pid;
          if (!pid) {
            throw new Error("The isolated Gateway has no running process");
          }
          if (
            !writeGatewayRestartIntentSync({
              env: instance.env,
              targetPid: pid,
              reason: "control-ui-restart-proof",
            })
          ) {
            throw new Error("The isolated Gateway did not accept its restart intent");
          }
          process.kill(pid, "SIGUSR2");
          await expect
            .poll(async () => {
              const response = await fetch(suite.server.baseUrl + "startupz");
              return asOptionalRecord(await response.json())?.status;
            })
            .toBe("draining");
          expect(await shell?.evaluate((element) => element.isConnected)).toBe(true);
          expect(await composer.inputValue()).toBe(draft);
          expect(page.url()).toBe(url);

          phase = "network reconnection";
          provider.releaseRecovery();
          await expect
            .poll(() => connections, { timeout: 45_000 })
            .toBeGreaterThan(connectionsBeforeRestart);
          await waitForControlUiGatewayReady(page);
          expect(await shell?.evaluate((element) => element.isConnected)).toBe(true);
          expect(await composer.inputValue()).toBe(draft);
          expect(page.url()).toBe(url);
          expect(instance.logs()).toContain("in-process restart");
          await assertServedUi(page, suite.server.baseUrl);
          await client.stopAndWait();
          client = await connectChatGateway(instance, controller.signal);
          phase = "complete";
        },
      );
    } finally {
      provider.beginRecovery();
      provider.releaseRecovery();
    }
  });
  it("gives a fresh browser a useful view while the real Gateway is paused", async () => {
    const prepared = asOptionalRecord(
      await client.request("gateway.suspend.prepare", {
        requestId: "fresh-visit-paused-maintenance",
        drain: true,
      }),
    );
    const suspensionId = prepared?.suspensionId;
    if (typeof suspensionId !== "string") {
      throw new Error("Suspension did not return its owned lease");
    }
    let resumeAttempted = false;
    try {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
        async ({ page }) => {
          const url = suite.server.baseUrl + "new?view=retained";
          await page.addInitScript(() => {
            addEventListener(
              "openclaw-control-ui-rendered",
              () => {
                document.documentElement.dataset.proofRendered = "yes";
              },
              { once: true },
            );
          });
          const response = await page.goto(
            url + "#token=" + encodeURIComponent(instance.gatewayToken),
            { waitUntil: "domcontentloaded" },
          );
          expect(response?.status()).toBe(200);
          await page.locator("openclaw-app-shell").waitFor({ state: "attached" });
          const shell = await page.locator("openclaw-app-shell").elementHandle();
          if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
            const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [], {
              animations: "disabled",
            });
            await writeFile(
              path.join(suite.artifactDir, "fresh-paused-maintenance-desktop.png"),
              frame.png,
            );
          }
          expect(await page.locator("#openclaw-maintenance").count()).toBe(0);
          await page.locator(".shell").waitFor({ state: "visible" });
          resumeAttempted = true;
          await client.request("gateway.suspend.resume", { suspensionId });
          await expect
            .poll(() => page.locator(".gateway-connection-view").count(), { timeout: 30_000 })
            .toBe(0);
          expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(
            "/new?view=retained",
          );
          await expect
            .poll(() => page.locator("html").getAttribute("data-proof-rendered"), {
              timeout: 30_000,
            })
            .toBe("yes");
          await waitForControlUiGatewayReady(page);
          await assertServedUi(page, suite.server.baseUrl);
          expect(await shell?.evaluate((element) => element.isConnected)).toBe(true);
        },
      );
    } finally {
      if (!resumeAttempted) {
        await client.request("gateway.suspend.resume", { suspensionId });
      }
    }
  });
  it("recovers a stopped listener only through a disposable ingress", async () => {
    const ingress = await startDisposableGatewayIngress(instance.port);
    try {
      await instance.stopGateway();
      // A proxied fetch is not a socket-liveness verdict. The fixture disables its idle listener;
      // binding and releasing this owned port proves no Gateway listener remains.
      const portProbe = createNetServer();
      const bound = once(portProbe, "listening");
      try {
        portProbe.listen(instance.port, "127.0.0.1");
        await bound;
      } finally {
        if (portProbe.listening) {
          const closed = once(portProbe, "close");
          portProbe.close();
          await closed;
        }
      }
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
        async ({ page }) => {
          await page.addInitScript(() => {
            addEventListener(
              "openclaw-control-ui-rendered",
              () => {
                document.documentElement.dataset.proofRendered = "yes";
              },
              { once: true },
            );
          });
          const url = ingress.baseUrl + "new?view=retained#draft";
          const response = await page.goto(url, { waitUntil: "domcontentloaded" });
          expect(response?.status(), JSON.stringify(ingress.diagnostics())).toBe(503);
          expect(response?.headers()["x-openclaw-proof-boundary"]).toBe("disposable-ingress");
          const title = page.getByRole("heading", {
            name: "OpenClaw is temporarily unavailable",
            exact: true,
          });
          expect(await title.isVisible()).toBe(true);
          if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
            const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [title], {
              animations: "disabled",
            });
            await writeFile(
              path.join(suite.artifactDir, "fresh-stopped-listener-ingress-desktop.png"),
              frame.png,
            );
          }
          await instance.startGateway();
          await expect
            .poll(() => page.locator("html").getAttribute("data-proof-rendered"), {
              timeout: 30_000,
            })
            .toBe("yes");
          expect(page.url()).toBe(url);
          await assertServedUi(page, ingress.baseUrl);
        },
      );
    } finally {
      await ingress.close();
    }
  });
});
