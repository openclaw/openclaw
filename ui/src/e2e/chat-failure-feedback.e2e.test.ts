import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { catalog } from "./native-plugin-ui.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Run failure plugin feedback" });
const sessionKey = "agent:main:main";
const summary = "Synthetic internal error: the example operation could not finish.";
const plugin = `export default { id: "ui-fixture", activate(host) {
  host.ui.registerReplacement({ id: "failure-feedback", label: "Example feedback", surface: "run-failure-feedback",
    mount(container, context) {
      const status = document.createElement("span");
      status.dataset.pluginFailureFeedback = "";
      status.textContent = "Example feedback pending";
      container.append(status);
      void context.host.request("fixture.failureFeedback", context.props).then(result => {
        if (context.signal.aborted) return;
        status.textContent = result.text;
        const artifact = document.createElement("a");
        artifact.textContent = "Example log artifact"; artifact.href = result.artifactUrl;
        artifact.rel = "noopener noreferrer";
        status.append(" · ", artifact);
      });
    }
  });
  host.ui.registerAction({ id: "enable-feedback", label: "Use plugin feedback", placement: "header",
    run() { host.ui.selectReplacement("run-failure-feedback", "failure-feedback"); }
  });
} };`;

suite.define(() => {
  it("renders a plugin receipt without sending a message and restores built-in feedback when disabled", async () => {
    await suite.withPage(
      { viewport: { width: 1160, height: 850 }, serviceWorkers: "block" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          sessionKey,
          historyMessages: [
            { role: "user", content: "Check the example operation.", timestamp: 1 },
            {
              role: "custom",
              content: summary,
              timestamp: 2,
              customType: "run-failed-before-reply",
              openclawRunError: { runId: "failed-example-run", summary },
            },
          ],
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "plugins.controlUi.list",
            "plugins.controlUi.report",
            "fixture.failureFeedback",
          ],
          methodResponses: {
            "plugins.controlUi.list": catalog("failure-feedback"),
            "plugins.controlUi.report": { ok: true },
            "fixture.failureFeedback": {
              text: "Example plugin queued · Synthetic report ID: fixture-report",
              artifactUrl: "https://example.invalid/synthetic-log.zip",
            },
          },
        });
        await page.route("**/__openclaw__/plugins/control-ui/ui-fixture/*/index.js", (route) =>
          route.fulfill({ status: 200, contentType: "text/javascript", body: plugin }),
        );
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const notice = page.locator(".chat-run-failure");
        const report = notice.getByRole("link", { name: "Report a bug" });
        await report.waitFor();
        const toggle = notice.getByRole("button", { name: "Couldn’t finish this reply" });
        await toggle.click();
        await notice.locator('[role="dialog"][data-phase="open"]').waitFor();
        expect(await notice.locator(".chat-run-failure__log").textContent()).toBe(summary);
        const before = await takeControlUiScreenshotFrame(page, notice, [toggle, report], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, "default-feedback-clean.png"), before.png);
        await page.getByRole("button", { name: "Use plugin feedback", exact: true }).click();
        const receipt = notice.locator("[data-plugin-failure-feedback]");
        await expect
          .poll(() => receipt.textContent())
          .toContain("Synthetic report ID: fixture-report");
        expect(await report.count()).toBe(0);
        expect(await toggle.getAttribute("aria-expanded")).toBe("true");
        expect(await notice.locator(".chat-run-failure__log").textContent()).toBe(summary);
        const request = await gateway.waitForRequest("fixture.failureFeedback");
        expect(request.params).toEqual({
          sessionKey,
          agentId: "main",
          runId: "failed-example-run",
          repeatCount: 1,
        });
        expect(
          await receipt.getByRole("link", { name: "Example log artifact" }).getAttribute("href"),
        ).toBe("https://example.invalid/synthetic-log.zip");
        const after = await takeControlUiScreenshotFrame(page, notice, [toggle, receipt], {
          animations: "disabled",
        });
        await writeFile(path.join(suite.artifactDir, "plugin-feedback-clean.png"), after.png);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        expect(await gateway.getRequests("agent")).toHaveLength(0);
        await gateway.setMethodResponse("plugins.controlUi.list", {
          revision: "disabled",
          plugins: [],
          diagnostics: [],
        });
        await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "disabled" });
        await report.waitFor();
        expect(await receipt.count()).toBe(0);
        expect(await notice.locator(".chat-run-failure__log").textContent()).toBe(summary);
        expect(await page.locator(".agent-chat__input textarea").count()).toBe(1);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });
});
