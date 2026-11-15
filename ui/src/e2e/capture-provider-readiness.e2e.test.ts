import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { meetingStatus } from "../test-helpers/transcripts.test-support.ts";
import { configSnapshot } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Capture provider readiness",
  startServerBeforeBrowser: true,
});
suite.define(() => {
  it("does not recommend provider setup while capture health is unknown", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 1100 }, locale: "en-US", serviceWorkers: "block" },
      async ({ page }) => {
        const configured = meetingStatus.configuredSources[0]!;
        const source = {
          ...configured.source,
          title: configured.title,
          sessionId: configured.sessionId,
        };
        const config = { transcripts: { enabled: true, autoStart: [source] } };
        const gateway = await installMockGateway(page, {
          featureMethods: [...defaultControlUiFeatureMethods, "transcripts.status"],
          heldMethods: ["transcripts.status"],
          methodResponses: {
            "config.get": {
              ...configSnapshot(config, "capture-readiness", true),
              appliedConfigHash: "capture-readiness",
            },
            "transcripts.status": meetingStatus,
          },
        });
        await page.goto(suite.server.baseUrl + "settings/communications?section=transcripts");
        await gateway.waitForRequest("transcripts.status");
        const capture = page.locator("openclaw-meeting-capture-settings");
        await capture.getByRole("button", { name: "Edit source 1", exact: true }).click();
        const form = capture.locator("form");
        await form.getByRole("button", { name: "Save source", exact: true }).waitFor();
        const hint = form.getByText("Auto-start setup is unavailable for this provider.", {
          exact: false,
        });
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const artifacts = createControlUiE2eArtifactDir("capture-provider-readiness");
          const frame = await takeControlUiScreenshotFrame(page, form, [form], {
            animations: "disabled",
            scrollTo: form,
            elements: [form],
          });
          await writeFile(path.join(artifacts, "pending-provider.png"), frame.png);
        }
        expect
          .soft(
            await hint.count(),
            "A pending health read is not proof that provider setup is unavailable",
          )
          .toBe(0);
        await gateway.resolveDeferred("transcripts.status", meetingStatus);
        await hint.waitFor({ state: "hidden" });
        const title = form.getByRole("textbox", { name: "Title", exact: true });
        await title.fill("Keep this source draft");
        const after = await gateway.deferNext("transcripts.status");
        await capture.getByRole("button", { name: "Refresh", exact: true }).click();
        await gateway.waitForRequest("transcripts.status", { after });
        expect
          .soft(await hint.count(), "A routine health refresh should not prescribe plugin setup")
          .toBe(0);
        await gateway.setMethodResponse("transcripts.status", {
          __mockError: { code: "UNAVAILABLE", message: "Synthetic capture health read failed" },
        });
        await gateway.rejectDeferred("transcripts.status", {
          code: "UNAVAILABLE",
          message: "Synthetic capture health read failed",
        });
        await capture
          .getByRole("alert")
          .filter({ hasText: "Synthetic capture health read failed" })
          .waitFor();
        expect
          .soft(await hint.count(), "A failed read is not evidence of a disabled provider")
          .toBe(0);
        expect(await title.inputValue()).toBe("Keep this source draft");
        await gateway.setMethodResponse("transcripts.status", meetingStatus);
        await capture.getByRole("button", { name: "Refresh", exact: true }).click();
        await hint.waitFor({ state: "hidden" });
        expect(await title.inputValue()).toBe("Keep this source draft");
        await gateway.setMethodResponse("transcripts.status", {
          ...meetingStatus,
          providers: meetingStatus.providers.map((provider) => ({ ...provider, canStart: false })),
        });
        await capture.getByRole("button", { name: "Refresh", exact: true }).click();
        await hint.waitFor();
        expect(
          await form.getByRole("button", { name: "Save source", exact: true }).isEnabled(),
        ).toBe(true);
        const knownRefresh = await gateway.deferNext("transcripts.status");
        await capture.getByRole("button", { name: "Refresh", exact: true }).click();
        await gateway.waitForRequest("transcripts.status", { after: knownRefresh });
        expect(await hint.isVisible()).toBe(true);
        await gateway.resolveDeferred("transcripts.status", meetingStatus);
        await hint.waitFor({ state: "hidden" });
        for (const method of ["config.set", "config.patch", "transcripts.start"]) {
          expect(await gateway.getRequests(method)).toHaveLength(0);
        }
      },
    );
  });
});
