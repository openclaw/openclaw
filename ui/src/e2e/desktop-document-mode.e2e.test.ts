import path from "node:path";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import type { DesktopClient } from "../components/desktop/desktop-client.ts";
import { closeChatLayoutMenu, openChatLayoutMenu } from "../test-helpers/chat-layout-menu.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
  installMockGateway,
  type ControlUiMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import {
  activateChatHeaderPanelAction,
  openChatSidePanelType,
} from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createRfbRawFrame, installScriptedRfbServer } from "./desktop-rfb-test-support.ts";

const suite = createControlUiE2eSuite({
  name: "desktop document mode",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

let artifactDirectory: string;
beforeEach(() => {
  artifactDirectory = createControlUiE2eArtifactDir("mobile-desktop");
});
const button = (root: Page | Locator, name: string) =>
  root.getByRole("button", { name, exact: true });
const exactText = (root: Page | Locator, name: string) => root.getByText(name, { exact: true });
const remoteView = (panel: Locator) => panel.locator("[data-test-remote-desktop='true']");
const unavailable = "The requested desktop is unavailable. Retry when the machine is ready.";
const observe = (token: string, control = false) => ({
  transport: "rfb",
  wsPath: `/desktop/observe?token=${token}`,
  expiresAtMs: 60_000,
  control,
});
const screenshot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(artifactDirectory, `${name}.png`), fullPage: false });
const activeLabel = (panel: Locator) =>
  panel.evaluate((element) =>
    (element.getRootNode() as Document | ShadowRoot).activeElement?.getAttribute("aria-label"),
  );
type GatewayWindow = Window & { openclawControlUiE2eGateway?: ControlUiMockGateway };
const gatewayEnvironment = {
  id: "gateway",
  type: "local",
  status: "available",
  desktop: true,
};

async function installDesktopClientFake(panel: Locator) {
  await panel.evaluate((element) => {
    (
      element as HTMLElement & {
        desktopClientFactory: () => Pick<DesktopClient, "connect">;
      }
    ).desktopClientFactory = () => ({
      async connect(options) {
        element.dataset.viewOnly = String(options.viewOnly);
        element.dataset.scaleViewport = String(options.sizingMode !== "actual");
        const remote = document.createElement("div");
        remote.dataset.testRemoteDesktop = "true";
        remote.textContent = "Remote desktop";
        remote.style.cssText =
          "display:grid;place-items:center;width:100%;height:100%;color:#e8edf5;background:linear-gradient(145deg,#26364d,#111823);font:600 18px system-ui";
        options.target.replaceChildren(remote);
        options.onConnect?.();
        return {
          setPresented() {
            return true;
          },
          disableInput() {
            element.dataset.viewOnly = "true";
          },
          disconnect() {
            remote.remove();
          },
          sendKeyboardEvent(event) {
            element.dataset.lastKeyboardEvent = `${event.type}:${event.key}`;
          },
          sendText(text) {
            element.dataset.lastKeyboardText = text;
          },
          sendBackspace() {
            element.dataset.lastKeyboardText = "Backspace";
          },
          setSizingMode(mode) {
            element.dataset.scaleViewport = String(mode !== "actual");
          },
        };
      },
    });
  });
}

async function startDesktopDocument(
  page: Page,
  route: string,
  desktopObserve: unknown = observe("document", false),
  describedSession?: unknown,
  inventoryMethod: "environments.list" | "environments.status" = route === "focus/desktop"
    ? "environments.list"
    : "environments.status",
) {
  await page.setViewportSize({ width: 390, height: 844 });
  const gateway = await installMockGateway(page, {
    deferredMethods: [inventoryMethod],
    featureMethods: [
      "desktop.observe",
      "environments.list",
      "environments.status",
      "openclaw.setup.detect",
    ],
    methodResponses: {
      "desktop.observe": desktopObserve,
      ...(describedSession === undefined
        ? {}
        : { "sessions.describe": { session: describedSession } }),
      "openclaw.setup.detect": {
        candidates: [],
        manualProviders: [],
        workspace: "/tmp/openclaw-desktop-document",
        setupComplete: false,
      },
    },
  });
  await page.goto(`${suite.server.baseUrl}${route}`);
  const panel = page.locator("openclaw-desktop-panel");
  await panel.waitFor({ state: "attached" });
  const inventoryRequest = await gateway.waitForRequest(inventoryMethod);
  await installDesktopClientFake(panel);
  return { gateway, panel, inventoryMethod, inventoryRequest };
}

async function openDesktopDocument(
  page: Page,
  route: string,
  environments: Array<{ id: string } & Record<string, unknown>>,
  desktopObserve?: unknown,
  describedSession?: unknown,
  inventoryMethod?: "environments.list" | "environments.status",
) {
  const document = await startDesktopDocument(
    page,
    route,
    desktopObserve,
    describedSession,
    inventoryMethod,
  );
  await document.gateway.setMethodResponse("environments.list", { environments });
  if (document.inventoryMethod === "environments.status") {
    const params = document.inventoryRequest.params;
    if (
      !params ||
      typeof params !== "object" ||
      !("environmentId" in params) ||
      typeof params.environmentId !== "string"
    ) {
      throw new Error("Expected a targeted environment status request");
    }
    const environmentId = params.environmentId;
    const environment = environments.find((entry) => entry.id === environmentId);
    if (environment) {
      await document.gateway.setMethodResponse("environments.status", environment);
      await document.gateway.resolveDeferred("environments.status", environment);
    } else {
      await document.gateway.rejectDeferred("environments.status", {
        code: "INVALID_REQUEST",
        message: "unknown environmentId",
      });
    }
  } else {
    await document.gateway.resolveDeferred("environments.list", { environments });
  }
  return document;
}

suite.define(() => {
  it("paints the session desktop without waiting for global inventory", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:main:targeted-desktop";
      const environment = {
        id: "worker-targeted",
        type: "worker",
        status: "available",
        desktop: true,
      };
      const gateway = await installMockGateway(page, {
        sessionKey,
        deferredMethods: ["environments.list", "environments.status"],
        featureMethods: ["desktop.observe", "environments.list", "environments.status"],
        methodResponses: {
          "sessions.describe": {
            session: {
              key: sessionKey,
              kind: "direct",
              updatedAt: 1,
              placement: { state: "active", environmentId: environment.id },
            },
          },
          "desktop.observe": observe("targeted", false),
        },
      });
      await page.goto(
        `${suite.server.baseUrl}focus/desktop/session/${encodeURIComponent(sessionKey)}`,
      );
      const panel = page.locator("openclaw-desktop-panel");
      await panel.waitFor({ state: "attached" });
      const rfb = await installScriptedRfbServer(page);
      const status = await gateway.waitForRequest("environments.status");
      expect(status.params).toEqual({ environmentId: environment.id });
      expect(await gateway.getRequests("sessions.describe")).toHaveLength(1);
      expect(await gateway.getRequests("environments.list")).toHaveLength(0);
      await gateway.resolveDeferred("environments.status", environment);
      await expect.poll(rfb.events).toEqual(["authenticated:1"]);
      await rfb.send([createRfbRawFrame()]);
      await expect
        .poll(() =>
          panel.evaluate((element) => {
            const canvas = element.querySelector<HTMLCanvasElement>("canvas");
            return [...(canvas?.getContext("2d")?.getImageData(0, 0, 1, 1).data ?? [])].join(",");
          }),
        )
        .toBe("24,180,160,255");
      expect(await gateway.getRequests("environments.list")).toHaveLength(0);
      await screenshot(page, "session-first-frame-without-global-inventory");

      for (let index = 0; index < 32; index += 1) {
        await gateway.emitGatewayEvent("sessions.changed", { sessionKey, phase: "message" });
      }
      expect(await gateway.getRequests("sessions.describe")).toHaveLength(1);
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(1);
      expect(await rfb.events()).toEqual(["authenticated:1"]);

      const replacement = { ...environment, id: "worker-replacement" };
      await gateway.setMethodResponse("environments.status", replacement);
      await gateway.deferNext("sessions.describe");
      await gateway.emitGatewayEvent("sessions.changed", { sessionKey, reason: "placement" });
      await gateway.waitForRequest("sessions.describe", { after: 1 });
      for (let index = 0; index < 32; index += 1) {
        await gateway.emitGatewayEvent("sessions.changed", { sessionKey, phase: "message" });
      }
      expect(await gateway.getRequests("sessions.describe")).toHaveLength(2);
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(1);
      await gateway.resolveDeferred("sessions.describe", {
        session: { key: sessionKey, placement: { state: "active", environmentId: replacement.id } },
      });
      expect((await gateway.waitForRequest("desktop.observe", { after: 1 })).params).toEqual({
        source: { kind: "environment", environmentId: replacement.id },
        control: false,
      });
      await expect.poll(async () => (await rfb.events()).includes("authenticated:2")).toBe(true);
      await gateway.setMethodResponse("environments.status", environment);
      await gateway.emitGatewayEvent("sessions.changed", { sessionKey, phase: "start" });
      expect((await gateway.waitForRequest("desktop.observe", { after: 2 })).params).toEqual({
        source: { kind: "environment", environmentId: environment.id },
        control: false,
      });
      expect(await gateway.getRequests("environments.list")).toHaveLength(0);
    });
  });

  it.each(["active", "starting", "offline"])(
    "opens the %s chat session desktop and follows an explicit pop-out selection",
    async (initialState) => {
      await suite.withPage({ serviceWorkers: "block" }, async ({ context, page }) => {
        const sessionKey = "agent:main:cloud-desktop";
        // This test exercises an explicit manual open, not automatic discovery.
        await page.addInitScript(
          ({ key, sessionKey: scopedSessionKey }) => {
            localStorage.setItem(
              key,
              JSON.stringify({
                sessionKey: scopedSessionKey,
                sidebarSessionLayouts: {
                  [scopedSessionKey]: { columns: [], resourceAutoOpenDismissed: true },
                },
              }),
            );
          },
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), sessionKey },
        );
        const session = {
          key: sessionKey,
          sessionId: "cloud-desktop-session",
          kind: "direct",
          label: "Cloud desktop session",
          updatedAt: 1,
          placement: {
            state: initialState === "offline" ? "active" : initialState,
            environmentId: "worker-cloud",
            ...(initialState === "offline"
              ? { runner: { kind: "device", status: "offline", deviceId: "workstation" } }
              : {}),
          },
        };
        const gateway = await installMockGateway(page, {
          sessionKey,
          deferredMethods: ["environments.status"],
          featureMethods: ["desktop.observe", "environments.list", "environments.status"],
          methodResponses: {
            "sessions.list": chatSessionListResponse([session]),
            "desktop.observe": observe("chat-session", false),
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await waitForControlUiGatewayReady(page);
        if (initialState !== "active") {
          await openChatSidePanelType(page, "Desktop");
        } else {
          await activateChatHeaderPanelAction(page, "Desktop");
        }
        const panel = page.locator("openclaw-desktop-panel");
        await panel.waitFor({ state: "attached" });
        await installDesktopClientFake(panel);
        const sessionEnvironment = {
          id: initialState === "offline" ? "node:workstation" : "worker-cloud",
          type: initialState === "offline" ? "node" : "worker",
          status: "available",
          desktop: true,
        };
        const inventory = {
          environments: [
            gatewayEnvironment,
            sessionEnvironment,
            { id: "node:maintenance", type: "node", status: "available", desktop: true },
          ],
        };
        await gateway.setMethodResponse("environments.list", inventory);
        await gateway.setMethodResponse("environments.status", {
          cases: inventory.environments.map((environment) => ({
            match: { environmentId: environment.id },
            response: environment,
          })),
        });
        if (initialState !== "active") {
          await exactText(panel, unavailable).waitFor();
          await button(panel, "Retry").waitFor();
          expect(await gateway.getRequests("environments.status")).toHaveLength(0);
          expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
          await gateway.setSessionsListResponse(
            chatSessionListResponse([
              {
                ...session,
                placement: {
                  ...session.placement,
                  state: "active",
                  ...(session.placement.runner
                    ? { runner: { ...session.placement.runner, status: "available" } }
                    : {}),
                },
              },
            ]),
          );
          await gateway.emitGatewayEvent("sessions.changed", { sessionKey });
        }

        const target = await gateway.waitForRequest("environments.status");
        expect(target.params).toEqual({ environmentId: sessionEnvironment.id });
        expect(await gateway.getRequests("environments.list")).toHaveLength(0);
        expect(await exactText(panel, "Desktop sources").count()).toBe(0);
        await gateway.resolveDeferred("environments.status", sessionEnvironment);
        const observed = await gateway.waitForRequest("desktop.observe");
        expect(observed.params).toEqual({
          source:
            initialState === "offline"
              ? { kind: "node", nodeId: "workstation" }
              : { kind: "environment", environmentId: "worker-cloud" },
          control: false,
        });
        await remoteView(panel).waitFor();
        const layoutMenu = await openChatLayoutMenu(page);
        const popout = layoutMenu.getByRole("link", { name: "Open desktop in new window" });
        expect(await popout.getAttribute("href")).toBe(
          `/focus/desktop/session/${encodeURIComponent(sessionKey)}`,
        );
        await closeChatLayoutMenu(page);
        await screenshot(page, `chat-session-${initialState}-connected`);

        await page.evaluate(() => {
          window.dispatchEvent(
            new CustomEvent("openclaw:desktop-toggle", {
              detail: { open: true, environmentId: "node:maintenance" },
            }),
          );
        });
        expect((await gateway.waitForRequest("desktop.observe", { after: 1 })).params).toEqual({
          source: { kind: "node", nodeId: "maintenance" },
          control: false,
        });
        await remoteView(panel).waitFor();
        const controlResponse = observe("manual-selection", true);
        await gateway.setMethodResponse("desktop.observe", controlResponse);
        await button(panel, "Take control").click();
        expect((await gateway.waitForRequest("desktop.observe", { after: 2 })).params).toEqual({
          source: { kind: "node", nodeId: "maintenance" },
          control: true,
        });
        await expect.poll(() => panel.getAttribute("data-view-only")).toBe("false");
        await screenshot(page, `chat-session-${initialState}-manual-selection`);
        const focusPath = "/focus/desktop/control/source/node%3Amaintenance";
        await openChatLayoutMenu(page);
        await expect.poll(() => popout.getAttribute("href")).toBe(focusPath);

        const selectedDesktop = await panel
          .locator("[data-test-remote-desktop='true']")
          .elementHandle();
        // Placement changes must not even briefly rewrite an explicit pop-out link.
        const hrefChanges = await popout.evaluateHandle((link) => {
          const previousHrefs: Array<string | null> = [];
          const observer = new MutationObserver((changes) => {
            previousHrefs.push(...changes.map((change) => change.oldValue));
          });
          observer.observe(link, {
            attributes: true,
            attributeFilter: ["href"],
            attributeOldValue: true,
          });
          return { observer, previousHrefs };
        });
        await gateway.setSessionsListResponse(
          chatSessionListResponse([
            {
              ...session,
              placement: { state: "active", environmentId: "worker-replacement" },
            },
          ]),
        );
        await gateway.emitGatewayEvent("sessions.changed", { sessionKey, reason: "placement" });
        await expect
          .poll(() =>
            panel.evaluate(
              (element) => (element as HTMLElement & { requestedSource: string }).requestedSource,
            ),
          )
          .toBe("worker-replacement");
        await screenshot(page, `chat-session-${initialState}-placement-update`);
        expect(await selectedDesktop?.evaluate((element) => element.isConnected)).toBe(true);
        expect(await gateway.getRequests("desktop.observe")).toHaveLength(3);
        expect(await panel.getAttribute("data-view-only")).toBe("false");
        expect(await popout.getAttribute("href")).toBe(focusPath);
        const observedHrefs = await hrefChanges.evaluate(({ observer, previousHrefs }) => {
          previousHrefs.push(...observer.takeRecords().map((change) => change.oldValue));
          observer.disconnect();
          return previousHrefs;
        });
        expect(observedHrefs.filter((href) => href !== focusPath)).toEqual([]);

        const popupScenario = {
          sessionKey,
          deferredMethods: ["environments.status"],
          featureMethods: ["desktop.observe", "environments.list", "environments.status"],
          methodResponses: { "desktop.observe": controlResponse },
        };
        await context.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
          route.fulfill({ json: createControlUiMockBootstrapConfig(popupScenario) }),
        );
        await context.addInitScript({
          content: createControlUiMockGatewayInitScript(popupScenario),
        });
        const [popup] = await Promise.all([context.waitForEvent("page"), popout.click()]);
        try {
          await popup.waitForLoadState("domcontentloaded");
          expect(new URL(popup.url()).pathname).toBe(focusPath);
          const focusedPanel = popup.locator("openclaw-desktop-panel");
          await focusedPanel.waitFor({ state: "attached" });
          await popup.waitForFunction(
            () =>
              (window as GatewayWindow).openclawControlUiE2eGateway?.findRequests(
                "environments.status",
              ).length,
          );
          await installDesktopClientFake(focusedPanel);
          await popup.evaluate((environment) => {
            (window as GatewayWindow).openclawControlUiE2eGateway?.resolveDeferred(
              "environments.status",
              environment,
            );
          }, inventory.environments[2]);
          await remoteView(focusedPanel).waitFor();
          expect(
            await popup.evaluate(() =>
              (window as GatewayWindow).openclawControlUiE2eGateway
                ?.findRequests("desktop.observe")
                .map((request) => request.params),
            ),
          ).toEqual([{ source: { kind: "node", nodeId: "maintenance" }, control: true }]);
          await expect.poll(() => focusedPanel.getAttribute("data-view-only")).toBe("false");
          await screenshot(popup, `chat-session-${initialState}-focused-selection`);
        } finally {
          await popup.close();
        }
      });
    },
  );

  it("returns from an unavailable focused desktop", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}dashboards`);
      await page.locator("openclaw-app-shell").waitFor();
      await page.goto(`${suite.server.baseUrl}focus/desktop`);

      await exactText(page, "Desktop viewing is unavailable for this connection.").waitFor();
      const back = button(page, "Back");
      await back.waitFor();
      await back.click();
      await page.waitForURL(`${suite.server.baseUrl}dashboards`);
    });
  });

  it("renders a full-bleed shell-free picker", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { panel } = await openDesktopDocument(page, "focus/desktop", [gatewayEnvironment]);
      const viewer = panel.locator("section.desktop-document");
      await viewer.waitFor();
      await exactText(panel, "Desktop sources").waitFor();

      expect(await page.locator("openclaw-app-shell").count()).toBe(0);
      expect(page.url()).not.toContain("model-setup");
      const bounds = await viewer.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(389);
      expect(bounds?.height).toBeGreaterThanOrEqual(843);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);

      await screenshot(page, "picker-390x844");
    });
  });

  it("falls back to the picker with a notice for an unobservable source", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { gateway, panel } = await openDesktopDocument(
        page,
        "focus/desktop/source/missing-machine",
        [gatewayEnvironment],
      );

      await exactText(panel, unavailable).waitFor();
      await exactText(panel, "Desktop sources").waitFor();
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
    });
  });

  it.each([
    {
      name: "execution node",
      session: { execNode: "workstation" },
      environment: { id: "node:workstation", type: "node" },
      source: { kind: "node", nodeId: "workstation" },
    },
    {
      name: "paired device placement",
      session: {
        placement: {
          state: "active",
          environmentId: "worker-device",
          runner: { kind: "device", deviceId: "workstation", status: "available" },
        },
      },
      environment: { id: "node:workstation", type: "node" },
      source: { kind: "node", nodeId: "workstation" },
    },
    {
      name: "cloud placement",
      session: { placement: { state: "active", environmentId: "worker-cloud" } },
      environment: { id: "worker-cloud", type: "worker" },
      source: { kind: "environment", environmentId: "worker-cloud" },
    },
  ])("resolves a $name session to its observable machine and auto-connects", async (scenario) => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:main:mobile-session";
      const { gateway, panel } = await openDesktopDocument(
        page,
        `focus/desktop/session/${encodeURIComponent(sessionKey)}`,
        [
          gatewayEnvironment,
          {
            ...scenario.environment,
            status: "available",
            desktop: true,
          },
        ],
        undefined,
        {
          key: sessionKey,
          kind: "direct",
          updatedAt: 1,
          ...scenario.session,
        },
      );

      const request = await gateway.waitForRequest("desktop.observe");
      expect(request.params).toEqual({
        source: scenario.source,
        control: false,
      });
      await remoteView(panel).waitFor();
      await gateway.setMethodResponse("sessions.describe", {
        session: {
          key: sessionKey,
          kind: "direct",
          updatedAt: 2,
          ...scenario.session,
          placement: { state: "reclaimed" },
        },
      });
      await gateway.setMethodResponse("environments.list", {
        environments: [gatewayEnvironment, { ...scenario.environment, desktop: true }],
      });
      await gateway.emitGatewayEvent("sessions.changed", { sessionKey, reason: "reclaim" });
      await exactText(panel, "Desktop sources").waitFor();
      expect(await remoteView(panel).count()).toBe(0);
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(1);

      await gateway.setMethodResponse("sessions.describe", {
        session: { key: sessionKey, kind: "direct", updatedAt: 3, ...scenario.session },
      });
      await gateway.emitGatewayEvent("sessions.changed", { sessionKey, reason: "placement" });
      await remoteView(panel).waitFor();
      expect((await gateway.getRequests("desktop.observe")).at(-1)?.params).toEqual({
        source: scenario.source,
        control: false,
      });
      await screenshot(page, `session-${scenario.name.replaceAll(" ", "-")}-390x844`);
    });
  });

  it.each([
    { name: "unknown", session: null },
    {
      name: "reclaimed cloud",
      session: {
        key: "agent:main:missing",
        kind: "direct",
        updatedAt: 1,
        placement: { state: "reclaimed", environmentId: "worker-stopped" },
      },
    },
  ])("falls back to the picker with a notice for a $name session", async ({ session }) => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { gateway, panel } = await openDesktopDocument(
        page,
        "focus/desktop/session/agent%3Amain%3Amissing",
        [gatewayEnvironment],
        undefined,
        session,
        "environments.list",
      );

      await exactText(panel, unavailable).waitFor();
      await exactText(panel, "Desktop sources").waitFor();
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
      await screenshot(page, "unknown-session-picker-390x844");
    });
  });

  it("renders inventory failure recovery and retries the preselected source", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { gateway, panel } = await startDesktopDocument(page, "focus/desktop/source/gateway");
      await gateway.rejectDeferred("environments.status", {
        code: "UNAVAILABLE",
        message: "desktop inventory is temporarily unavailable",
      });

      await panel.getByRole("alert").filter({ hasText: "inventory" }).waitFor();
      const retry = button(panel, "Retry");
      await retry.waitFor();
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);

      await gateway.setMethodResponse("environments.status", gatewayEnvironment);
      await retry.click();
      const observeRequest = await gateway.waitForRequest("desktop.observe");
      expect(observeRequest.params).toEqual({ source: { kind: "host" }, control: false });
      await remoteView(panel).waitFor();
    });
  });

  it("recovers a session-preselected desktop after an inventory failure", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const sessionKey = "agent:main:mobile-session";
      const nodeEnvironment = {
        id: "node:workstation",
        type: "node",
        status: "available",
        desktop: true,
      };
      const { gateway, panel } = await startDesktopDocument(
        page,
        `focus/desktop/session/${encodeURIComponent(sessionKey)}`,
        undefined,
        { key: sessionKey, kind: "direct", updatedAt: 1, execNode: "workstation" },
      );
      await gateway.rejectDeferred("environments.status", {
        code: "UNAVAILABLE",
        message: "desktop inventory is temporarily unavailable",
      });

      // Resolution succeeded; retry still follows this session's current target.
      const retry = button(panel, "Retry");
      await retry.waitFor();
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);

      await gateway.setMethodResponse("environments.status", nodeEnvironment);
      await retry.click();
      const observeRequest = await gateway.waitForRequest("desktop.observe");
      expect(observeRequest.params).toEqual({
        source: { kind: "node", nodeId: "workstation" },
        control: false,
      });
      await remoteView(panel).waitFor();
    });
  });

  it("keeps all six touch controls reachable at 320px, phone, and desktop widths", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { gateway, panel } = await openDesktopDocument(
        page,
        "focus/desktop/source/gateway",
        [gatewayEnvironment],
        {
          sequence: [observe("view", false), observe("control", true)],
        },
      );

      const viewRequest = await gateway.waitForRequest("desktop.observe");
      expect(viewRequest.params).toEqual({ source: { kind: "host" }, control: false });
      await expect.poll(() => panel.getAttribute("data-view-only")).toBe("true");
      const touchActions = panel.locator(".desktop-touch-action, .desktop-sizing");
      await expect.poll(() => touchActions.count()).toBe(6);
      await expect.poll(() => button(panel, "Audio unavailable").isDisabled()).toBe(true);
      await panel
        .getByRole("button", { name: "Open desktop in Picture-in-Picture", exact: true })
        .waitFor();
      await button(panel, "Back").waitFor();

      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        await screenshot(page, `connected-toolbar-${width}x844`);
        const actions = await touchActions.evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            const root = element.getRootNode() as ShadowRoot;
            const icon = element.querySelector("svg")?.getBoundingClientRect();
            const reachable = [
              [rect.left + 2, rect.top + rect.height / 2],
              [rect.right - 2, rect.top + rect.height / 2],
              [rect.left + rect.width / 2, rect.top + 2],
              [rect.left + rect.width / 2, rect.bottom - 2],
              [rect.left + rect.width / 2, rect.top + rect.height / 2],
            ].every(([x, y]) => element.contains(root.elementFromPoint(x!, y!)));
            return {
              label: element.getAttribute("aria-label"),
              width: rect.width,
              height: rect.height,
              left: rect.left,
              right: rect.right,
              reachable,
              iconContained:
                !icon ||
                (icon.left >= rect.left &&
                  icon.right <= rect.right &&
                  icon.top >= rect.top &&
                  icon.bottom <= rect.bottom),
            };
          }),
        );
        for (const action of actions) {
          expect(action.width, action.label ?? "touch control").toBeGreaterThanOrEqual(44);
          expect(action.height).toBeGreaterThanOrEqual(44);
          expect(action.left).toBeGreaterThanOrEqual(12);
          expect(action.right).toBeLessThanOrEqual(width - 12);
          expect(action.reachable, action.label ?? "touch control").toBe(true);
          expect(action.iconContained, action.label ?? "touch control").toBe(true);
        }
      }
      await page.setViewportSize({ width: 320, height: 844 });
      await panel.getByRole("combobox", { name: "Desktop size", exact: true }).focus();
      await page.keyboard.press("Tab");
      expect(await activeLabel(panel)).toBe("Back");
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Shift+Tab");
      expect(await activeLabel(panel)).toBe("Take control");
      await page.keyboard.press("Enter");
      await expect.poll(async () => (await gateway.getRequests("desktop.observe")).length).toBe(2);
      expect((await gateway.getRequests("desktop.observe"))[1]?.params).toEqual({
        source: { kind: "host" },
        control: true,
      });
      await expect.poll(() => panel.getAttribute("data-view-only")).toBe("false");

      await panel
        .getByRole("combobox", { name: "Desktop size", exact: true })
        .selectOption("actual");
      await expect.poll(() => panel.getAttribute("data-scale-viewport")).toBe("false");

      await button(panel, "Keyboard").click();
      expect(
        await panel.evaluate((element) =>
          (element.getRootNode() as Document | ShadowRoot).activeElement?.classList.contains(
            "desktop-keyboard-input",
          ),
        ),
      ).toBe(true);
      await page.keyboard.type("k");
      await expect.poll(() => panel.getAttribute("data-last-keyboard-event")).toBe("keyup:k");
      await panel.locator(".desktop-keyboard-input").evaluate((element) => {
        const input = element as HTMLTextAreaElement;
        input.value += "m";
        input.dispatchEvent(
          new InputEvent("input", { data: "m", inputType: "insertText", bubbles: true }),
        );
      });
      await expect.poll(() => panel.getAttribute("data-last-keyboard-text")).toBe("m");

      await screenshot(page, "controlled-toolbar-320x844");
    });
  });

  it("applies the optional control segment as the initial control request", async () => {
    for (const [route, expected] of [
      ["focus/desktop/source/gateway", false],
      ["focus/desktop/control/source/gateway", true],
    ] as const) {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        const { gateway } = await openDesktopDocument(
          page,
          route,
          [gatewayEnvironment],
          observe(`control-${String(expected)}`, expected),
        );
        const request = await gateway.waitForRequest("desktop.observe");
        expect(request.params).toEqual({ source: { kind: "host" }, control: expected });
      });
    }
  });
});
