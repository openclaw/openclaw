import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { expect, inject, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { getControlUiContextHandle } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e-session-urls.ts";
import {
  installMockGateway,
  startControlUiE2eServer,
  startBuiltControlUiE2eServer,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createDarkDesktopControlUiContextOptions } from "./control-ui-browser-options.test-support.ts";

const { executablePath, available: chromiumAvailable, wsEndpoint } = inject("controlUiE2eChromium");
function connectCreatorBrowser() {
  return wsEndpoint
    ? chromium.connect(wsEndpoint, { timeout: 30_000 })
    : chromium.launch({ executablePath });
}
it.skipIf(!chromiumAvailable).each([true, false])(
  "handles chat-origin review with Templates enabled=%s without creating or publishing again",
  async (templatesEnabled) => {
    const prebuilt = inject("controlUiE2ePrebuiltAssets");
    const server = prebuilt
      ? await startBuiltControlUiE2eServer(prebuilt.root)
      : await startControlUiE2eServer();
    const browser = await connectCreatorBrowser();
    try {
      const page = await browser.newPage(createDarkDesktopControlUiContextOptions());
      const sessionKey = "agent:main:dashboard:template-request";
      const draftId = "ec8f46b0-4ca3-4991-8a73-dfdcc8764087";
      const scope = {
        input: "Repository",
        job: "Summarize",
        output: "Brief",
        authority: "Read only",
      };
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
        ],
        historyMessages: [
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
        ],
        methodResponses: {
          "config.get": {
            config,
            sourceConfig: config,
            hash: "chat-creator",
            valid: true,
            issues: [],
          },
          "templates.drafts.read": { revision: "a".repeat(64), content: JSON.stringify({ scope }) },
          "templates.drafts.review": {
            revision: "a".repeat(64),
            reviewToken: "b".repeat(64),
            publisher: "maker",
            name: "@maker/research-brief",
            displayName: "Research Brief",
            version: "0.1.0",
            description: "Summarize a repository into a concise brief.",
            items: [],
            files: [{ path: "CLAW.md", content: "Summarize the supplied repository. Read only." }],
            scope,
          },
        },
      });
      await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
      await waitForControlUiRoute(page, { routeId: "chat" });
      await waitForControlUiGatewayReady(page);
      const artifact =
        process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
          ? createControlUiE2eArtifactDir(
              `chat-template-handoff-${templatesEnabled ? "enabled" : "disabled"}`,
            )
          : null;
      if (artifact) {
        const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
        const frame = await takeControlUiScreenshotFrame(page, composer, [composer], {
          animations: "disabled",
        });
        await writeFile(path.join(artifact, "before.png"), frame.png);
      }
      const application = await getControlUiContextHandle(page);
      await expect
        .poll(() =>
          application.evaluate((context) => context.runtimeConfig.state.configSnapshot !== null),
        )
        .toBe(true);
      await gateway.emitGatewayEvent("ui.command", {
        command: { kind: "template-review", draftId },
        agentId: "main",
        sessionKey,
      });
      if (!templatesEnabled) {
        const notice = page.getByText(
          "Your private draft is saved. Turn on Templates in Settings → Labs to review it.",
          { exact: true },
        );
        try {
          await notice.waitFor({ state: "visible", timeout: 5_000 });
        } finally {
          if (artifact) {
            const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
            const frame = await takeControlUiScreenshotFrame(page, composer, [composer], {
              animations: "disabled",
            });
            await writeFile(path.join(artifact, "after.png"), frame.png);
          }
        }
        for (const method of [
          "chat.send",
          "templates.drafts.create",
          "templates.drafts.read",
          "templates.drafts.publish",
        ]) {
          expect(await gateway.getRequests(method)).toHaveLength(0);
        }
        expect(await page.getByRole("dialog", { name: "Review your Template" }).count()).toBe(0);
        await page.getByRole("button", { name: "Open Labs", exact: true }).click();
        await waitForControlUiRoute(page, { routeId: "labs" });
        return;
      }
      const dialog = page.getByRole("dialog", { name: "Review your Template" });
      await dialog.waitFor({ state: "visible" });
      expect(await dialog.getByLabel("Name").inputValue()).toBe("Research Brief");
      expect(await dialog.getByRole("button", { name: "Publish", exact: true }).count()).toBe(1);
      expect(await dialog.getByRole("button", { name: "Ask for changes" }).count()).toBe(0);
      expect((await gateway.getRequests("templates.drafts.read"))[0]?.params).toMatchObject({
        agentId: "main",
        draftId,
      });
      expect(await page.evaluate(() => window.openclawControlUi?.snapshot().sessionKey)).toBe(
        sessionKey,
      );
      for (const method of ["chat.send", "templates.drafts.create", "templates.drafts.publish"]) {
        expect(await gateway.getRequests(method)).toHaveLength(0);
      }
      if (artifact) {
        const frame = await takeControlUiScreenshotFrame(
          page,
          dialog,
          [dialog.getByLabel("Name")],
          { animations: "disabled" },
        );
        await writeFile(path.join(artifact, "after.png"), frame.png);
      }
    } finally {
      await browser.close();
      await server.close();
    }
  },
);
