import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
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

const { executablePath, available, wsEndpoint } = inject("controlUiE2eChromium");
const sessionKey = "agent:main:dashboard:template-request";
const draftId = "ec8f46b0-4ca3-4991-8a73-dfdcc8764087";
const scope = { input: "Repository", job: "Summarize", output: "Brief", authority: "Read only" };
const reviewed = {
  revision: "a".repeat(64),
  reviewToken: "b".repeat(64),
  publisher: "maker",
  name: "@maker/research-brief",
  displayName: "Research Brief",
  version: "0.1.0",
  description: "Summarize a repository into a concise brief.",
  scope,
  items: [
    {
      id: "file:AGENTS.md",
      kind: "file",
      label: "AGENTS.md",
      detail: "Read only. Never publish without human review.",
      included: true,
    },
    {
      id: "skill:release",
      kind: "skill",
      label: "Release notes",
      detail: "Read releases and prepare a concise summary.",
      included: true,
    },
    {
      id: "plugin:github",
      kind: "plugin",
      label: "GitHub",
      detail: "github@1.0.0",
      included: true,
    },
    {
      id: "mcp:docs",
      kind: "mcp",
      label: "Docs",
      detail: "https://example.test/mcp — no credentials included",
      included: true,
    },
    {
      id: "automation:brief",
      kind: "automation",
      label: "Morning brief",
      detail: "0 9 * * * — disabled when installed",
      included: true,
    },
  ],
  files: [
    { path: "CLAW.md", content: "Summarize the supplied repository. Read only." },
    { path: "AGENTS.md", content: "Read only. Never publish without human review.\n".repeat(45) },
  ],
};
const publication = {
  name: reviewed.name,
  version: reviewed.version,
  url: "https://example.test/maker/templates/research-brief",
  publicationStatus: "pending",
  attemptId: "attempt-1",
};
const historyMessages = [
  {
    role: "user",
    content: [{ type: "text", text: "Create a new template from this agent." }],
    timestamp: 1_790_000_000_000,
  },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "The private proposal is ready for your review. Nothing has been published.",
      },
    ],
    timestamp: 1_790_000_001_000,
  },
  {
    role: "toolResult",
    toolName: "screen",
    toolCallId: "review-template-1",
    content: [{ type: "text", text: "Template ready for review" }],
    timestamp: 1_790_000_002_000,
    details: {
      pluginView: {
        type: "plugin_view",
        pluginId: "openclaw",
        viewId: "template-review",
        version: 1,
        toolName: "screen",
        toolCallId: "review-template-1",
        summary: "Template ready for review",
        payload: { agentId: "main", draftId, sessionKey },
      },
    },
  },
];

it.skipIf(!available).each([true, false])(
  "hydrates native read-only review in the original transcript, Templates=%s",
  async (templatesEnabled) => {
    const prebuilt = inject("controlUiE2ePrebuiltAssets");
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
            "Your private draft is saved. Turn on Templates in Settings → Labs to review it.",
            { exact: true },
          )
          .waitFor();
        expect(await gateway.getRequests("templates.drafts.read")).toHaveLength(0);
        return;
      }
      const card = inline.getByRole("region", { name: "Review your Template" });
      await card.getByRole("heading", { name: "Research Brief", exact: true }).waitFor();
      const capture = async (stage: string) => {
        if (!proof) {
          return;
        }
        const frame = await takeControlUiScreenshotFrame(page, card, [card.getByRole("heading")], {
          animations: "disabled",
        });
        await writeFile(path.join(proof, stage + ".png"), frame.png);
        await page.waitForTimeout(600);
      };
      const bounds = await card.boundingBox();
      expect(bounds?.width).toBe(620);
      expect(bounds?.height).toBe(565);
      expect(await card.locator("input, textarea").count()).toBe(0);
      expect(await page.getByRole("dialog").count()).toBe(0);
      await capture("ready");
      for (const label of ["Workspace files", "Skills", "Plugins", "MCP servers", "Automations"]) {
        await card.getByRole("button", { name: new RegExp(label) }).click();
        await card.getByRole("heading", { name: label, exact: true }).waitFor();
        expect((await card.boundingBox())?.height).toBe(565);
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
          await card.getByRole("button", { name: "CLAW.md", exact: true }).click();
          await card.getByRole("heading", { name: "CLAW.md", exact: true }).waitFor();
          await card.getByRole("button", { name: "Back to contents", exact: true }).click();
        } else {
          await card.locator(".template-creator__body button").first().click();
          await capture(label.toLowerCase().replaceAll(" ", "-"));
          await card.getByRole("button", { name: "Back to contents", exact: true }).click();
        }
        await card.getByRole("button", { name: "Back to Template", exact: true }).click();
        await card.getByRole("heading", { name: "Research Brief", exact: true }).waitFor();
      }
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      expect(await gateway.getRequests("templates.drafts.publish")).toHaveLength(0);
      await gateway.setMethodDelay("templates.drafts.publish", "forever");
      await card.getByRole("button", { name: "Publish to ClawHub", exact: true }).click();
      await card.getByRole("button", { name: "Publishing…", exact: true }).waitFor();
      await capture("publishing");
      expect(await gateway.getRequests("templates.drafts.publish")).toHaveLength(1);
      await gateway.setMethodResponse("templates.drafts.review", {
        ...reviewed,
        publicationState: { status: "pending", publication },
      });
      await gateway.setMethodDelay("templates.drafts.publish", null);
      await card.getByText("Pending security scans", { exact: true }).waitFor();
      await capture("pending");
      expect(await card.getByText("Published", { exact: true }).count()).toBe(0);
      await gateway.setMethodResponse("templates.drafts.review", {
        ...reviewed,
        publicationState: {
          status: "published",
          publication: { ...publication, publicationStatus: "published" },
        },
      });
      await card.getByText("Published", { exact: true }).waitFor({ timeout: 10_000 });
      await capture("published");
      expect(await card.getByRole("button", { name: "Copy link", exact: true }).count()).toBe(1);
      expect(await gateway.getRequests("templates.drafts.publish")).toHaveLength(1);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await page.setViewportSize({ width: 400, height: 900 });
      await card.scrollIntoViewIfNeeded();
      expect((await card.boundingBox())!.width).toBeLessThanOrEqual(400);
      expect((await card.boundingBox())!.height).toBe(565);
      await capture("narrow");
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
