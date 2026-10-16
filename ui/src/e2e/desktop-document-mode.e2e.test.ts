import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import type { DesktopClient } from "../components/desktop/desktop-client.ts";
import { closeChatLayoutMenu, openChatLayoutMenu } from "../test-helpers/chat-layout-menu.ts";
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
const activeLabel = (panel: Locator) =>
  panel.evaluate((element) =>
    (element.getRootNode() as Document | ShadowRoot).activeElement?.getAttribute("aria-label"),
  );
type GatewayWindow = Window & { openclawControlUiE2eGateway?: ControlUiMockGateway };
type Gateway = Awaited<ReturnType<typeof installMockGateway>>;
type DesktopHost = HTMLElement & { desktopClientFactory: () => Pick<DesktopClient, "connect"> };
const makeEnvironment = (id: string) => ({
  id,
  type: id === "gateway" ? "local" : id.startsWith("node:") ? "node" : "worker",
  status: "available",
  desktop: true,
});
const gatewayEnvironment = makeEnvironment("gateway");
const desktopMethods = ["desktop.observe", "environments.list", "environments.status"];
const source = (id: string) =>
  id === "gateway"
    ? { kind: "host" }
    : id.startsWith("node:")
      ? { kind: "node", nodeId: id.slice(5) }
      : { kind: "environment", environmentId: id };
const sessionRow = <T extends Record<string, unknown>>(key: string, fields: T, updatedAt = 1) => ({
  key,
  kind: "direct",
  updatedAt,
  ...fields,
});
async function expectObserve(gateway: Gateway, id: string, control = false, after = 0) {
  expect((await gateway.waitForRequest("desktop.observe", { after })).params).toEqual({
    source: source(id),
    control,
  });
}
async function expectRequests(gateway: Gateway, counts: Record<string, number>) {
  for (const [method, count] of Object.entries(counts)) {
    expect(await gateway.getRequests(method)).toHaveLength(count);
  }
}

async function installDesktopClientFake(panel: Locator) {
  await panel.evaluate((element) => {
    (element as DesktopHost).desktopClientFactory = () => ({
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
          setPresented: () => true,
          disableInput() {
            element.dataset.viewOnly = "true";
          },
          disconnect: () => remote.remove(),
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

type DesktopOptions = {
  desktopObserve?: unknown;
  session?: unknown;
  inventoryMethod?: "environments.list" | "environments.status";
  environments?: Array<{ id: string } & Record<string, unknown>>;
};
async function startDesktopDocument(page: Page, route: string, options: DesktopOptions = {}) {
  const {
    desktopObserve = observe("document"),
    session: describedSession,
    inventoryMethod = route === "focus/desktop" ? "environments.list" : "environments.status",
  } = options;
  await page.setViewportSize({ width: 390, height: 844 });
  const gateway = await installMockGateway(page, {
    deferredMethods: [inventoryMethod],
    featureMethods: [...desktopMethods, "openclaw.setup.detect"],
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
  { environments = [gatewayEnvironment], ...options }: DesktopOptions = {},
) {
  const document = await startDesktopDocument(page, route, options);
  await document.gateway.setMethodResponse("environments.list", { environments });
  if (document.inventoryMethod === "environments.status") {
    const params = document.inventoryRequest.params;
    const environmentId =
      params && typeof params === "object" && "environmentId" in params
        ? params.environmentId
        : undefined;
    expect(environmentId, "targeted environment status request").toBeTypeOf("string");
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
      const targetEnvironment = makeEnvironment("worker-targeted");
      const gateway = await installMockGateway(page, {
        sessionKey,
        deferredMethods: ["environments.list", "environments.status"],
        featureMethods: desktopMethods,
        methodResponses: {
          "sessions.describe": {
            session: sessionRow(sessionKey, {
              placement: { state: "active", environmentId: targetEnvironment.id },
            }),
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
      expect(status.params).toEqual({ environmentId: targetEnvironment.id });
      await expectRequests(gateway, { "sessions.describe": 1, "environments.list": 0 });
      await gateway.resolveDeferred("environments.status", targetEnvironment);
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

      for (let index = 0; index < 32; index += 1) {
        await gateway.emitGatewayEvent("sessions.changed", { sessionKey, phase: "message" });
      }
      await expectRequests(gateway, { "sessions.describe": 1, "desktop.observe": 1 });
      expect(await rfb.events()).toEqual(["authenticated:1"]);

      const replacement = makeEnvironment("worker-replacement");
      await gateway.setMethodResponse("environments.status", replacement);
      await gateway.deferNext("sessions.describe");
      await gateway.emitGatewayEvent("sessions.changed", { sessionKey, reason: "placement" });
      await gateway.waitForRequest("sessions.describe", { after: 1 });
      for (let index = 0; index < 32; index += 1) {
        await gateway.emitGatewayEvent("sessions.changed", { sessionKey, phase: "message" });
      }
      await expectRequests(gateway, { "sessions.describe": 2, "desktop.observe": 1 });
      await gateway.resolveDeferred("sessions.describe", {
        session: { key: sessionKey, placement: { state: "active", environmentId: replacement.id } },
      });
      await expectObserve(gateway, replacement.id, false, 1);
      await expect.poll(async () => (await rfb.events()).includes("authenticated:2")).toBe(true);
      await gateway.setMethodResponse("environments.status", targetEnvironment);
      await gateway.emitGatewayEvent("sessions.changed", { sessionKey, phase: "start" });
      await expectObserve(gateway, targetEnvironment.id, false, 2);
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
        const session = sessionRow(sessionKey, {
          sessionId: "cloud-desktop-session",
          label: "Cloud desktop session",
          placement: {
            state: initialState === "offline" ? "active" : initialState,
            environmentId: "worker-cloud",
            ...(initialState === "offline"
              ? { runner: { kind: "device", status: "offline", deviceId: "workstation" } }
              : {}),
          },
        });
        const gateway = await installMockGateway(page, {
          sessionKey,
          deferredMethods: ["environments.status"],
          featureMethods: desktopMethods,
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
        const sessionEnvironment = makeEnvironment(
          initialState === "offline" ? "node:workstation" : "worker-cloud",
        );
        const inventory = {
          environments: [
            gatewayEnvironment,
            sessionEnvironment,
            makeEnvironment("node:maintenance"),
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
          await expectRequests(gateway, { "environments.status": 0, "desktop.observe": 0 });
          await gateway.setSessionsListResponse(
            chatSessionListResponse([
              {
                ...session,
                placement: {
                  state: "active",
                  environmentId: "worker-cloud",
                  ...(initialState === "offline"
                    ? { runner: { kind: "device", deviceId: "workstation", status: "available" } }
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
        await expectObserve(gateway, sessionEnvironment.id);
        await remoteView(panel).waitFor();
        const layoutMenu = await openChatLayoutMenu(page);
        const popout = layoutMenu.getByRole("link", { name: "Open desktop in new window" });
        expect(await popout.getAttribute("href")).toBe(
          `/focus/desktop/session/${encodeURIComponent(sessionKey)}`,
        );
        await closeChatLayoutMenu(page);

        await page.evaluate(() => {
          window.dispatchEvent(
            new CustomEvent("openclaw:desktop-toggle", {
              detail: { open: true, environmentId: "node:maintenance" },
            }),
          );
        });
        await expectObserve(gateway, "node:maintenance", false, 1);
        await remoteView(panel).waitFor();
        const controlResponse = observe("manual-selection", true);
        await gateway.setMethodResponse("desktop.observe", controlResponse);
        await button(panel, "Take control").click();
        await expectObserve(gateway, "node:maintenance", true, 2);
        await expect.poll(() => panel.getAttribute("data-view-only")).toBe("false");
        const focusPath = "/focus/desktop/control/source/node%3Amaintenance";
        await openChatLayoutMenu(page);
        await expect.poll(() => popout.getAttribute("href")).toBe(focusPath);

        const selectedDesktop = await remoteView(panel).elementHandle();
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
          featureMethods: desktopMethods,
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
      const { panel } = await openDesktopDocument(page, "focus/desktop");
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
    });
  });

  it("falls back to the picker with a notice for an unobservable source", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { gateway, panel } = await openDesktopDocument(
        page,
        "focus/desktop/source/missing-machine",
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
        {
          environments: [gatewayEnvironment, makeEnvironment(scenario.environment.id)],
          session: sessionRow(sessionKey, scenario.session),
        },
      );

      const request = await gateway.waitForRequest("desktop.observe");
      expect(request.params).toEqual({
        source: scenario.source,
        control: false,
      });
      await remoteView(panel).waitFor();
      await gateway.setMethodResponse("sessions.describe", {
        session: sessionRow(
          sessionKey,
          { ...scenario.session, placement: { state: "reclaimed" } },
          2,
        ),
      });
      await gateway.setMethodResponse("environments.list", {
        environments: [gatewayEnvironment, { ...scenario.environment, desktop: true }],
      });
      await gateway.emitGatewayEvent("sessions.changed", { sessionKey, reason: "reclaim" });
      await exactText(panel, "Desktop sources").waitFor();
      expect(await remoteView(panel).count()).toBe(0);
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(1);

      await gateway.setMethodResponse("sessions.describe", {
        session: sessionRow(sessionKey, scenario.session, 3),
      });
      await gateway.emitGatewayEvent("sessions.changed", { sessionKey, reason: "placement" });
      await remoteView(panel).waitFor();
      expect((await gateway.getRequests("desktop.observe")).at(-1)?.params).toEqual({
        source: scenario.source,
        control: false,
      });
    });
  });

  it.each([
    { name: "unknown", session: null },
    {
      name: "reclaimed cloud",
      session: sessionRow("agent:main:missing", {
        placement: { state: "reclaimed", environmentId: "worker-stopped" },
      }),
    },
  ])("falls back to the picker with a notice for a $name session", async ({ session }) => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { gateway, panel } = await openDesktopDocument(
        page,
        "focus/desktop/session/agent%3Amain%3Amissing",
        { session, inventoryMethod: "environments.list" },
      );

      await exactText(panel, unavailable).waitFor();
      await exactText(panel, "Desktop sources").waitFor();
      expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);
    });
  });

  it.each([false, true])(
    "retries a preselected desktop after inventory failure (session=%s)",
    async (sessionSelected) => {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        const sessionKey = "agent:main:mobile-session";
        const id = sessionSelected ? "node:workstation" : "gateway";
        const { gateway, panel } = await startDesktopDocument(
          page,
          sessionSelected
            ? `focus/desktop/session/${encodeURIComponent(sessionKey)}`
            : "focus/desktop/source/gateway",
          {
            session: sessionSelected
              ? sessionRow(sessionKey, { execNode: "workstation" })
              : undefined,
          },
        );
        await gateway.rejectDeferred("environments.status", {
          code: "UNAVAILABLE",
          message: "desktop inventory is temporarily unavailable",
        });

        if (!sessionSelected) {
          await panel.getByRole("alert").filter({ hasText: "inventory" }).waitFor();
        }
        const retry = button(panel, "Retry");
        await retry.waitFor();
        expect(await gateway.getRequests("desktop.observe")).toHaveLength(0);

        await gateway.setMethodResponse("environments.status", makeEnvironment(id));
        await retry.click();
        await expectObserve(gateway, id);
        await remoteView(panel).waitFor();
      });
    },
  );

  it("keeps all six touch controls reachable at 320px, phone, and desktop widths", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const { gateway, panel } = await openDesktopDocument(page, "focus/desktop/source/gateway", {
        desktopObserve: { sequence: [observe("view", false), observe("control", true)] },
      });

      await expectObserve(gateway, "gateway");
      await expect.poll(() => panel.getAttribute("data-view-only")).toBe("true");
      const touchActions = panel.locator(".desktop-touch-action, .desktop-sizing");
      await expect.poll(() => touchActions.count()).toBe(6);
      await expect.poll(() => button(panel, "Audio unavailable").isDisabled()).toBe(true);
      await button(panel, "Open desktop in Picture-in-Picture").waitFor();
      await button(panel, "Back").waitFor();

      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        const actions = await touchActions.evaluateAll(
          (elements, viewportWidth) =>
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
                size: rect.width >= 44 && rect.height >= 44,
                inset: rect.left >= 12 && rect.right <= viewportWidth - 12,
                reachable,
                iconContained:
                  !icon ||
                  (icon.left >= rect.left &&
                    icon.right <= rect.right &&
                    icon.top >= rect.top &&
                    icon.bottom <= rect.bottom),
              };
            }),
          width,
        );
        for (const action of actions) {
          expect(action, action.label ?? "touch control").toMatchObject({
            size: true,
            inset: true,
            reachable: true,
            iconContained: true,
          });
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
      await expectObserve(gateway, "gateway", true, 1);
      await expect.poll(() => panel.getAttribute("data-view-only")).toBe("false");

      const sizing = panel.getByRole("combobox", { name: "Desktop size", exact: true });
      await sizing.selectOption("actual");
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
    });
  });

  it("applies the optional control segment as the initial control request", async () => {
    for (const [route, expected] of [
      ["focus/desktop/source/gateway", false],
      ["focus/desktop/control/source/gateway", true],
    ] as const) {
      await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
        const { gateway } = await openDesktopDocument(page, route, {
          desktopObserve: observe(`control-${String(expected)}`, expected),
        });
        const request = await gateway.waitForRequest("desktop.observe");
        expect(request.params).toEqual({ source: { kind: "host" }, control: expected });
      });
    }
  });
});
