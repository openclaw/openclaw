import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { expect, inject, it } from "vitest";
import { createThemePaletteFixture } from "../../../test/helpers/theme-fixture.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  createControlUiMockBootstrapConfig,
  createControlUiMockSameOriginGatewayScript,
  installControlUiMockBootstrapDocument,
  installMockGateway,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createDarkDesktopControlUiContextOptions } from "./control-ui-browser-options.test-support.ts";
import {
  historyMessages,
  reviewed,
  scope,
  sessionKey,
} from "./template-chat-review.test-support.ts";

const { executablePath, available, wsEndpoint } = inject("controlUiE2eChromium");

it.skipIf(!available)(
  "keeps Template content-row hover readable in a custom dark theme",
  async () => {
    const server = await startControlUiE2eServer(undefined, { source: true });
    const browser = wsEndpoint
      ? await chromium.connect(wsEndpoint)
      : await chromium.launch({ executablePath });
    const context = await browser.newContext(createDarkDesktopControlUiContextOptions());
    const page = await context.newPage();
    const proof =
      process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
        ? createControlUiE2eArtifactDir("template-row-hover")
        : null;
    try {
      const id = "user/review-hover";
      const theme = {
        id,
        name: "Review hover",
        description: "Navy and mint",
        source: "user",
        modes: ["dark"],
      };
      const selection = {
        current: { id, mode: "dark", scope: "gateway", overrides: {} },
        theme,
        themes: [theme],
        definition: {
          name: theme.name,
          description: theme.description,
          dark: createThemePaletteFixture({
            background: "#111b29",
            foreground: "#e3ebe8",
            "muted-foreground": "#b9c9c9",
            accent: "#9fcabe",
            primary: "#e5c478",
            "font-sans": "Inter, system-ui, sans-serif",
          }),
        },
      };
      const config = {
        ui: { prefs: { theme: id, themeMode: "dark" } },
        gateway: { controlUi: { experimental: { templates: true } } },
      };
      const gateway = await installMockGateway(page, {
        sessionKey,
        historyMessages,
        assistantName: "Harbor",
        agentModel: "openai/gpt-4o",
        models: [{ id: "gpt-4o", name: "GPT-4o", provider: "openai" }],
        featureMethods: [
          "chat.send",
          "templates.drafts.create",
          "templates.drafts.read",
          "templates.drafts.review",
          "templates.drafts.publish",
        ],
        methodResponses: {
          "config.get": {
            config,
            sourceConfig: config,
            hash: "row-hover",
            valid: true,
            issues: [],
          },
          "themes.list": selection,
          "themes.get": selection,
          "templates.drafts.read": {
            revision: reviewed.revision,
            content: JSON.stringify({ scope }),
          },
          "templates.drafts.review": reviewed,
        },
      });
      await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
      const compact = page.getByRole("region", { name: "Publish Template" });
      await compact.getByRole("button", { name: "Preview", exact: true }).click();
      const card = page
        .getByRole("dialog", { name: "Preview Template" })
        .getByRole("region", { name: "Review your Template" });
      const heading = card.getByRole("heading", { name: "Research Brief", exact: true });
      await heading.waitFor();
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("custom");
      const row = card.getByRole("button", { name: /Workspace files/ });
      await row.hover();
      if (proof) {
        const frame = await takeControlUiScreenshotFrame(page, card, [heading, row], {
          animations: "disabled",
          elements: [card],
        });
        await writeFile(path.join(proof, "hover.png"), frame.png);
        await writeFile(path.join(proof, "hover-card.png"), frame.elements[0]!.png);
      }
      const contrast = await row.evaluate((element) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const canvasContext = canvas.getContext("2d", { willReadFrequently: true })!;
        const color = (value: string) => {
          canvasContext.clearRect(0, 0, 1, 1);
          canvasContext.fillStyle = value;
          canvasContext.fillRect(0, 0, 1, 1);
          return [...canvasContext.getImageData(0, 0, 1, 1).data];
        };
        const surface = color(
          getComputedStyle(element.closest(".template-creator")!).backgroundColor,
        );
        const hover = color(getComputedStyle(element).backgroundColor);
        const background = hover
          .slice(0, 3)
          .map(
            (channel, index) =>
              (channel * hover[3]!) / 255 + surface[index]! * (1 - hover[3]! / 255),
          );
        const luminance = (channels: number[]) =>
          channels
            .map((channel) => {
              const value = channel / 255;
              return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            })
            .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
        return ["strong", "small"].map((selector) => {
          const ink = color(getComputedStyle(element.querySelector(selector)!).color);
          const light = [luminance(ink.slice(0, 3)), luminance(background)].toSorted(
            (a, b) => a - b,
          );
          return (light[1]! + 0.05) / (light[0]! + 0.05);
        });
      });
      if (proof) {
        await writeFile(path.join(proof, "contrast.json"), JSON.stringify(contrast));
        console.log("Template hover proof:", proof, "contrast:", contrast);
      }
      expect.soft(contrast[0], "Hovered row title contrast").toBeGreaterThanOrEqual(4.5);
      expect.soft(contrast[1], "Hovered row summary contrast").toBeGreaterThanOrEqual(4.5);
      await row.click();
      await card.getByRole("heading", { name: "Workspace files", exact: true }).waitFor();
      expect(await gateway.getRequests("templates.drafts.publish")).toHaveLength(0);
    } finally {
      await context.close();
      await browser.close();
      await server.close();
    }
  },
  60_000,
);

it.skipIf(!available).each([true, false, "failed", "bootstrap"] as const)(
  "does not diagnose a saved template review before config arrives, Templates=%s",
  async (templatesEnabled) => {
    const server = await startControlUiE2eServer(undefined, { source: true });
    const browser = wsEndpoint
      ? await chromium.connect(wsEndpoint)
      : await chromium.launch({ executablePath });
    const context = await browser.newContext(createDarkDesktopControlUiContextOptions());
    const page = await context.newPage();
    try {
      const config = {
        gateway: {
          controlUi: {
            experimental: {
              templates: templatesEnabled === true || templatesEnabled === "bootstrap",
            },
          },
        },
      };
      const snapshot = {
        config,
        sourceConfig: config,
        hash: "pending-review",
        valid: true,
        issues: [],
      };
      const gateway = await installMockGateway(page, {
        sessionKey,
        historyMessages,
        assistantName: "Harbor",
        agentModel: "openai/gpt-4o",
        models: [{ id: "gpt-4o", name: "GPT-4o", provider: "openai" }],
        authMethod: "trusted-proxy",
        authMode: "trusted-proxy",
        presenceUsers: [{ id: "synthetic-template-operator", self: true }],
        heldMethods: ["config.get"],
        featureMethods: [
          "chat.send",
          "templates.drafts.create",
          "templates.drafts.read",
          "templates.drafts.review",
        ],
        methodResponses: {
          "config.get": snapshot,
          "templates.drafts.read": {
            revision: reviewed.revision,
            content: JSON.stringify({ scope }),
          },
          "templates.drafts.review": reviewed,
        },
      });
      if (templatesEnabled === "bootstrap") {
        await page.addInitScript(createControlUiMockSameOriginGatewayScript());
        const bootstrap = {
          ...createControlUiMockBootstrapConfig(),
          preferences: { profileId: "synthetic-template-operator", config, entries: {} },
        };
        await page.route("**/control-ui-config.json", (route) =>
          route.fulfill({ json: bootstrap }),
        );
        await installControlUiMockBootstrapDocument(page, bootstrap);
      }
      await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
      if (templatesEnabled !== "bootstrap") {
        await gateway.waitForRequest("config.get");
      }
      const inline = page.locator('[data-plugin-inline-view="review-template-1"]');
      await inline.waitFor({ state: "attached" });
      const warning = inline.getByText(
        "Your private draft is saved. Turn on Templates in Settings → Labs to review it.",
        { exact: true },
      );
      await inline.evaluate((element) => element.scrollIntoView());
      // A negative assertion must wait for the lazy renderer, not just its outer placeholder.
      const renderer = await page.evaluateHandle(
        'import("/src/pages/templates/creator-inline-review.tsx")',
      );
      await renderer.dispose();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      if (templatesEnabled === "bootstrap") {
        await inline.locator(".callout, .template-publish-card").first().waitFor();
      }
      const artifacts = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR
        ? createControlUiE2eArtifactDir("template-readiness-" + templatesEnabled)
        : undefined;
      if (artifacts) {
        await page.screenshot({
          path: path.join(artifacts, "pending.png"),
          animations: "disabled",
        });
      }
      const prematureWarnings = await warning.count();
      if (templatesEnabled === "bootstrap") {
        expect(await warning.count()).toBe(0);
        await inline.getByRole("heading", { name: "Research Brief", exact: true }).waitFor();
        expect(await gateway.getRequests("config.get")).toHaveLength(0);
        return;
      }
      expect(await gateway.getRequests("templates.drafts.read")).toHaveLength(0);
      if (templatesEnabled === "failed") {
        await gateway.rejectDeferred("config.get", { message: "Configuration unavailable" });
        await inline
          .getByText(
            "Your private draft is saved. Template review requires a connected administrator session with Template creation and chat access.",
            { exact: true },
          )
          .waitFor();
        expect(await gateway.getRequests("templates.drafts.read")).toHaveLength(0);
      } else {
        await gateway.resolveDeferred("config.get", snapshot);
      }
      if (templatesEnabled === true) {
        await inline.getByRole("heading", { name: "Research Brief", exact: true }).waitFor();
        expect(await warning.count()).toBe(0);
      } else if (templatesEnabled === false) {
        await warning.waitFor();
        expect(await gateway.getRequests("templates.drafts.read")).toHaveLength(0);
      }
      if (artifacts) {
        await page.screenshot({
          path: path.join(artifacts, "resolved.png"),
          animations: "disabled",
        });
      }
      expect(prematureWarnings, "Unknown config is not proof that Templates is disabled").toBe(0);
    } finally {
      await context.close();
      await browser.close();
      await server.close();
    }
  },
  60_000,
);
