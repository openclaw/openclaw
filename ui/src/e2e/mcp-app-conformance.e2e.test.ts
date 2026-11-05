// MCP Apps conformance uses the locked official ext-apps App implementation over real browser,
// Gateway WebSocket/HTTP, stdio MCP, and nested postMessage transports.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import path from "node:path";
import type { Frame, Page } from "playwright";
import { expect, it } from "vitest";
import {
  disposeAllSessionMcpRuntimes,
  setSessionMcpRuntimeScheduler,
} from "../../../src/agents/agent-bundle-mcp-manager-api.js";
import { getOrCreateSessionMcpRuntime } from "../../../src/agents/agent-bundle-mcp-manager.test-support.js";
import { materializeBundleMcpToolsForRun } from "../../../src/agents/agent-bundle-mcp-materialize.js";
import { getMcpAppModelContext } from "../../../src/agents/mcp-app-model-context.js";
import { getMcpAppViewLease } from "../../../src/agents/mcp-ui-resource.js";
import { readConfigFileSnapshotWithPluginMetadata } from "../../../src/config/config.js";
import { setRuntimeConfigSnapshot } from "../../../src/config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import { startGatewayServer } from "../../../src/gateway/server.js";
import { acquireGatewayE2ePortBlock } from "../../../src/gateway/test-helpers.listener.js";
import { createTestGatewayScheduler } from "../../../src/test-utils/gateway-scheduler-clock.js";
import * as testStateFixture from "../../../src/test-utils/openclaw-test-state.ts";
import type { TestPortClaim } from "../../../src/test-utils/port-claims.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { startControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import {
  appHtml,
  createMcpAppFixtureControl,
  createMcpAppTeardownRecorder,
  type McpAppFixtureEvent as FixtureEvent,
  observeMcpAppHttpResponses,
  observeMcpAppRequests,
  findAppFrame,
  mountControlUiHost,
  requestStandaloneUrl,
  readMcpAppModule,
  waitForText,
  waitForTextContaining,
  writeFixtureServer,
} from "../test-helpers/mcp-app-conformance-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { seedMcpAppConformanceSession } from "./mcp-app-conformance-session.test-support.ts";
import {
  assertMcpAppTimingEvents,
  waitForMcpAppTimingEvents,
} from "./mcp-app-timing.test-support.ts";

const authValue = "test";
const sessionKey = "agent:main:mcp-app-conformance";
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;

let state: testStateFixture.OpenClawTestState | undefined;
let gatewayStartup: ReturnType<typeof startGatewayServer> | undefined;
let runtimeStartup: ReturnType<typeof getOrCreateSessionMcpRuntime> | undefined;
let mcpScheduler: ReturnType<typeof createTestGatewayScheduler> | undefined;
let gatewayPort: number;
let sandboxPort: number;
// Each claim is held until the listener bound to its port has closed.
const portClaims: Partial<Record<"appAsset" | "gateway" | "sandbox", TestPortClaim>> = {};
let tempRoot: string;
let viewId: string;
let appAssetServer: HttpServer | undefined;
let runtime: Awaited<ReturnType<typeof getOrCreateSessionMcpRuntime>>;
let fixtureControlPath: string;
let fixtureEventsPath: string;
let fixtureHistoryUrl: string;
let fixture: ReturnType<typeof createMcpAppFixtureControl>;
let showFixture: (callId: string) => Promise<string>;

async function capture(page: Page, name: string) {
  if (captureUiProof) {
    await page.screenshot({ path: path.join(proofDir, name + ".png") });
  }
}
async function clickFor(app: Frame, button: string, output: string, text: string) {
  await app.locator("#" + button).click();
  await waitForTextContaining(app.locator("#" + output), text);
}
function viewLease() {
  const lease = getMcpAppViewLease(viewId, runtime);
  if (!lease) {
    throw new Error("MCP App conformance view expired");
  }
  return lease;
}

async function expectBridge(app: Frame, contextSupported: boolean) {
  await waitForText(app.locator("#input"), '{"city":"Paris"}');
  await waitForTextContaining(app.locator("#result"), "initial-result");
  for (const capability of ["serverTools", "serverResources"]) {
    await waitForTextContaining(app.locator("#capabilities"), capability);
  }
  await waitForTextContaining(app.locator("#capabilities"), "updateModelContext", contextSupported);
  await waitForText(app.locator("#ping"), "{}");
  await clickFor(app, "list-tools", "tools", "app_companion");
  await waitForTextContaining(app.locator("#tools"), "model_only", false);
  await waitForText(app.locator("#isolation"), "isolated");
}
async function expectAppTools(app: Frame) {
  await clickFor(app, "call-app", "app-tool", "companion-called");
  await clickFor(app, "call-model", "model-tool", "denied:");
  await clickFor(app, "read-resource", "resource", "resource-ok");
}
async function expectTheme(app: Frame, theme: "light" | "dark") {
  const [background, color, backgroundRgb, colorRgb] =
    theme === "dark"
      ? ["#161920", "#d4d4d8", "rgb(22, 25, 32)", "rgb(212, 212, 216)"]
      : ["#ffffff", "#403c35", "rgb(255, 255, 255)", "rgb(64, 60, 53)"];
  await waitForText(app.locator("#host-theme"), theme);
  // A light proxy between dark documents paints an opaque UA canvas.
  await expect
    .poll(() =>
      app.parentFrame()?.evaluate(() => getComputedStyle(document.documentElement).colorScheme),
    )
    .toBe(theme);
  await waitForTextContaining(
    app.locator("#host-variables"),
    `"--color-background-primary":"${background}"`,
  );
  await waitForTextContaining(app.locator("#host-variables"), `"--color-text-primary":"${color}"`);
  await waitForText(
    app.locator("#computed-theme"),
    JSON.stringify({
      background: backgroundRgb,
      color: colorRgb,
      accent: "rgb(255, 79, 79)",
    }),
  );
}

function mountHost(page: Page) {
  return mountControlUiHost(page, {
    baseUrl: suite.server.baseUrl,
    gatewayPort,
    authValue,
    sessionKey,
    viewId,
  });
}
function configureImmediate(scenario: string) {
  return fixture.configure({ scenario, callDelayMs: 0 });
}
function companionEvents(events: FixtureEvent[], event: string) {
  return events.filter((entry) => entry.event === event && entry.tool === "app_companion");
}
async function waitForFixtureEvent(scenario: string, event: string, timeout?: number) {
  await expect
    .poll(
      async () =>
        (await fixture.readEvents(scenario)).filter((entry) => entry.event === event).length,
      { timeout },
    )
    .toBe(1);
}

const failures: Array<{ step: string; error: string }> = [];
async function settleCleanup(step: string, cleanup: () => Promise<unknown>): Promise<boolean> {
  try {
    await cleanup();
    return true;
  } catch (error) {
    failures.push({ step, error: String(error) });
    return false;
  }
}

const suite = createControlUiE2eSuite({
  name: "MCP App Control UI and standalone host conformance",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  setupTimeoutMs: 120_000,
  teardownTimeoutMs: 120_000,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
  resources: {
    retainedState: () => state?.root,
    run: async (signal) => {
      // Both tests share retained reports even when screenshots and video are disabled.
      proofDir = createControlUiE2eArtifactDir("mcp-app-request-lifetime");
      signal.throwIfAborted();
      state = await testStateFixture.createOpenClawTestState({
        prefix: "openclaw-mcp-app-conformance-",
        applyEnv: false,
        env: {
          OPENCLAW_GATEWAY_TOKEN: authValue,
          OPENCLAW_SKIP_CHANNELS: "1",
          OPENCLAW_SKIP_CRON: "1",
          OPENCLAW_SKIP_PROVIDERS: "1",
          OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
        },
      });
      signal.throwIfAborted();
      tempRoot = state.root;
      const fixturePath = state.path("fixture-server.mjs");
      fixtureControlPath = state.path("fixture-control.json");
      fixtureEventsPath = state.path("fixture-events.jsonl");
      fixture = createMcpAppFixtureControl(fixtureControlPath, fixtureEventsPath);
      await configureImmediate("setup");
      await fs.writeFile(fixtureEventsPath, "");
      const bundledPluginsDir = state.path("empty-plugins");
      await fs.mkdir(bundledPluginsDir, { recursive: true });
      // The state owner already captured this key; its value needs the allocated root.
      state.envVars.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
      const appModuleSource = await readMcpAppModule();
      portClaims.appAsset = await acquireGatewayE2ePortBlock();
      const appAssetPort = portClaims.appAsset.port;
      signal.throwIfAborted();
      const fixtureAssetServer = createHttpServer((request, response) => {
        if (request.url === "/history-away") {
          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          response.end("<!doctype html><title>History control</title><p>History control</p>");
          return;
        }
        if (request.url !== "/app.js") {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
          "Content-Type": "text/javascript; charset=utf-8",
          "Cross-Origin-Resource-Policy": "cross-origin",
        });
        response.end(appModuleSource);
      });
      appAssetServer = fixtureAssetServer;
      await new Promise<void>((resolve, reject) => {
        fixtureAssetServer.once("error", reject);
        fixtureAssetServer.listen(appAssetPort, "127.0.0.1", () => {
          fixtureAssetServer.off("error", reject);
          resolve();
        });
      });
      signal.throwIfAborted();
      const appModuleUrl = `http://127.0.0.1:${appAssetPort}/app.js`;
      fixtureHistoryUrl = `http://127.0.0.1:${appAssetPort}/history-away`;
      const resourceOrigin = new URL(appModuleUrl).origin;
      const controlUiOrigin = new URL(suite.server.baseUrl).origin;
      await writeFixtureServer(
        fixturePath,
        appHtml(appModuleUrl),
        resourceOrigin,
        fixtureControlPath,
        fixtureEventsPath,
      );
      portClaims.gateway = await acquireGatewayE2ePortBlock();
      gatewayPort = portClaims.gateway.port;
      signal.throwIfAborted();
      // A held claim keeps the sandbox block distinct from the Gateway block.
      portClaims.sandbox = await acquireGatewayE2ePortBlock();
      sandboxPort = portClaims.sandbox.port;
      const cfg: OpenClawConfig = {
        gateway: {
          auth: { mode: "token", token: authValue },
          controlUi: { allowedOrigins: [controlUiOrigin] },
        },
        mcp: {
          apps: { enabled: true, sandboxPort },
          servers: {
            conformance: {
              command: process.execPath,
              args: [fixturePath],
              cwd: tempRoot,
              requestTimeoutMs: 10_000,
              // This keyless fixture proves transport lifetime, not interactive approval.
              codex: { defaultToolsApprovalMode: "approve" },
            },
          },
        },
      };
      await state.writeConfig(cfg);
      signal.throwIfAborted();
      state.applyEnv();
      setRuntimeConfigSnapshot(cfg);
      mcpScheduler = createTestGatewayScheduler();
      await setSessionMcpRuntimeScheduler(mcpScheduler);
      signal.throwIfAborted();
      // Keep rejected acquisitions: no returned handle does not prove cleanup succeeded.
      runtimeStartup = getOrCreateSessionMcpRuntime({
        sessionId: `mcp-app-conformance-${randomUUID()}`,
        sessionKey,
        workspaceDir: tempRoot,
        cfg,
      });
      runtime = await runtimeStartup;
      signal.throwIfAborted();
      await seedMcpAppConformanceSession(runtime, state.env);
      const materialized = await materializeBundleMcpToolsForRun({ runtime, agentId: "main" });
      signal.throwIfAborted();
      materialized.restrictAppTools?.([...materialized.tools, ...(materialized.appTools ?? [])]);
      const show = materialized.tools.find((tool) => tool.name === "conformance__show");
      if (!show) {
        throw new Error("Official MCP App fixture tool did not materialize");
      }
      showFixture = async (callId) => {
        const nextResult = await show.execute(callId, { city: "Paris" });
        const nextViewId = (
          nextResult.details as { mcpAppPreview?: { mcpApp?: { viewId?: string } } }
        ).mcpAppPreview?.mcpApp?.viewId;
        if (!nextViewId) {
          throw new Error("Fixture did not create a view: " + callId);
        }
        return nextViewId;
      };
      viewId = await showFixture("mcp-app-conformance-call");
      signal.throwIfAborted();
      const startupConfigSnapshotRead = await readConfigFileSnapshotWithPluginMetadata({
        observe: false,
      });
      signal.throwIfAborted();
      gatewayStartup = startGatewayServer(gatewayPort, {
        bind: "loopback",
        auth: { mode: "token", token: authValue },
        controlUiEnabled: false,
        startupConfigSnapshotRead,
      });
      await gatewayStartup;
      signal.throwIfAborted();
    },
    close: async () => {
      const gatewayClosed = await settleCleanup("gateway", async () => {
        const gateway = await gatewayStartup;
        await gateway?.close({ reason: "MCP App conformance complete" });
      });
      const mcpStartupSettled = await settleCleanup("MCP startup", async () => {
        await runtimeStartup;
      });
      const mcpClosed = await settleCleanup("MCP runtimes", () => disposeAllSessionMcpRuntimes());
      await settleCleanup("MCP scheduler", async () => {
        await mcpScheduler?.stop();
      });
      const assetServerClosed = appAssetServer
        ? await settleCleanup(
            "asset server",
            () =>
              new Promise<void>((resolve, reject) => {
                appAssetServer?.close((error) => (error ? reject(error) : resolve()));
              }),
          )
        : true;
      // Incomplete cleanup can leave a listener bound; keep its port claimed.
      const releasable = [
        gatewayClosed && portClaims.gateway,
        gatewayClosed && mcpStartupSettled && mcpClosed && portClaims.sandbox,
        assetServerClosed && portClaims.appAsset,
      ].filter((claim): claim is TestPortClaim => Boolean(claim));
      await settleCleanup("port claims", () =>
        Promise.all(releasable.map((claim) => claim.release())),
      );
      if (tempRoot) {
        await settleCleanup("archive fixture events", () =>
          fs.copyFile(fixtureEventsPath, path.join(proofDir, "fixture-events.jsonl")),
        );
      }
      expect(failures).toEqual([]);
    },
    release: async () => {
      // The suite joins setup and cases, then all required closes, before releasing selectors.
      await settleCleanup("fixture temp root", async () => state?.cleanup());
      expect(failures).toEqual([]);
    },
  },
});

async function newProofContext() {
  const context = await suite.newBrowserContext({
    permissions: ["local-network-access"],
    ...(captureUiProof
      ? { recordVideo: { dir: proofDir, size: { width: 1280, height: 800 } } }
      : {}),
  });
  // Preserve the original Playwright operation timeout, not the suite's shorter default.
  context.setDefaultTimeout(30_000);
  return context;
}

suite.define(() => {
  it("drives the authenticated Control UI and ticketed standalone bridges", async (context) => {
    await suite.runScenario(context, {
      run: async (signal) => {
        signal.throwIfAborted();
        const teardownProof = createMcpAppTeardownRecorder(proofDir, fixtureEventsPath);
        const controlContext = await newProofContext();
        const controlPage = await controlContext.newPage();
        await mountHost(controlPage);
        let app = await findAppFrame(controlPage);
        await expectBridge(app, true);
        await expectTheme(app, "dark");
        await controlPage.evaluate(() => {
          const setTheme = Reflect.get(window, "mcpConformanceSetTheme") as
            | ((theme: "light" | "dark") => void)
            | undefined;
          setTheme?.("light");
        });
        await expectTheme(app, "light");
        await expectAppTools(app);
        await capture(controlPage, "control-ui-resource-allowed");
        await app.locator("#update-context").click();
        await waitForText(app.locator("#context-update"), "accepted");
        await app.locator("#send-message").click();
        const confirmation = controlPage.getByRole("alertdialog");
        await waitForTextContaining(confirmation, "summarize selection");
        expect(
          await controlPage.evaluate(() => Reflect.get(window, "mcpConformancePrompt")),
        ).toBeUndefined();
        await confirmation.getByRole("button", { name: "Send", exact: true }).click();
        await waitForText(app.locator("#message"), "accepted");
        await expect
          .poll(() =>
            controlPage.evaluate(() => Reflect.get(window, "mcpConformancePrompt") as string),
          )
          .toBe("summarize selection");
        const currentView = viewLease();
        expect(getMcpAppModelContext(runtime, currentView)).toMatchObject({
          content: [{ type: "text", text: "selected item 42" }],
        });

        const standaloneUrl = await requestStandaloneUrl(controlPage, { sessionKey, viewId });
        await configureImmediate("control-ui-graceful-teardown");
        await teardownProof.run("control-ui-graceful-teardown", controlPage, app, async () => {
          await controlPage.evaluate(async () => {
            const unmount = Reflect.get(window, "mcpConformanceUnmount") as
              | (() => Promise<void>)
              | undefined;
            await unmount?.();
          });
        });

        const standaloneContext = await newProofContext();
        const authorizationHeaders: string[] = [];
        const requestUrls: string[] = [];
        const referrers: string[] = [];
        const standaloneDiagnostics: string[] = [];
        standaloneContext.on("request", (request) => {
          requestUrls.push(request.url());
          const authorization = request.headers().authorization;
          if (authorization) {
            authorizationHeaders.push(authorization);
          }
          const referrer = request.headers().referer;
          if (referrer) {
            referrers.push(referrer);
          }
        });
        const standalonePage = await standaloneContext.newPage();
        standalonePage.on("console", (message) => standaloneDiagnostics.push(message.text()));
        await configureImmediate("standalone-bridge");
        const absoluteStandaloneUrl = `http://127.0.0.1:${gatewayPort}${standaloneUrl}`;
        const ticket = standaloneUrl.split("#")[1] ?? "";
        await standalonePage.goto(absoluteStandaloneUrl);
        app = await findAppFrame(standalonePage);
        await expectBridge(app, false);
        await expectAppTools(app);
        expect(authorizationHeaders.length).toBeGreaterThanOrEqual(3);
        expect(authorizationHeaders.every((value) => value.startsWith("MCP-App v1."))).toBe(true);
        expect(authorizationHeaders.some((value) => value === `Bearer ${authValue}`)).toBe(false);
        expect(ticket).not.toBe("");
        expect(requestUrls.some((value) => value.includes(ticket))).toBe(false);
        expect(referrers.some((value) => value.includes(ticket))).toBe(false);
        expect(standaloneDiagnostics.some((value) => value.includes(ticket))).toBe(false);

        await configureImmediate("standalone-graceful-teardown");
        await teardownProof.run("standalone-graceful-teardown", standalonePage, app, async () => {
          await app.locator("#request-teardown").click();
        });
        for (const { events } of teardownProof.records) {
          const calls = events.filter(
            (event) => event.event === "incoming" && event.tool === "cleanup_save",
          );
          expect(calls).toHaveLength(1);
          const id = calls[0]?.id;
          expect(id).toBeDefined();
          expect(events.filter((event) => event.event === "cleanup-save")).toMatchObject([
            { requestId: id },
          ]);
          expect(
            events.filter(
              (event) => event.event === "response-written" && event.tool === "cleanup_save",
            ),
          ).toMatchObject([{ id, isError: false }]);
        }
        await configureImmediate("standalone-after-teardown");
        await standalonePage.reload();
        app = await findAppFrame(standalonePage);
        await waitForTextContaining(app.locator("#result"), "initial-result");
        await clickFor(app, "call-app", "app-tool", "companion-called");

        const activeView = viewLease();
        activeView.authorizeAppInteraction = async () => false;

        // The already-initialized App retains its capability snapshot, so the
        // authoritative request-time check must still withhold the resource.
        await clickFor(app, "read-resource", "resource", "denied:");
        await waitForTextContaining(app.locator("#resource"), "resource-ok", false);
        await capture(standalonePage, "standalone-resource-revoked");

        await standalonePage.reload();
        app = await findAppFrame(standalonePage);
        await waitForTextContaining(app.locator("#capabilities"), "serverResources", false);
        await clickFor(app, "read-resource", "resource", "denied:");

        const revokedControlPage = await controlContext.newPage();
        await mountHost(revokedControlPage);
        const revokedControlApp = await findAppFrame(revokedControlPage);
        await waitForTextContaining(
          revokedControlApp.locator("#capabilities"),
          "serverResources",
          false,
        );
        await clickFor(revokedControlApp, "read-resource", "resource", "denied:");
        await capture(revokedControlPage, "control-ui-resource-revoked");
        await revokedControlPage.close();

        const tampered = `${absoluteStandaloneUrl.slice(0, -1)}${absoluteStandaloneUrl.endsWith("a") ? "b" : "a"}`;
        const tamperedPage = await standaloneContext.newPage();
        await tamperedPage.goto(tampered);
        await tamperedPage.reload();
        await waitForText(tamperedPage.locator(".error"), "MCP App ticket was rejected");
        await tamperedPage.close();

        const lease = viewLease();
        lease.expiresAtMs = Date.now() - 1;
        await app.locator("#call-app").click();
        await waitForText(standalonePage.locator(".error"), "MCP App ticket was rejected");
      },
    });
  }, 90_000);

  it("preserves composed operations and propagates caller cancellation through real transports", async (context) => {
    await suite.runScenario(context, {
      run: async (signal) => {
        signal.throwIfAborted();
        const http = observeMcpAppHttpResponses(gatewayPort);
        try {
          await configureImmediate("timing-setup");
          viewId = await showFixture("timing-view");
          const controlContext = await newProofContext();
          const standaloneContext = await newProofContext();
          try {
            const controlPage = await controlContext.newPage();
            await mountHost(controlPage);
            await findAppFrame(controlPage);
            const standaloneUrl = await requestStandaloneUrl(controlPage, { sessionKey, viewId });
            const standalonePage = await standaloneContext.newPage();
            const requests = observeMcpAppRequests(standalonePage);
            await standalonePage.goto("http://127.0.0.1:" + gatewayPort + standaloneUrl);
            let app = await findAppFrame(standalonePage);
            // Each RPC stays below 10s; their composition must cross the former 15s HTTP cutoff.
            const timingSpec = { scenario: "list8-call8", callDelayMs: 8000 };
            await fixture.configure(timingSpec);
            await app.locator("#arm-refresh").click();
            await waitForText(app.locator("#arm-result"), "armed");
            // The real notification owns this transition. No catalog field is assigned.
            await expect.poll(() => runtime.peekCatalog()).toBeNull();
            await app.locator("#call-app").click();
            await expect
              .poll(() => app.locator("#app-tool").textContent(), { timeout: 25_000 })
              .not.toBe("pending");
            const output = await app.locator("#app-tool").textContent();
            const timingEvents = await waitForMcpAppTimingEvents(
              fixture.readEvents,
              timingSpec.scenario,
            );

            assertMcpAppTimingEvents(timingEvents, timingSpec);
            expect(output).toContain("companion-called");
            const initializations = (await fixture.readEvents()).filter(
              (event) => event.method === "initialize",
            ).length;
            for (const spec of [
              { scenario: "caller-timeout", action: "timeout" },
              { scenario: "caller-abort", action: "abort" },
              {
                scenario: "caller-cooperative",
                action: "abort",
                callDelayMs: 5000,
                cooperative: true,
              },
              { scenario: "frame-teardown", action: "teardown" },
              { scenario: "pagehide", action: "pagehide" },
            ]) {
              const releasePath = spec.cooperative
                ? undefined
                : path.join(tempRoot, spec.scenario + ".released");
              await fixture.configure({ ...spec, releasePath });
              const httpStart = http.responses.length;
              try {
                await app
                  .locator(spec.action === "timeout" ? "#call-expiring" : "#call-app")
                  .click();
                await waitForFixtureEvent(spec.scenario, "tool-start");
                const startedResponses = http.responses.slice(httpStart);
                expect(startedResponses).toHaveLength(1);
                const response = startedResponses[0]!;
                if (spec.action === "abort") {
                  await app.locator("#cancel-call").click();
                }
                if (spec.action === "teardown") {
                  await app.locator("#request-teardown").click();
                  await expect.poll(() => standalonePage.frames().length).toBe(1);
                } else if (spec.action === "pagehide") {
                  await standalonePage.goto("about:blank");
                } else {
                  await waitForTextContaining(app.locator("#app-tool"), "denied:");
                }
                await waitForFixtureEvent(spec.scenario, "tool-cancellation-observed");
                // Release noncooperative work only after cancellation really reached the SDK.
                if (releasePath) {
                  await fs.writeFile(releasePath, "released");
                }
                // The SDK suppresses late replies even when a server ignores cancellation.
                await waitForFixtureEvent(
                  spec.scenario,
                  spec.cooperative ? "tool-stopped" : "tool-complete",
                  8000,
                );
                const events = await fixture.readEvents(spec.scenario);
                const calls = companionEvents(events, "incoming");
                expect(calls).toHaveLength(1);
                const call = calls[0]!;
                expect(
                  events.filter(
                    (event) =>
                      event.method === "notifications/cancelled" && event.requestId === call.id,
                  ),
                ).toHaveLength(1);
                expect(events.filter((event) => event.event === "tool-complete")).toMatchObject(
                  spec.cooperative ? [] : [{ requestId: call.id, aborted: true }],
                );
                // Chromium may omit requestfailed when navigation destroys the old document.
                // Observe the exact Gateway response, not an unrelated teardown/control POST.
                await expect.poll(() => response.destroyed).toBe(true);
                expect(response.writableFinished).toBe(false);
              } finally {
                if (releasePath) {
                  await fs.writeFile(releasePath, "released");
                }
              }
              if (spec.action === "teardown" || spec.action === "pagehide") {
                const reopenNetworkStart = requests.length;
                const previousTimeOrigin = await standalonePage.evaluate(
                  () => performance.timeOrigin,
                );
                // Navigating to the same fragment URL need not replace a closed heap.
                const response =
                  spec.action === "teardown"
                    ? await standalonePage.reload()
                    : await standalonePage.goto("http://127.0.0.1:" + gatewayPort + standaloneUrl);
                const timeOrigin = await standalonePage.evaluate(() => performance.timeOrigin);
                expect(response?.status()).toBe(200);
                expect(timeOrigin).not.toBe(previousTimeOrigin);
                app = await findAppFrame(standalonePage);
                for (const pathname of ["/__openclaw__/mcp-app", "/__openclaw__/mcp-app/view"]) {
                  expect(
                    requests
                      .slice(reopenNetworkStart)
                      .filter((event) => event.method === "GET" && event.pathname === pathname),
                  ).toHaveLength(1);
                }
              }
              await configureImmediate(spec.scenario + "-control");
              const controlHttpStart = http.responses.length;
              await clickFor(app, "call-app", "app-tool", "companion-called");
              const controlResponses = http.responses.slice(controlHttpStart);
              expect(controlResponses).toHaveLength(1);
              expect(controlResponses[0]?.writableFinished).toBe(true);
              const controlEvents = await fixture.readEvents(spec.scenario + "-control");
              expect(companionEvents(controlEvents, "incoming")).toHaveLength(1);
              expect(companionEvents(controlEvents, "response-written")).toHaveLength(1);
              // A subsequent real response is a causal barrier for the cancelled handler's late reply.
              const settledEvents = await fixture.readEvents(spec.scenario);
              expect(companionEvents(settledEvents, "response-written")).toEqual([]);
              expect(companionEvents(settledEvents, "incoming")).toHaveLength(1);
            }
            expect(
              (await fixture.readEvents()).filter((event) => event.method === "initialize"),
            ).toHaveLength(initializations);

            // Playwright does not support BFCache restoration; use its supported history flow.
            // App documents stay uncached; the public versioned sandbox shell is immutable.
            const historyContext = await newProofContext();
            const historyPage = await historyContext.newPage();
            try {
              const responses: Array<{
                pathname: string;
                version: string | null;
                status: number;
                cacheControl: string | undefined;
              }> = [];
              historyPage.on("response", (response) => {
                if (response.url().includes("mcp-app")) {
                  const url = new URL(response.url());
                  responses.push({
                    pathname: url.pathname,
                    version: url.searchParams.get("v"),
                    status: response.status(),
                    cacheControl: response.headers()["cache-control"],
                  });
                }
              });
              await configureImmediate("history-forward");
              await historyPage.goto(fixtureHistoryUrl);
              await historyPage.goto("http://127.0.0.1:" + gatewayPort + standaloneUrl);
              await findAppFrame(historyPage);
              await historyPage.goBack({ timeout: 15_000 });
              expect(historyPage.url()).toBe(fixtureHistoryUrl);
              await waitForText(historyPage.locator("p"), "History control");
              await historyPage.goForward({ timeout: 15_000 });
              const historyApp = await findAppFrame(historyPage);
              await historyApp.locator("#call-app").click();
              await waitForTextContaining(historyApp.locator("#app-tool"), "companion-called");

              const historyEvents = (await fixture.readEvents("history-forward")).filter(
                (event) => event.tool === "app_companion",
              );
              const historyCalls = historyEvents.filter((event) => event.event === "incoming");
              expect(historyCalls).toHaveLength(1);
              const historyCallId = historyCalls[0]?.id;
              expect(historyCallId).toBeDefined();
              expect(
                historyEvents.filter((event) => event.event === "response-written"),
              ).toMatchObject([{ id: historyCallId, isError: false }]);
              for (const pathname of ["/__openclaw__/mcp-app", "/__openclaw__/mcp-app/view"]) {
                expect(responses.filter((response) => response.pathname === pathname)).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({ status: 200, cacheControl: "no-store" }),
                  ]),
                );
              }
              const sandboxResponses = responses.filter(
                (response) => response.pathname === "/mcp-app-sandbox",
              );
              expect(sandboxResponses.length).toBeGreaterThan(0);
              for (const response of sandboxResponses) {
                expect(response.version).toMatch(/^[a-f0-9]{64}$/);
                expect(response).toMatchObject({
                  status: 200,
                  cacheControl: "public, max-age=31536000, immutable",
                });
              }
            } finally {
              await suite.closeBrowserContext(historyContext);
            }
          } finally {
            await Promise.allSettled([
              suite.closeBrowserContext(controlContext),
              suite.closeBrowserContext(standaloneContext),
            ]);
          }
        } finally {
          http.stop();
          await fs.copyFile(fixtureEventsPath, path.join(proofDir, "fixture-events.jsonl"));
        }
      },
    });
  }, 240_000);
});
