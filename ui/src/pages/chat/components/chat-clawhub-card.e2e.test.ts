import { writeFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../../../test-helpers/control-ui-e2e-artifacts.ts";
import {
  takeControlUiScreenshotFrame,
  takeControlUiViewportScreenshot,
  waitForControlUiFrameLayout,
} from "../../../test-helpers/control-ui-e2e-screenshot.ts";
import {
  captureScreenshot,
  calendarDiscoveryPlugin,
  calendarInspection,
  calendarPlugin,
  inventory,
  describeControlUiE2e,
  enabledWorkboardCapabilities,
  installMockGateway,
  mobileViewport,
  newContext,
  pluginMethodResponses,
  pluginMethods,
  server,
  setupPluginsE2e,
  teardownPluginsE2e,
} from "../../plugins/plugins.e2e.test-support.ts";

// Exercise the application store, subscription and mounted transcript together.
// The Gateway publishes the same event for every plugin install entry point.
describeControlUiE2e("Chat plugin installation status", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it("updates mounted recommendations without navigation or reconnect", async () => {
    const context = await newContext(mobileViewport);
    const page = await context.newPage();
    const recommendations = ["calendar", "travel-themes"].map((id) => ({
      type: "clawhub",
      kind: "plugin",
      id: "ch_" + id,
      name: id === "calendar" ? "Calendar" : "Travel Themes",
      official: id === "calendar",
      installed: false,
    }));
    const details = (installed: boolean) => ({
      cases: recommendations.map((card) => ({
        match: { id: card.id },
        response: {
          plugin: {
            id: card.id,
            catalog: { name: card.name, official: card.official, categories: [] },
            local: { installed, action: installed ? "manage" : "install" },
          },
          detail: { packageName: "@openclaw/" + card.id.slice(3) },
        },
      })),
    });
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      historyMessages: [
        { role: "assistant", content: recommendations, timestamp: 1_780_000_000_000 },
      ],
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.catalog.get": details(false),
      },
    });
    try {
      await page.goto(server.baseUrl + "chat");
      const cards = page.locator("openclaw-chat-clawhub-card");
      await expect.poll(() => cards.locator(".chat-clawhub-card__install").count()).toBe(2);
      const mounted = await cards.first().elementHandle();
      const connects = (await gateway.getRequests("connect")).length;
      if (process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1") {
        const artifactDir = createControlUiE2eArtifactDir("chat-plugin-actions");
        const surface = cards.last();
        const frame = await takeControlUiScreenshotFrame(
          page,
          surface,
          [
            surface.getByText("Travel Themes", { exact: true }),
            surface.locator(".chat-clawhub-card__install"),
          ],
          { animations: "disabled", elements: [surface], scrollTo: surface },
        );
        await writeFile(artifactDir + "/page.png", frame.png);
        await writeFile(artifactDir + "/travel-themes.png", frame.elements[0]!.png);
      }
      expect(await cards.getByRole("button", { name: "Dismiss", exact: true }).count()).toBe(0);
      expect(await cards.getByRole("button", { name: "Install", exact: true }).count()).toBe(2);
      // The official card installs where it is; the chat stays open.
      await gateway.deferNext("plugins.install");
      await cards.first().getByRole("button", { name: "Install", exact: true }).click();
      const install = await gateway.waitForRequest("plugins.install");
      expect(install.params).toEqual({ source: "clawhub", packageName: "@openclaw/calendar" });
      await cards.first().getByRole("button", { name: "Installing", exact: true }).waitFor();
      expect(page.url()).not.toContain("/plugins");
      await captureScreenshot(page, "chat-plugin-card-installing.png", "viewport");
      await gateway.setMethodResponse("plugins.catalog.get", details(true));
      await gateway.resolveDeferred("plugins.install", {
        ok: true,
        plugin: calendarPlugin,
        restartRequired: false,
      });
      await cards.first().locator(".chat-clawhub-card__installed").waitFor();
      expect(page.url()).not.toContain("/plugins");
      expect(await gateway.getRequests("plugins.install")).toHaveLength(1);
      await gateway.setMethodResponse("plugins.uiDescriptors", enabledWorkboardCapabilities());
      await gateway.emitGatewayEvent("plugins.changed", { generation: 1 });
      await expect.poll(() => cards.locator(".chat-clawhub-card__installed").count()).toBe(2);
      expect(await cards.locator(".chat-clawhub-card__install").count()).toBe(0);
      expect(await cards.locator(".chat-clawhub-card__dismiss").count()).toBe(0);
      expect(await mounted!.evaluate((element) => element.isConnected)).toBe(true);
      expect(await gateway.getRequests("connect")).toHaveLength(connects);
      expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
      await captureScreenshot(page, "chat-plugin-cards-after.png", "viewport");
    } finally {
      await context.close();
    }
  });

  it("keeps plugin and skill recommendations compact with verification beside the author", async () => {
    const context = await newContext({ width: 1440, height: 900 });
    const page = await context.newPage();
    const recommendations = [
      {
        type: "clawhub",
        kind: "plugin",
        id: "ch_granola",
        name: "Granola",
        official: true,
        installed: false,
      },
      {
        type: "clawhub",
        kind: "skill",
        id: "@openclaw/weather",
        skillRef: "@openclaw/weather",
        registry: "https://clawhub.ai",
        name: "Weather",
        official: true,
        installed: false,
      },
    ];
    const gateway = await installMockGateway(page, {
      featureMethods: [...pluginMethods, "skills.detail", "skills.status"],
      historyMessages: [
        { role: "assistant", content: recommendations, timestamp: 1_780_000_000_000 },
      ],
      methodResponses: {
        ...pluginMethodResponses(),
        "plugins.catalog.get": {
          plugin: {
            id: "ch_granola",
            catalog: { name: "Granola", author: "openclaw", official: true, categories: [] },
            local: { installed: false, action: "install" },
          },
          detail: { packageName: "@openclaw/granola" },
        },
        "skills.detail": {
          skill: { slug: "weather", displayName: "Weather", isOfficial: true },
          owner: { handle: "openclaw" },
        },
        "skills.status": { skills: [] },
      },
    });
    const artifacts =
      process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1"
        ? createControlUiE2eArtifactDir("compact-install-cards")
        : undefined;
    try {
      await page.goto(server.baseUrl + "chat");
      const cards = page.locator(".chat-clawhub-card");
      await expect.poll(() => cards.locator(".chat-clawhub-card__install").count()).toBe(2);
      for (const width of [1440, 1366, 768, 390]) {
        await page.setViewportSize({ width, height: 900 });
        if (artifacts) {
          const frame = await takeControlUiScreenshotFrame(
            page,
            cards.first(),
            [cards.first().getByText("Ready to install", { exact: true })],
            {
              animations: "disabled",
              elements: [cards.first(), cards.last()],
              scrollTo: cards.first(),
            },
          );
          await writeFile(artifacts + "/" + width + "-page.png", frame.png);
          for (const [index, kind] of ["plugin", "skill"].entries()) {
            await writeFile(
              artifacts + "/" + width + "-" + kind + ".png",
              frame.elements[index]!.png,
            );
          }
        }
        for (const card of await cards.all()) {
          const metrics = await card.evaluate((element) => {
            const button = element.querySelector<HTMLElement>(".chat-clawhub-card__install")!;
            const author = element.querySelector<HTMLElement>(".plugin-card-author")!;
            const badge = element.querySelector<HTMLElement>(".plugin-official-badge")!;
            const style = getComputedStyle(element);
            const buttonStyle = getComputedStyle(button);
            const authorBox = author.getBoundingClientRect();
            const badgeBox = badge.getBoundingClientRect();
            return {
              padding: Number.parseFloat(style.paddingTop),
              buttonPadding: Number.parseFloat(buttonStyle.paddingInlineStart),
              buttonHeight: button.getBoundingClientRect().height,
              authorGap: badgeBox.left - authorBox.right,
              sameLine:
                Math.abs(
                  badgeBox.top + badgeBox.height / 2 - authorBox.top - authorBox.height / 2,
                ) < 2,
              overflow: element.scrollWidth > element.clientWidth,
            };
          });
          expect(metrics.padding).toBeLessThanOrEqual(16);
          expect(metrics.buttonPadding).toBeLessThanOrEqual(12);
          // Browser geometry can round CSS dimensions a few millionths below their size.
          const buttonHeightRoundingTolerancePx = 0.01;
          expect(metrics.buttonHeight).toBeGreaterThanOrEqual(32 - buttonHeightRoundingTolerancePx);
          expect(metrics.buttonHeight).toBeLessThanOrEqual(34 + buttonHeightRoundingTolerancePx);
          expect(metrics.authorGap).toBeGreaterThanOrEqual(0);
          expect(metrics.authorGap).toBeLessThanOrEqual(4);
          expect(metrics.sameLine).toBe(true);
          expect(metrics.overflow).toBe(false);
        }
      }
      expect(await gateway.getRequests("plugins.install")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("presents only authoritative lifecycle states and keeps recovery and navigation usable", async () => {
    const artifactDir =
      process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1"
        ? createControlUiE2eArtifactDir("chat-plugin-lifecycle")
        : undefined;
    const states = [
      { id: "available", installed: false, status: "Ready to install", action: "Install" },
      { id: "installed", installed: true, status: "Installed", action: "Manage" },
      {
        id: "sign-in",
        installed: true,
        auth: "requires-authorization",
        status: "Installed · Sign in needed",
        action: "Connect",
      },
      {
        id: "connecting",
        installed: true,
        auth: "pending-authorization",
        status: "Waiting for authorization",
        action: "Manage",
      },
      {
        id: "connected",
        installed: true,
        auth: "authorized",
        status: "Connected",
        action: "Manage",
      },
      {
        id: "signed-out",
        installed: true,
        auth: "unauthenticated",
        status: "Installed · Sign in needed",
        action: "Connect",
      },
      { id: "disabled", installed: true, disabled: true, status: "Disabled", action: "Manage" },
      {
        id: "unavailable",
        installed: false,
        unavailable: true,
        status: "Unavailable",
        action: "Details",
      },
      {
        id: "restricted",
        installed: false,
        restricted: true,
        status: "Permission required",
        action: "Details",
      },
    ];
    let desktopWidth: number | undefined;
    for (const state of states) {
      const context = await newContext({ width: 1280, height: 900 });
      const page = await context.newPage();
      const card = {
        type: "clawhub",
        kind: "plugin",
        id: "ch_calendar",
        name: "Calendar",
        official: true,
        installed: false,
      };
      const detail = {
        plugin: {
          id: card.id,
          catalog: { name: card.name, author: "openclaw", official: true, categories: [] },
          local: {
            present: state.installed,
            installed: state.installed,
            enabled: !state.disabled,
            state: state.disabled ? "disabled" : state.installed ? "enabled" : "not-installed",
            pluginId: state.installed ? "calendar" : undefined,
            action: state.unavailable ? "unavailable" : state.installed ? "manage" : "install",
          },
        },
        detail: { packageName: "@openclaw/calendar" },
      };
      const gateway = await installMockGateway(page, {
        featureMethods: [...pluginMethods, "mcp.authLogin"],
        operatorScopes: state.restricted ? ["operator.read"] : undefined,
        historyMessages: [{ role: "assistant", content: [card], timestamp: 1_780_000_000_000 }],
        methodResponses: {
          ...pluginMethodResponses(),
          "plugins.catalog.get": detail,
          "plugins.inspect": {
            plugin: { id: "calendar", name: "Calendar", installed: true, enabled: true },
            mcpAuth: state.auth ? [{ serverName: "calendar", state: state.auth }] : [],
          },
        },
      });
      try {
        await page.goto(server.baseUrl + "chat");
        const surface = page.locator("openclaw-chat-clawhub-card");
        const status = surface.locator(".chat-clawhub-card__status");
        await surface.getByRole("button", { name: state.action, exact: true }).waitFor();
        await expect.poll(() => status.textContent()).toBe(state.status);
        expect(await surface.getByRole("button", { name: "Dismiss", exact: true }).count()).toBe(0);
        expect(await surface.locator(".chat-clawhub-card__status .btn__spinner").count()).toBe(
          state.id === "connecting" ? 1 : 0,
        );
        expect(
          await surface
            .locator(".chat-clawhub-card")
            .evaluate((element) => getComputedStyle(element).borderRadius),
        ).toBe("27px");
        const width = (await surface.boundingBox())!.width;
        desktopWidth ??= width;
        expect(width).toBe(desktopWidth);
        if (state.id === "connecting") {
          expect(
            await status
              .locator(".btn__spinner")
              .evaluate((element) => getComputedStyle(element).animationName),
          ).not.toBe("none");
        }
        if (artifactDir) {
          const frame = await takeControlUiScreenshotFrame(
            page,
            surface,
            [surface.getByRole("button", { name: state.action, exact: true })],
            { animations: "disabled", elements: [surface], scrollTo: surface },
          );
          await writeFile(artifactDir + "/" + state.id + ".png", frame.png);
          await writeFile(artifactDir + "/" + state.id + "-card.png", frame.elements[0]!.png);
        }
        if (state.id === "available") {
          // A held status refresh is a real read, not a fabricated installation state.
          await gateway.setMethodDelay("plugins.catalog.get", "forever");
          await gateway.setMethodResponse("plugins.uiDescriptors", {
            ...enabledWorkboardCapabilities(),
            generation: 2,
          });
          await gateway.emitGatewayEvent("plugins.changed", { generation: 2 });
          await expect.poll(() => status.textContent()).toBe("Checking installation");
          expect(await status.locator(".btn__spinner").count()).toBe(1);
          if (artifactDir) {
            const frame = await takeControlUiScreenshotFrame(page, surface, [status], {
              animations: "disabled",
              elements: [surface],
            });
            await writeFile(artifactDir + "/checking.png", frame.png);
            await writeFile(artifactDir + "/checking-card.png", frame.elements[0]!.png);
          }
          await gateway.setMethodResponse("plugins.catalog.get", {
            __mockError: { code: "UNAVAILABLE", message: "Catalog temporarily unavailable" },
          });
          await gateway.setMethodDelay("plugins.catalog.get", null);
          await expect.poll(() => status.textContent()).toBe("Status unavailable");
          if (artifactDir) {
            await page.screenshot({
              path: artifactDir + "/service-unavailable.png",
              animations: "disabled",
            });
          }
          await gateway.setMethodResponse("plugins.catalog.get", detail);
          await surface.getByRole("button", { name: "Retry", exact: true }).click();
          await surface.getByRole("button", { name: "Install", exact: true }).waitFor();
          await gateway.setOnline(false);
          await expect.poll(() => status.textContent()).toBe("Status unavailable");
          expect(await status.locator(".btn__spinner").count()).toBe(0);
          if (artifactDir) {
            await page.screenshot({ path: artifactDir + "/offline.png", animations: "disabled" });
          }
          await surface.getByRole("button", { name: "Retry", exact: true }).click();
          await gateway.setOnline(true);
          await surface.getByRole("button", { name: "Install", exact: true }).waitFor();
          await page.setViewportSize(mobileViewport);
          expect(
            await surface
              .locator(".chat-clawhub-card")
              .evaluate((element) => getComputedStyle(element).borderRadius),
          ).toBe("20px");
          const identity = await surface.locator(".chat-clawhub-card__listing").boundingBox();
          const actions = await surface.locator(".chat-clawhub-card__actions").boundingBox();
          expect(actions!.y).toBeGreaterThanOrEqual(identity!.y + identity!.height);
          if (artifactDir) {
            const frame = await takeControlUiScreenshotFrame(
              page,
              surface,
              [surface.getByRole("button", { name: "Install", exact: true })],
              { animations: "disabled", elements: [surface], scrollTo: surface },
            );
            await writeFile(artifactDir + "/mobile.png", frame.png);
          }
        }
        // Details and the title both retain the canonical plugin-page navigation.
        await surface.getByRole("button", { name: "Details", exact: true }).click();
        await page.waitForURL("**/plugins/ch_calendar");
        expect(await gateway.getRequests("plugins.install")).toHaveLength(0);
        expect(await gateway.getRequests("mcp.authLogin")).toHaveLength(0);
      } finally {
        await context.close();
      }
    }
  });
  it("keeps canonical install progress, failure and retry visible after returning to chat", async () => {
    const context = await newContext({ width: 1280, height: 900 });
    const page = await context.newPage();
    const card = {
      type: "clawhub",
      kind: "plugin",
      id: calendarDiscoveryPlugin.id,
      name: "Calendar Plus",
      official: false,
      installed: false,
    };
    const gateway = await installMockGateway(page, {
      featureMethods: pluginMethods,
      historyMessages: [{ role: "assistant", content: [card], timestamp: 1_780_000_000_000 }],
      methodResponses: pluginMethodResponses(),
    });
    const artifacts =
      process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1"
        ? createControlUiE2eArtifactDir("chat-plugin-install-transitions")
        : undefined;
    const surface = page.locator("openclaw-chat-clawhub-card");
    const capture = async (name: string) => {
      if (!artifacts) {
        return;
      }
      const frame = await takeControlUiScreenshotFrame(
        page,
        surface,
        [surface.locator(".chat-clawhub-card__status")],
        { animations: "disabled", elements: [surface], scrollTo: surface },
      );
      await writeFile(artifacts + "/" + name + ".png", frame.png);
      await writeFile(artifacts + "/" + name + "-card.png", frame.elements[0]!.png);
    };
    try {
      await page.goto(server.baseUrl + "chat");
      for (let attempt = 0; attempt < 2; attempt++) {
        await gateway.deferNext("plugins.install");
        await surface
          .getByRole("button", { name: attempt ? "Retry" : "Install", exact: true })
          .click();
        await page.locator(".plugin-catalog-detail__install").click();
        const request = await gateway.waitForRequest("plugins.install", { after: attempt });
        await page.goBack();
        await surface.getByRole("button", { name: "Installing", exact: true }).waitFor();
        expect(
          await surface.getByRole("button", { name: "Installing", exact: true }).isDisabled(),
        ).toBe(true);
        expect(await surface.locator(".chat-clawhub-card__status").textContent()).toBe(
          "Installing",
        );
        const spinner = surface.locator(".chat-clawhub-card__status .btn__spinner");
        const spinnerBounds = (await spinner.boundingBox())!;
        expect(spinnerBounds.width).toBeGreaterThan(8);
        expect(Math.abs(spinnerBounds.width - spinnerBounds.height)).toBeLessThan(1);
        expect(
          await spinner.evaluate((element) => getComputedStyle(element).animationName),
        ).not.toBe("none");
        expect(await surface.locator(".chat-clawhub-card").getAttribute("aria-busy")).toBe("true");
        await gateway.emitGatewayEvent("plugins.install.progress", {
          requestId: request.id,
          activityId: "download",
          stage: "download",
          status: "started",
        });
        if (!attempt) {
          await capture("installing");
          await gateway.rejectDeferred("plugins.install", {
            code: "INVALID_REQUEST",
            message: "Registry rejected the download.",
          });
          await surface.getByRole("button", { name: "Retry", exact: true }).waitFor();
          expect(await surface.locator(".chat-clawhub-card__status").textContent()).toBe(
            "Installation failed",
          );
          await capture("install-failed");
        } else {
          const installed = { ...calendarPlugin, catalogId: card.id };
          await gateway.setMethodResponse("plugins.list", inventory([installed]));
          await gateway.setMethodResponse("plugins.catalog.get", {
            plugin: {
              ...calendarDiscoveryPlugin,
              local: {
                installed: true,
                present: true,
                enabled: true,
                state: "enabled",
                pluginId: installed.id,
                action: "manage",
              },
            },
          });
          await gateway.resolveDeferred("plugins.install", {
            ok: true,
            plugin: installed,
            restartRequired: false,
          });
          await surface.getByRole("button", { name: "Manage", exact: true }).waitFor();
          expect(await surface.locator(".chat-clawhub-card__status").textContent()).toBe(
            "Installed",
          );
          await capture("install-recovered");
        }
      }
      expect(await gateway.getRequests("plugins.install")).toHaveLength(2);
      expect(await gateway.getRequests("gateway.restart.request")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("runs the existing MCP wizard inline through cancellation, expiry, retry and success", async () => {
    const context = await newContext({ width: 1280, height: 900 });
    await context.route("https://authorization.example/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "Synthetic authorization service" }),
    );
    const page = await context.newPage();
    const card = {
      type: "clawhub",
      kind: "plugin",
      id: "ch_calendar",
      name: "Calendar",
      official: true,
      installed: true,
    };
    const inspection = (state: string) => ({
      ...calendarInspection,
      plugin: { ...calendarPlugin, installed: true },
      mcpAuth: [{ serverName: "calendar", state }],
    });
    const gateway = await installMockGateway(
      page,
      {
        featureMethods: [
          ...pluginMethods,
          "mcp.authLogin",
          "wizard.next",
          "wizard.cancel",
          "wizard.status",
        ],
        heldMethods: ["wizard.next"],
        historyMessages: [{ role: "assistant", content: [card], timestamp: 1_780_000_000_000 }],
        methodResponses: {
          ...pluginMethodResponses(),
          "plugins.catalog.get": {
            plugin: {
              id: card.id,
              catalog: { name: card.name, official: true, categories: [] },
              local: {
                installed: true,
                present: true,
                enabled: true,
                state: "enabled",
                pluginId: calendarPlugin.id,
                action: "manage",
              },
            },
          },
          "plugins.inspect": inspection("requires-authorization"),
          "wizard.cancel": { status: "cancelled" },
          "wizard.status": { status: "cancelled" },
        },
      },
      {
        requestHandlers: {
          "mcp.authLogin": (params) => {
            if (!params || typeof params !== "object" || !("sessionId" in params)) {
              throw new Error("Missing wizard admission");
            }
            return { sessionId: params.sessionId, done: false, status: "running" };
          },
        },
      },
    );
    const artifacts =
      process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1"
        ? createControlUiE2eArtifactDir("chat-plugin-auth-transitions")
        : undefined;
    const surface = page.locator("openclaw-chat-clawhub-card");
    const capture = async (name: string) => {
      if (!artifacts) {
        return;
      }
      await waitForControlUiFrameLayout([surface]);
      const bounds = await surface.boundingBox();
      const frame = await takeControlUiViewportScreenshot(page, surface, [
        surface.locator(".chat-clawhub-card__status"),
      ]);
      expect(await surface.boundingBox()).toEqual(bounds);
      await writeFile(artifacts + "/" + name + ".png", frame);
      await writeFile(artifacts + "/" + name + "-bounds.json", JSON.stringify(bounds));
    };
    try {
      await page.goto(server.baseUrl + "chat");
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = (await gateway.getRequests("wizard.next")).length;
        await surface
          .getByRole("button", { name: attempt ? "Retry" : "Connect", exact: true })
          .click();
        const request = await gateway.waitForRequest("wizard.next", { after: before });
        if (
          !request.params ||
          typeof request.params !== "object" ||
          !("sessionId" in request.params)
        ) {
          throw new Error("Missing admitted wizard session");
        }
        const match = { sessionId: request.params.sessionId };
        await gateway.resolveDeferred(
          "wizard.next",
          {
            done: false,
            status: "running",
            step: {
              id: "browser",
              type: "note",
              externalUrl: "https://authorization.example/connect",
              message: "Continue in your browser.",
            },
          },
          { match },
        );
        await gateway.waitForRequest("wizard.next", { after: before + 1 });
        await surface.getByRole("link", { name: "Reopen authorization", exact: true }).waitFor();
        expect(await surface.locator(".chat-clawhub-card__status").textContent()).toBe(
          "Waiting for authorization",
        );
        expect(await surface.locator(".chat-clawhub-card__status .btn__spinner").count()).toBe(1);
        if (!attempt) {
          await capture("connecting");
          await page.setViewportSize(mobileViewport);
          await waitForControlUiFrameLayout([surface]);
          await capture("connecting-mobile");
          const actions = (await surface.locator(".chat-clawhub-card__actions").boundingBox())!;
          const cardBounds = (await surface.boundingBox())!;
          expect(actions.x + actions.width).toBeLessThanOrEqual(cardBounds.x + cardBounds.width);
          await page.setViewportSize({ width: 1280, height: 900 });
          await surface.getByRole("button", { name: "Cancel", exact: true }).click();
          await surface.getByRole("button", { name: "Retry", exact: true }).waitFor();
          await expect
            .poll(() => surface.locator(".chat-clawhub-card__status").textContent())
            .toBe("Connection canceled");
          await capture("connection-canceled");
        } else if (attempt === 1) {
          await gateway.rejectDeferred(
            "wizard.next",
            {
              code: "INVALID_REQUEST",
              message: "Wizard expired",
              details: { code: "WIZARD_NOT_FOUND" },
            },
            { match },
          );
          await surface.getByRole("button", { name: "Retry", exact: true }).waitFor();
          await expect
            .poll(() => surface.locator(".chat-clawhub-card__status").textContent())
            .toBe("Connection expired");
          await capture("connection-expired");
        } else {
          await gateway.setMethodResponse("plugins.inspect", inspection("authorized"));
          await gateway.resolveDeferred("wizard.next", { done: true, status: "done" }, { match });
          await surface.getByRole("button", { name: "Manage", exact: true }).waitFor();
          await expect
            .poll(() => surface.locator(".chat-clawhub-card__status").textContent())
            .toBe("Connected");
          await capture("connection-recovered");
        }
      }
      expect(await gateway.getRequests("mcp.authLogin")).toHaveLength(3);
      expect(await gateway.getRequests("wizard.cancel")).not.toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
