import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { TemplatesDraftsReviewResult } from "@openclaw/gateway-protocol";
import { chromium, type Locator } from "playwright";
import { expect, inject, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  startControlUiE2eServer,
  startBuiltControlUiE2eServer,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createDarkDesktopControlUiContextOptions } from "./control-ui-browser-options.test-support.ts";
import {
  historyMessages,
  reviewed,
  scope,
  sessionKey,
} from "./template-chat-review.test-support.ts";

const { executablePath, available, wsEndpoint } = inject("controlUiE2eChromium");
const publication = {
  name: reviewed.name,
  version: reviewed.version,
  url: "https://example.test/maker/templates/research-brief",
  publicationStatus: "pending",
  attemptId: "attempt-1",
};
it.skipIf(!available).each([true, false])(
  "hydrates native read-only review in the original transcript, Templates=%s",
  async (templatesEnabled) => {
    const prebuilt = inject("controlUiE2eDeploymentAssets");
    const server = prebuilt
      ? await startBuiltControlUiE2eServer(prebuilt.root)
      : await startControlUiE2eServer();
    const browser = wsEndpoint
      ? await chromium.connect(wsEndpoint)
      : await chromium.launch({ executablePath });
    const proof =
      process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
        ? createControlUiE2eArtifactDir("template-inline-native-" + templatesEnabled)
        : null;
    const context = await browser.newContext({
      ...createDarkDesktopControlUiContextOptions(),
      viewport: { width: 1440, height: 1000 },
      ...(proof ? { recordVideo: { dir: proof, size: { width: 1440, height: 1000 } } } : {}),
    });
    const page = await context.newPage();
    const video = page.video();
    try {
      const config = { gateway: { controlUi: { experimental: { templates: templatesEnabled } } } };
      const gateway = await installMockGateway(page, {
        assistantName: "Harbor",
        agentModel: "openai/gpt-4o",
        models: [{ id: "gpt-4o", name: "GPT-4o", provider: "openai" }],
        serverBuildId: prebuilt?.buildInfo.buildId,
        serverVersion: prebuilt?.buildInfo.version ?? undefined,
        sessionKey,
        featureMethods: [
          "chat.send",
          "templates.drafts.create",
          "templates.drafts.read",
          "templates.drafts.review",
          "templates.drafts.publish",
        ],
        historyMessages,
        methodResponses: {
          "config.get": {
            config,
            sourceConfig: config,
            hash: "chat-creator",
            valid: true,
            issues: [],
          },
          "templates.drafts.read": {
            revision: reviewed.revision,
            content: JSON.stringify({ scope }),
          },
          "plugins.catalog.get": {
            plugin: {
              catalog: { summary: "Connect to GitHub issues, pull requests, and checks." },
            },
            detail: {
              origin: "clawhub",
              packageName: "@maker/github",
              selectedRelease: { version: "2.0.0" },
            },
          },
          "skills.detail": {
            skill: { summary: "Summarize release changes with source links." },
            card: {
              status: "available",
              content:
                "# Release notes\nRead the release history and cite the source for each finding.",
            },
          },
          "templates.drafts.review": reviewed,
          "templates.drafts.publish": publication,
        },
      });
      await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
      await waitForControlUiRoute(page, { routeId: "chat" });
      await waitForControlUiGatewayReady(page);
      const inline = page.locator('[data-plugin-inline-view="review-template-1"]');
      await inline.scrollIntoViewIfNeeded();
      if (!templatesEnabled) {
        await inline
          .getByText(
            "Your private draft is saved. Templates is disabled in Gateway configuration; ask an administrator to enable it to review your draft.",
            { exact: true },
          )
          .waitFor();
        expect(await gateway.getRequests("templates.drafts.read")).toHaveLength(0);
        return;
      }
      const compact = inline.getByRole("region", { name: "Publish Template" });
      await compact.getByRole("heading", { name: "Research Brief", exact: true }).waitFor();
      expect(await page.getByRole("dialog").count()).toBe(0);
      await compact.getByRole("button", { name: "Preview", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Preview Template" });
      const card = dialog.getByRole("region", { name: "Review your Template" });
      await card.getByRole("heading", { name: "Research Brief", exact: true }).waitFor();
      expect(await page.getByText("Template ready for review", { exact: true }).count()).toBe(0);
      await card
        .locator(".template-creator__header")
        .getByText("Unpublished", { exact: true })
        .waitFor();
      const capture = async (stage: string, target: Locator = card) => {
        if (!proof) {
          return;
        }
        const frame = await takeControlUiScreenshotFrame(
          page,
          target,
          [target.getByRole("heading", { level: 2 })],
          {
            animations: "disabled",
          },
        );
        await writeFile(path.join(proof, stage + ".png"), frame.png);
        await page.waitForTimeout(600);
      };
      await dialog.evaluate((element) =>
        Promise.all(element.getAnimations().map((animation) => animation.finished)),
      );
      const bounds = await card.boundingBox();
      expect(bounds?.width).toBe(620);
      expect(bounds?.height).toBe(565);
      expect(await card.locator("input, textarea").count()).toBe(0);
      expect(
        await card
          .locator(".template-creator__footer")
          .evaluate((footer) => getComputedStyle(footer).borderTopWidth),
      ).toBe("0px");
      await capture("ready");
      for (const label of ["Workspace files", "Skills", "Plugins", "MCP servers", "Automations"]) {
        await card.getByRole("button", { name: new RegExp(label) }).click();
        await card.getByRole("heading", { name: label, exact: true }).waitFor();
        expect((await card.boundingBox())?.height).toBe(565);
        expect((await card.locator(".template-creator__header").boundingBox())?.height).toBe(60);
        await card.locator(".template-creator__category-icon").waitFor();
        if (label === "Automations") {
          await card
            .getByText("Weekdays at 9:00 AM · America/Los_Angeles", { exact: true })
            .waitFor();
          expect(await card.getByText("0 9 * * *", { exact: false }).count()).toBe(0);
        }
        await capture(label.toLowerCase().replaceAll(" ", "-") + "-list");
        if (label === "Workspace files") {
          await card.getByRole("button", { name: "AGENTS.md", exact: true }).click();
          await card.getByRole("heading", { name: "AGENTS.md", exact: true }).waitFor();
          await capture("file");
          await card
            .locator(".template-creator__body")
            .evaluate((body) => (body.scrollTop = body.scrollHeight));
          expect(
            await card.locator(".template-creator__body").evaluate((body) => body.scrollTop),
          ).toBeGreaterThan(0);
          await card.getByRole("button", { name: "Back to contents", exact: true }).click();
          await card.getByRole("button", { name: "View all", exact: true }).click();
          await card.getByRole("button", { name: "workspace/AGENTS.md", exact: true }).waitFor();
          await card.getByRole("button", { name: "CLAW.md", exact: true }).click();
          await card.getByRole("heading", { name: "CLAW.md", exact: true }).waitFor();
          await card.getByRole("button", { name: "Back to contents", exact: true }).click();
          await card.getByRole("button", { name: "Back to contents", exact: true }).click();
        } else {
          await card.locator(".template-creator__body button").first().click();
          const expected = {
            Skills: "Read the release history and cite the source for each finding.",
            Plugins: "Required when this template is added",
            "MCP servers": "OAuth · Sign-in required",
            Automations: reviewed.items.at(-1)!.automation!.message,
          }[label]!;
          await card.getByText(expected, { exact: true }).waitFor();
          if (label !== "Skills" && label !== "Plugins") {
            expect(await card.getByText("Description", { exact: true }).count()).toBe(0);
          }
          expect(await card.getByText("Read-only preview", { exact: true }).count()).toBe(0);
          await capture(label.toLowerCase().replaceAll(" ", "-"));
          await card.getByRole("button", { name: "Back to contents", exact: true }).click();
        }
        await card.getByRole("button", { name: "Back to Template", exact: true }).click();
        await card.getByRole("heading", { name: "Research Brief", exact: true }).waitFor();
      }
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("templates.drafts.publish")).toHaveLength(0);
      await page.clock.install();
      await gateway.setMethodDelay("templates.drafts.publish", "forever");
      await card.getByRole("button", { name: "Publish", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      await compact.getByRole("button", { name: "Publishing", exact: true }).waitFor();
      await capture("publishing", compact);
      expect(await gateway.getRequests("templates.drafts.publish")).toHaveLength(1);
      await gateway.setMethodResponse("templates.drafts.review", {
        ...reviewed,
        publicationState: { status: "pending", publication },
      });
      await gateway.setMethodDelay("templates.drafts.publish", null);
      await compact.locator("header [role=status]").getByText("Pending", { exact: true }).waitFor();
      expect(
        await compact.getByRole("link", { name: "View submission" }).getAttribute("href"),
      ).toBe(publication.url);
      await capture("pending", compact);
      expect(await compact.getByText("Published", { exact: true }).count()).toBe(0);
      await gateway.setMethodResponse("templates.drafts.review", {
        ...reviewed,
        publicationState: {
          status: "published",
          publication: { ...publication, publicationStatus: "published" },
        },
      });
      // Pending publications refresh through the owner's 30-second polling interval.
      await page.clock.runFor(30_000);
      await compact.getByText("Published", { exact: true }).waitFor({ timeout: 10_000 });
      await capture("published", compact);
      expect(await compact.getByRole("button", { name: "Copy link", exact: true }).count()).toBe(1);
      expect(await compact.locator("footer a").count()).toBe(0);
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await compact.getByRole("button", { name: "Copy link", exact: true }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(publication.url);
      await compact.getByRole("button", { name: "Copied", exact: true }).waitFor();
      expect(await gateway.getRequests("templates.drafts.publish")).toHaveLength(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await page.setViewportSize({ width: 400, height: 900 });
      await compact.scrollIntoViewIfNeeded();
      const narrowBounds = (await compact.boundingBox())!;
      expect(narrowBounds.width).toBeLessThanOrEqual(400);
      expect(narrowBounds.x).toBeGreaterThanOrEqual(0);
      expect(narrowBounds.x + narrowBounds.width).toBeLessThanOrEqual(400);
      await capture("narrow", compact);
    } finally {
      await context.close();
      if (proof && video) {
        await video.saveAs(path.join(proof, "candidate.webm"));
      }
      await browser.close();
      await server.close();
    }
  },
  120_000,
);

it.skipIf(!available)(
  "keeps inline review category rows and chevrons inside narrow cards",
  async () => {
    const prebuilt = inject("controlUiE2eDeploymentAssets");
    const server = prebuilt
      ? await startBuiltControlUiE2eServer(prebuilt.root)
      : await startControlUiE2eServer();
    const browser = wsEndpoint
      ? await chromium.connect(wsEndpoint)
      : await chromium.launch({ executablePath });
    const context = await browser.newContext({
      colorScheme: "light",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const proof =
      process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
        ? createControlUiE2eArtifactDir("template-category-grid")
        : null;
    const measurements: unknown[] = [];
    try {
      const config = { gateway: { controlUi: { experimental: { templates: true } } } };
      const longPath =
        "workspace/reference/repository-release-review-and-source-attribution-guide.md";
      const gateway = await installMockGateway(page, {
        assistantName: "Harbor",
        agentModel: "openai/gpt-4o",
        models: [{ id: "gpt-4o", name: "GPT-4o", provider: "openai" }],
        sessionKey,
        serverBuildId: prebuilt?.buildInfo.buildId,
        serverVersion: prebuilt?.buildInfo.version ?? undefined,
        featureMethods: [
          "chat.send",
          "templates.drafts.create",
          "templates.drafts.read",
          "templates.drafts.review",
          "templates.drafts.publish",
        ],
        historyMessages,
        methodResponses: {
          "config.get": {
            config,
            sourceConfig: config,
            hash: "category-grid",
            valid: true,
            issues: [],
          },
          "templates.drafts.read": {
            revision: reviewed.revision,
            content: JSON.stringify({ scope }),
          },
          "templates.drafts.review": {
            ...reviewed,
            files: [
              ...reviewed.files,
              {
                path: longPath,
                content:
                  "Read the release history and retain source attribution before preparing a repository review.",
              },
            ],
          } satisfies TemplatesDraftsReviewResult,
        },
      });
      await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
      await waitForControlUiRoute(page, { routeId: "chat" });
      await waitForControlUiGatewayReady(page);
      const inline = page.locator('[data-plugin-inline-view="review-template-1"]');
      await inline.scrollIntoViewIfNeeded();
      const compact = inline.getByRole("region", { name: "Publish Template" });
      await compact.getByRole("button", { name: "Preview", exact: true }).click();
      const card = page
        .getByRole("dialog", { name: "Preview Template" })
        .getByRole("region", { name: "Review your Template" });
      const heading = card.getByRole("heading", { level: 2 });
      await heading.waitFor();
      await card.scrollIntoViewIfNeeded();
      const measure = async (state: string) => {
        const geometry = await card.evaluate((element) => {
          const body = element.querySelector<HTMLElement>(".template-creator__body")!;
          const contents = body.querySelector<HTMLElement>(".template-creator__contents")!;
          const bounds = contents.getBoundingClientRect();
          return {
            viewport: [innerWidth, innerHeight],
            card: element.getBoundingClientRect().toJSON(),
            body: { client: body.clientWidth, scroll: body.scrollWidth },
            contents: bounds.toJSON(),
            rows: [...contents.querySelectorAll<HTMLElement>("button")].map((row) => ({
              label: row.getAttribute("aria-label") ?? row.textContent,
              bounds: row.getBoundingClientRect().toJSON(),
              chevron: row
                .querySelector(":scope > svg:last-child")!
                .getBoundingClientRect()
                .toJSON(),
            })),
          };
        });
        measurements.push({ state, ...geometry });
        if (proof) {
          const frame = await takeControlUiScreenshotFrame(page, card, [heading], {
            animations: "disabled",
            elements: [card],
          });
          await writeFile(path.join(proof, state + ".png"), frame.png);
          await writeFile(path.join(proof, state + "-card.png"), frame.elements[0]!.png);
          await writeFile(path.join(proof, "geometry.json"), JSON.stringify(measurements, null, 2));
        }
        expect
          .soft(geometry.body.scroll, state + " body overflow")
          .toBeLessThanOrEqual(geometry.body.client + 1);
        for (const row of geometry.rows) {
          expect
            .soft(row.bounds.x, state + " row start")
            .toBeGreaterThanOrEqual(geometry.contents.x - 1);
          expect
            .soft(row.bounds.right, state + " row end")
            .toBeLessThanOrEqual(geometry.contents.right + 1);
          expect.soft(row.chevron.width, state + " visible chevron").toBeGreaterThan(0);
          expect
            .soft(row.chevron.right, state + " chevron")
            .toBeLessThanOrEqual(geometry.contents.right + 1);
        }
      };
      await measure("phone-root");
      await card.getByRole("button", { name: /Workspace files/ }).click();
      await measure("phone-workspace");
      expect(await card.locator("input, textarea").count()).toBe(0);
      expect(await heading.evaluate((element) => element === document.activeElement)).toBe(true);
      const agents = card.getByRole("button", { name: "AGENTS.md", exact: true });
      await agents.focus();
      await page.keyboard.press("Enter");
      await card
        .getByText("Read only. Never publish without human review.", { exact: false })
        .waitFor();
      await card.locator(".template-creator__body").evaluate((body) => {
        body.scrollTop = body.scrollHeight;
      });
      expect(
        await card.locator(".template-creator__body").evaluate((body) => body.scrollTop),
      ).toBeGreaterThan(0);
      await card.getByRole("button", { name: "Back to contents", exact: true }).click();
      await card.getByRole("button", { name: "View all", exact: true }).click();
      await card.getByRole("button", { name: longPath, exact: true }).waitFor();
      await measure("phone-archive");
      const longFile = card.getByRole("button", { name: longPath, exact: true });
      await longFile.scrollIntoViewIfNeeded();
      await measure("phone-archive-scrolled");
      const fileBounds = (await longFile.boundingBox())!;
      const bodyBounds = (await card.locator(".template-creator__body").boundingBox())!;
      expect(fileBounds.y + fileBounds.height).toBeLessThanOrEqual(
        bodyBounds.y + bodyBounds.height,
      );
      await longFile.click();
      await card
        .getByText(
          "Read the release history and retain source attribution before preparing a repository review.",
          { exact: true },
        )
        .waitFor();
      await card.getByRole("button", { name: "Back to contents", exact: true }).click();
      await card.getByRole("button", { name: "CLAW.md", exact: true }).click();
      await card
        .getByText("Summarize the supplied repository. Read only.", { exact: true })
        .waitFor();
      await card.getByRole("button", { name: "Back to contents", exact: true }).click();
      await card.getByRole("button", { name: "Back to contents", exact: true }).click();
      expect(await card.getByRole("button", { name: "CLAW.md", exact: true }).count()).toBe(0);
      await card.getByRole("button", { name: "Back to Template", exact: true }).click();
      for (const label of ["Skills", "Plugins", "MCP servers", "Automations"]) {
        await card.getByRole("button", { name: new RegExp(label) }).click();
        await measure("phone-" + label.toLowerCase().replaceAll(" ", "-"));
        await card.getByRole("button", { name: "Back to Template", exact: true }).click();
      }
      await card.getByRole("button", { name: /Workspace files/ }).click();
      // Retained desktop sidebar + tablet/wide transcript widths must use the same owner.
      for (const [name, width, height] of [
        ["tablet", 820, 1000],
        ["desktop-sidebar", 1024, 900],
        ["wide", 1440, 1000],
      ] as const) {
        await page.setViewportSize({ width, height });
        await card.scrollIntoViewIfNeeded();
        await measure(name + "-workspace");
      }
      await page.emulateMedia({ colorScheme: "dark" });
      await page.setViewportSize({ width: 390, height: 844 });
      await card.scrollIntoViewIfNeeded();
      await measure("phone-dark-workspace");
      expect(await card.getByRole("button", { name: "Publish", exact: true }).isVisible()).toBe(
        true,
      );
      expect(await gateway.getRequests("templates.drafts.publish")).toHaveLength(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    } finally {
      await context.close();
      await browser.close();
      await server.close();
    }
  },
  120_000,
);
