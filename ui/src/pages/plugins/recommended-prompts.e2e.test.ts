import { writeFileSync } from "node:fs";
import type { Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { waitForCommittedComposerDraft } from "../../e2e/settle.test-support.ts";
import type { PluginCatalogItem } from "../../lib/plugins/index.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { evaluateControlUiContext } from "../../test-helpers/control-ui-e2e-context.ts";
import { takeControlUiScreenshotFrame } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, waitForControlUiRoute } from "../../test-helpers/control-ui-e2e.ts";
import {
  calendarDiscoveryPlugin,
  calendarInspection,
  calendarPlugin,
  describeControlUiE2e,
  initialInventory,
  installMockGateway,
  inventory,
  mobileViewport,
  newContext,
  pluginMethodResponses,
  pluginMethods,
  server,
  setupPluginsE2e,
  teardownPluginsE2e,
} from "./plugins.e2e.test-support.ts";

// Browser + mock Gateway boundary proof, not real plugin installation/runtime proof.
const prompts = [
  "Plan my week — keep the author's exact wording & punctuation.",
  "Find free time for a project review.",
  "Summarize tomorrow’s meetings.\nKeep preparation notes separate.",
];
const installed = {
  ...calendarPlugin,
  catalogId: calendarDiscoveryPlugin.id,
  recommendedPrompts: prompts,
};
const detail = {
  plugin: calendarDiscoveryPlugin,
  detail: {
    origin: "clawhub",
    packageName: "calendar-plus",
    topics: [],
    configuration: [],
    mcpServers: [],
    skills: [],
    versions: [],
    recommendedPrompts: prompts,
  },
};
const methods = [
  ...pluginMethods,
  "sessions.create",
  "chat.send",
  "chat.history",
  "users.mentionable",
];
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const recommendation = (page: Page) => page.locator(".plugin-recommended-prompts__prompt");
const composer = (page: Page) => page.getByRole("textbox", { name: "Chat composer", exact: true });
const navigate = (page: Page, pathname: string) =>
  evaluateControlUiContext(
    page,
    (app, path) => app.navigate("plugins", { pathname: path }),
    pathname,
  );

function responses(plugin: PluginCatalogItem = installed) {
  return {
    ...pluginMethodResponses(),
    "plugins.catalog.get": detail,
    "plugins.inspect": { ...calendarInspection, plugin },
    "users.mentionable": { users: [], truncated: false },
  };
}

async function proof(page: Page, stage: string) {
  if (!capture) {
    return;
  }
  const dir = createControlUiE2eArtifactDir(`recommended-prompts-${stage}`);
  for (const viewport of [1440, 1366, 768, 390].map((width) => ({
    width,
    height: width === 390 ? mobileViewport.height : 1000,
  }))) {
    const panel = page.locator(".plugin-recommended-prompts");
    const content = (await panel.count()) ? [panel] : [composer(page)];
    const frame = await takeControlUiScreenshotFrame(
      page,
      page.locator("#control-ui-main"),
      content,
      {
        animations: "disabled",
        viewport,
        scrollTo: content[0],
      },
    );
    writeFileSync(`${dir}/${stage}-${viewport.width}.png`, frame.png);
  }
}

async function expectUnsent(
  page: Page,
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  prompt = prompts[0],
) {
  await expect.poll(() => composer(page).inputValue()).toBe(`@calendar-plus ${prompt}`);
  await waitForControlUiRoute(page, { routeId: "chat" });
  expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
  expect(await gateway.getRequests("chat.send")).toHaveLength(0);
  expect(await gateway.getRequests("sessions.dispatch")).toHaveLength(0);
  const overlay = page.locator(".agent-chat__plugin-draft-overlay");
  await overlay.waitFor();
  await expect.poll(() => overlay.textContent()).toBe(`@calendar-plus ${prompt}`);
  const people = page.getByRole("listbox", { name: "Mention a person", exact: true });
  expect((await composer(page).getAttribute("aria-controls")) ?? "").not.toContain(
    "mention-menu-listbox",
  );
  expect(await people.count()).toBe(0);
  await composer(page).focus();
  await composer(page).press("ControlOrMeta+End");
  await page.keyboard.insertText(" Edited before sending.");
  await expect
    .poll(() => composer(page).inputValue())
    .toBe(`@calendar-plus ${prompt} Edited before sending.`);
  expect((await composer(page).getAttribute("aria-controls")) ?? "").not.toContain(
    "mention-menu-listbox",
  );
  expect(await people.count()).toBe(0);
  expect(await gateway.getRequests("chat.send")).toHaveLength(0);
}

describeControlUiE2e("recommended plugin prompts (mock Gateway boundary)", () => {
  beforeAll(setupPluginsE2e);
  afterAll(teardownPluginsE2e);

  it("omits absent metadata, keeps header/actions, waits for install and preserves another chat draft", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: methods,
      methodResponses: {
        ...responses(),
        "plugins.catalog.get": {
          ...detail,
          detail: { ...detail.detail, recommendedPrompts: undefined },
        },
      },
    });
    try {
      await page.goto(`${server.baseUrl}plugins/${calendarDiscoveryPlugin.id}`);
      await page.getByRole("button", { name: "Install", exact: true }).waitFor();
      expect(await page.locator(".plugin-recommended-prompts").count()).toBe(0);
      expect(await page.locator(".plugin-catalog-detail__summary").textContent()).toBe(
        calendarPlugin.description,
      );
      await gateway.setMethodResponse("plugins.catalog.get", detail);
      await page.goto(controlUiSessionUrl(server.baseUrl, "agent:main:main"));
      await composer(page).fill("Existing private planning draft");
      await waitForCommittedComposerDraft(
        page,
        "chat:v3:agent:main:main\u0000agent:main",
        "Existing private planning draft",
        0,
      );
      await navigate(page, `/plugins/${calendarDiscoveryPlugin.id}`);
      await recommendation(page).first().waitFor();
      expect(await recommendation(page).count()).toBe(3);
      expect(
        await recommendation(page)
          .locator(".plugin-recommended-prompts__text > span:last-child")
          .allTextContents(),
      ).toEqual(prompts);
      expect(
        await recommendation(page)
          .first()
          .locator(".plugin-prompt-mention > span:last-child")
          .textContent(),
      ).toBe("Calendar Plus");
      const geometry = await page.locator(".plugin-recommended-prompts").evaluate((panel) => {
        const background = getComputedStyle(
          panel.querySelector(".plugin-recommended-prompts__prompt")!,
        ).backgroundColor;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const paint = canvas.getContext("2d")!;
        paint.fillStyle = "white";
        paint.fillRect(0, 0, 1, 1);
        paint.fillStyle = background;
        paint.fillRect(0, 0, 1, 1);
        const channels = [...paint.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return {
          inMain: panel.parentElement?.classList.contains("plugin-catalog-detail__main"),
          afterHeader: panel
            .closest(".plugin-catalog-detail__content")
            ?.previousElementSibling?.classList.contains("plugin-catalog-detail__hero"),
          white: getComputedStyle(
            panel.querySelector(".plugin-recommended-prompts__text > span:last-child")!,
          ).color,
          fits: panel.scrollWidth <= panel.clientWidth,
          contrast:
            1.05 / (0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]! + 0.05),
        };
      });
      await proof(page, "before-install");
      expect(geometry).toMatchObject({
        inMain: true,
        afterHeader: true,
        white: "rgb(255, 255, 255)",
        fits: true,
      });
      expect(geometry.contrast).toBeGreaterThanOrEqual(4.5);
      await gateway.deferNext("plugins.install");
      await recommendation(page).first().click();
      expect((await gateway.waitForRequest("plugins.install")).params).toEqual({
        source: "clawhub",
        packageName: "calendar-plus",
      });
      await expect
        .poll(() => page.locator('.plugin-recommended-prompts__list[aria-busy="true"]').count())
        .toBe(1);
      expect(await recommendation(page).first().isDisabled()).toBe(true);
      const spinner = recommendation(page).first().locator(".btn__spinner");
      expect(await spinner.isVisible()).toBe(true);
      expect(await spinner.evaluate((el) => getComputedStyle(el).animationName)).not.toBe("none");
      await recommendation(page)
        .first()
        .evaluate((button: HTMLButtonElement) => {
          button.click();
          button.click();
        });
      expect(await gateway.getRequests("plugins.install")).toHaveLength(1);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await proof(page, "install-pending");
      const needsSetup = { ...installed, enabled: false, state: "needs-setup" as const };
      await gateway.setMethodResponse(
        "plugins.list",
        inventory([...initialInventory.plugins, needsSetup], 1),
      );
      await gateway.resolveDeferred("plugins.install", {
        ok: true,
        plugin: needsSetup,
        restartRequired: false,
      });
      await expectUnsent(page, gateway);
      expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(0);
      await proof(page, "after-install-editable");
      const existingPath = new URL(controlUiSessionUrl(server.baseUrl, "agent:main:main")).pathname;
      await evaluateControlUiContext(
        page,
        (app, pathname) => app.navigate("chat", { pathname }),
        existingPath,
      );
      await expect.poll(() => composer(page).inputValue()).toBe("Existing private planning draft");
    } finally {
      await context.close();
    }
  });

  it("keeps chat-creation failure visible after installation changes to the runtime identity", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: methods,
      methodResponses: {
        ...responses(),
        "sessions.create": {
          __mockError: { code: "UNAVAILABLE", message: "Synthetic chat creation failed" },
        },
      },
    });
    try {
      await page.goto(`${server.baseUrl}plugins/${calendarDiscoveryPlugin.id}`);
      await gateway.deferNext("plugins.install");
      await recommendation(page).first().click();
      await gateway.waitForRequest("plugins.install");
      await gateway.setMethodResponse("plugins.list", inventory([installed], 1));
      await gateway.resolveDeferred("plugins.install", {
        ok: true,
        plugin: installed,
        restartRequired: false,
      });
      await gateway.waitForRequest("sessions.create");
      await page.getByRole("button", { name: "Disable Calendar Plus", exact: true }).waitFor();
      await expect.poll(() => recommendation(page).first().isEnabled()).toBe(true);
      expect(new URL(page.url()).pathname).toBe(`/plugins/${calendarDiscoveryPlugin.id}`);
      expect(await page.locator('.plugins-row-message[role="alert"]').allTextContents()).toEqual(
        expect.arrayContaining([expect.stringContaining("Synthetic chat creation failed")]),
      );
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("retains an install failure and lets recommendation retry open exactly one unsent chat", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: methods,
      methodResponses: responses(),
    });
    try {
      await page.goto(`${server.baseUrl}plugins/${calendarDiscoveryPlugin.id}`);
      await gateway.deferNext("plugins.install");
      await recommendation(page).first().click();
      await gateway.waitForRequest("plugins.install");
      await gateway.rejectDeferred("plugins.install", {
        code: "UNAVAILABLE",
        message: "Synthetic download failed",
        details: { pluginInstallRejected: true },
      });
      await page.locator('.plugins-row-message[role="alert"]').waitFor();
      await expect.poll(() => recommendation(page).first().isEnabled()).toBe(true);
      expect(new URL(page.url()).pathname).toBe(`/plugins/${calendarDiscoveryPlugin.id}`);
      expect(await page.getByRole("button", { name: "Retry install", exact: true }).count()).toBe(
        1,
      );
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await proof(page, "install-failure");
      await gateway.deferNext("plugins.install");
      await recommendation(page).first().click();
      await gateway.waitForRequest("plugins.install", { after: 1 });
      await gateway.setMethodResponse("plugins.list", inventory([installed], 1));
      await gateway.resolveDeferred("plugins.install", {
        ok: true,
        plugin: installed,
        restartRequired: false,
      });
      await expectUnsent(page, gateway);
      expect(await gateway.getRequests("plugins.install")).toHaveLength(2);
    } finally {
      await context.close();
    }
  });

  it("uses existing enable and capability-consent before creating an unsent chat", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const disabled = { ...installed, enabled: false, state: "disabled" as const };
    const gateway = await installMockGateway(page, {
      featureMethods: methods,
      methodResponses: { ...responses(disabled), "plugins.list": inventory([disabled]) },
    });
    try {
      await page.goto(`${server.baseUrl}settings/plugins/calendar-plus`);
      await gateway.deferNext("plugins.setEnabled");
      await recommendation(page).first().click();
      expect((await gateway.waitForRequest("plugins.setEnabled")).params).toEqual({
        pluginId: "calendar-plus",
        enabled: true,
      });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await gateway.rejectDeferred("plugins.setEnabled", {
        code: "INVALID_REQUEST",
        message: "Review new capabilities",
        details: {
          capabilityConsentCode: "PLUGIN_CAPABILITY_CONSENT_REQUIRED",
          pluginId: "calendar-plus",
          reviewToken: calendarInspection.reviewToken,
          widened: { tools: ["calendar_create"] },
        },
      });
      const dialog = page.locator("[data-plugin-consent]");
      await dialog.waitFor();
      await expect
        .poll(() =>
          dialog.getByRole("button", { name: "Enable Calendar Plus", exact: true }).isEnabled(),
        )
        .toBe(true);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect.poll(() => recommendation(page).first().isEnabled()).toBe(true);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
      await gateway.deferNext("plugins.setEnabled");
      await recommendation(page).first().click();
      await gateway.waitForRequest("plugins.setEnabled", { after: 1 });
      await gateway.rejectDeferred("plugins.setEnabled", {
        code: "INVALID_REQUEST",
        message: "Review new capabilities",
        details: {
          capabilityConsentCode: "PLUGIN_CAPABILITY_CONSENT_REQUIRED",
          pluginId: "calendar-plus",
          reviewToken: calendarInspection.reviewToken,
          widened: { tools: ["calendar_create"] },
        },
      });
      await dialog.waitFor();
      await expect
        .poll(() =>
          dialog.getByRole("button", { name: "Enable Calendar Plus", exact: true }).isEnabled(),
        )
        .toBe(true);
      await proof(page, "enable-consent");
      await gateway.deferNext("plugins.setEnabled");
      await dialog.getByRole("button", { name: "Enable Calendar Plus", exact: true }).click();
      expect((await gateway.waitForRequest("plugins.setEnabled", { after: 2 })).params).toEqual({
        pluginId: "calendar-plus",
        enabled: true,
        acknowledgeCapabilities: { reviewToken: calendarInspection.reviewToken },
      });
      await gateway.setMethodResponse("plugins.list", inventory([installed], 1));
      await gateway.resolveDeferred("plugins.setEnabled", {
        ok: true,
        plugin: installed,
        restartRequired: false,
      });
      await expectUnsent(page, gateway);
      expect(await gateway.getRequests("plugins.install")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("already-enabled recommendations create directly and deduplicate held session creation", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: methods,
      presenceUsers: [
        {
          self: true,
          id: "synthetic-viewer",
          identity: { type: "profile", id: "synthetic-viewer" },
          name: "Synthetic Viewer",
        },
      ],
      methodResponses: { ...responses(), "plugins.list": inventory([installed]) },
    });
    try {
      await page.goto(`${server.baseUrl}settings/plugins/calendar-plus`);
      await gateway.deferNext("sessions.create");
      await recommendation(page).nth(2).click();
      await gateway.waitForRequest("sessions.create");
      await recommendation(page)
        .nth(2)
        .evaluate((button: HTMLButtonElement) => {
          button.click();
          button.click();
        });
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(await gateway.getRequests("plugins.install")).toHaveLength(0);
      expect(await gateway.getRequests("plugins.setEnabled")).toHaveLength(0);
      await gateway.resolveDeferred("sessions.create");
      await expectUnsent(page, gateway, prompts[2]);
      await proof(page, "multiline-composer");
      // Meaningful negative control: this profile can open the real human picker,
      // but prefill/ordinary edits above did not. Never dismiss UI for proof captures.
      await page.setViewportSize({ width: 1440, height: 1000 });
      await composer(page).fill("");
      await page.keyboard.insertText("@");
      await page.getByRole("listbox", { name: "Mention a person", exact: true }).waitFor();
      await gateway.waitForRequest("users.mentionable");
    } finally {
      await context.close();
    }
  });

  it("keeps native text visible while multiline drafts scroll and during synthetic composition", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: methods,
      methodResponses: { ...responses(), "plugins.list": inventory([installed]) },
    });
    try {
      await page.goto(`${server.baseUrl}settings/plugins/calendar-plus`);
      await recommendation(page).first().click();
      await expectUnsent(page, gateway);
      const input = composer(page);
      const overlay = page.locator(".agent-chat__plugin-draft-overlay");
      const longDraft = `@calendar-plus ${Array.from({ length: 70 }, (_, index) => `Line ${index}: retain every editable author word.`).join("\n")}`;
      await input.fill(longDraft);
      await expect.poll(() => input.getAttribute("data-composer-overflow")).toBe("");
      expect(await input.evaluate((el) => getComputedStyle(el).color)).not.toBe("rgba(0, 0, 0, 0)");
      expect(await overlay.isVisible()).toBe(false);
      expect(
        await input.evaluate((el: HTMLTextAreaElement) => {
          el.scrollTop = el.scrollHeight;
          el.dispatchEvent(new Event("scroll", { bubbles: true }));
          return el.scrollTop > 0;
        }),
      ).toBe(true);
      expect(await input.inputValue()).toBe(longDraft);
      const shortDraft = "@calendar-plus Short editable draft.";
      await input.fill(shortDraft);
      await expect.poll(() => input.getAttribute("data-composer-overflow")).toBeNull();
      await expect.poll(() => overlay.isVisible()).toBe(true);
      await input.focus();
      // Synthetic DOM events prove native visibility ownership, not an OS IME session.
      const composition = await input.evaluate((el) => {
        el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "に" }));
        return { composing: el.hasAttribute("data-composing"), color: getComputedStyle(el).color };
      });
      expect(composition.composing).toBe(true);
      expect(composition.color).not.toBe("rgba(0, 0, 0, 0)");
      await input.evaluate((el) =>
        el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "に" })),
      );
      await expect.poll(() => input.getAttribute("data-composing")).toBeNull();
      await expect.poll(() => overlay.isVisible()).toBe(true);
      await input.evaluate((el: HTMLTextAreaElement) => {
        el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "に" }));
        el.blur();
      });
      await expect.poll(() => input.getAttribute("data-composing")).toBeNull();
      expect(await input.inputValue()).toBe(shortDraft);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("does not follow a superseded agent selection after session creation was submitted", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: methods,
      methodResponses: {
        ...responses(),
        "plugins.list": inventory([installed]),
        "agents.list": {
          agents: [
            { id: "main", name: "Main" },
            { id: "other", name: "Other" },
          ],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
      },
    });
    try {
      await page.goto(`${server.baseUrl}settings/plugins/calendar-plus`);
      await gateway.deferNext("sessions.create");
      await recommendation(page).first().click();
      await gateway.waitForRequest("sessions.create");
      await evaluateControlUiContext(page, (app) => app.agentSelection.set("other"));
      expect(
        await evaluateControlUiContext(page, (app) => app.agentSelection.state.selectedId),
      ).toBe("other");
      const lists = (await gateway.getRequests("sessions.list")).length;
      await gateway.resolveDeferred("sessions.create");
      await gateway.waitForRequest("sessions.list", { after: lists });
      await expect
        .poll(async () => {
          if (new URL(page.url()).pathname.startsWith("/chat/")) {
            return true;
          }
          return recommendation(page).first().isEnabled();
        })
        .toBe(true);
      expect(new URL(page.url()).pathname).toBe("/settings/plugins/calendar-plus");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("permanently retires a held chat launch after leaving and returning to its plugin page", async () => {
    const context = await newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: methods,
      methodResponses: {
        ...responses(),
        "plugins.list": inventory([installed]),
        "plugins.catalog.get": {
          ...detail,
          plugin: {
            ...detail.plugin,
            local: {
              ...detail.plugin.local,
              present: true,
              installed: true,
              enabled: true,
              state: "enabled",
              pluginId: installed.id,
              action: "manage",
            },
          },
        },
      },
    });
    try {
      const pathname = `/plugins/${calendarDiscoveryPlugin.id}`;
      await page.goto(`${server.baseUrl}plugins/${calendarDiscoveryPlugin.id}`);
      await gateway.deferNext("sessions.create");
      await recommendation(page).first().click();
      await gateway.waitForRequest("sessions.create");
      await navigate(page, "/plugins");
      await waitForControlUiRoute(page, { routeId: "plugins", pathname: "/plugins" });
      await navigate(page, pathname);
      await recommendation(page).first().waitFor();
      const lists = (await gateway.getRequests("sessions.list")).length;
      await gateway.resolveDeferred("sessions.create");
      await gateway.waitForRequest("sessions.list", { after: lists });
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      expect(new URL(page.url()).pathname).toBe(pathname);
      expect(await recommendation(page).first().isEnabled()).toBe(true);
      expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it.each(["navigate", "reconnect"] as const)(
    "does not open chat after stale %s during installation",
    async (retirement) => {
      const context = await newContext();
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        featureMethods: methods,
        methodResponses: responses(),
      });
      try {
        await page.goto(`${server.baseUrl}plugins/${calendarDiscoveryPlugin.id}`);
        await gateway.deferNext("plugins.install");
        await recommendation(page).first().click();
        await gateway.waitForRequest("plugins.install");
        if (retirement === "navigate") {
          await navigate(page, "/plugins");
          await waitForControlUiRoute(page, { routeId: "plugins", pathname: "/plugins" });
        } else {
          const connects = (await gateway.getRequests("connect")).length;
          await gateway.closeLatest(1012, "Synthetic reconnect");
          await gateway.waitForRequest("connect", { after: connects });
        }
        await gateway.setMethodResponse("plugins.list", inventory([installed], 1));
        await gateway.resolveDeferred("plugins.install", {
          ok: true,
          plugin: installed,
          restartRequired: false,
        });
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
        expect(new URL(page.url()).pathname).toBe(
          retirement === "navigate" ? "/plugins" : `/plugins/${calendarDiscoveryPlugin.id}`,
        );
      } finally {
        await context.close();
      }
    },
  );
});
