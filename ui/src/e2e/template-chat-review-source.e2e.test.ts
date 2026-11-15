import path from "node:path";
import { chromium } from "playwright";
import { expect, inject, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
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
        await inline.locator(".callout, .template-creator__header").first().waitFor();
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
