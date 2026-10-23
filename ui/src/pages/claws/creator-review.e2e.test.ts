import { writeFile } from "node:fs/promises";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
let browser: Browser;
let server: ControlUiE2eServer;

describe.skipIf(!canRunPlaywrightChromium(executablePath))(
  "Claw creator review in the main chat",
  () => {
    beforeAll(async () => {
      server = await startControlUiE2eServer(undefined, { source: true });
      browser = await chromium.launch({ executablePath });
    });
    afterAll(async () => {
      await browser?.close();
      await server?.close();
    });

    it("opens a compact package modal, removes an optional file, and submits the reviewed selection", async () => {
      const context = await browser.newContext({
        locale: "en-US",
        colorScheme: "dark",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 900 },
      });
      const page = await context.newPage();
      const draftId = "ec8f46b0-4ca3-4991-8a73-dfdcc8764087";
      const scope = {
        input: "A public repository",
        job: "Summarize its releases",
        output: "A release brief",
        authority: "Read public sources only",
      };
      const reviewed = {
        revision: "a".repeat(64),
        reviewToken: "b".repeat(64),
        publisher: "maker",
        name: "@maker/release-brief",
        displayName: "Release Brief",
        version: "0.1.0",
        description: "Summarizes releases for a new user.",
        items: [
          {
            id: "file:workspace/checklist.md",
            kind: "file",
            label: "workspace/checklist.md",
            detail: "Check each date and citation.",
            included: true,
          },
          {
            id: "package:plugin:@maker/github",
            kind: "plugin",
            label: "@maker/github",
            detail: "clawhub · 2.0.0",
            included: true,
          },
        ],
        files: [
          { path: "CLAW.md", content: "Portable release instructions" },
          { path: "package.json", content: '{"name":"@maker/release-brief"}' },
          { path: "workspace/checklist.md", content: "Check each date and citation." },
        ],
        scope,
      };
      const config = { gateway: { controlUi: { experimental: { claws: true } } } };
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "claws.drafts.create",
          "claws.drafts.read",
          "claws.drafts.review",
          "claws.drafts.publish",
        ],
        methodResponses: {
          "config.get": {
            config,
            sourceConfig: config,
            hash: "claws-review-config",
            valid: true,
            issues: [],
          },
          "claws.drafts.read": {
            content: JSON.stringify({ name: "release-brief", scope }),
            revision: reviewed.revision,
          },
          "claws.drafts.review": reviewed,
          "claws.drafts.publish": {
            name: reviewed.name,
            version: reviewed.version,
            url: "https://clawhub.ai/maker/claws/release-brief",
            publicationStatus: "pending",
          },
        },
      });
      try {
        await page.goto(`${server.baseUrl}claws?draft=${draftId}&agent=main`);
        const dialog = page.getByRole("dialog", { name: "Review your Claw" });
        await dialog.waitFor();
        expect(await dialog.getByLabel("Name").inputValue()).toBe("Release Brief");
        expect(await dialog.getByText(/Publishing as/u).count()).toBe(0);
        expect(await dialog.getByText("Inspect", { exact: true }).count()).toBe(0);
        expect(await dialog.getByText("View", { exact: true }).count()).toBe(2);
        expect(await dialog.getByLabel("Description").inputValue()).toBe(
          "Summarizes releases for a new user.",
        );
        expect(await dialog.getByRole("textbox", { name: /JSON/i }).count()).toBe(0);
        await gateway.setMethodResponse("claws.drafts.review", {
          ...reviewed,
          reviewToken: "c".repeat(64),
          displayName: "Engineering Partner",
        });
        await dialog.getByLabel("Name").fill("Engineering Partner");
        await expect
          .poll(async () => (await gateway.getRequests("claws.drafts.review")).length)
          .toBe(2);
        const nameReview = await gateway.getRequests("claws.drafts.review");
        expect(nameReview[1]?.params).toMatchObject({
          choices: { displayName: "Engineering Partner" },
        });
        expect(await dialog.getByLabel("Name").inputValue()).toBe("Engineering Partner");
        if (process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1") {
          const dir = createControlUiE2eArtifactDir("claw-creator-review");
          const frame = await takeControlUiScreenshotFrame(
            page,
            dialog,
            [dialog.getByLabel("Name"), dialog.getByLabel("Description")],
            { animations: "disabled", elements: [dialog] },
          );
          await writeFile(`${dir}/review.png`, frame.png);
        }

        await gateway.setMethodResponse("claws.drafts.review", {
          ...reviewed,
          reviewToken: "d".repeat(64),
          displayName: "Engineering Partner",
          items: reviewed.items.map((item) =>
            item.kind === "file" ? { ...item, included: false } : item,
          ),
          files: reviewed.files.filter((file) => file.path !== "workspace/checklist.md"),
        });
        await dialog.getByRole("checkbox", { name: "workspace/checklist.md" }).uncheck();
        await expect
          .poll(async () => (await gateway.getRequests("claws.drafts.review")).length)
          .toBe(3);
        const requests = await gateway.getRequests("claws.drafts.review");
        expect(requests[2]?.params).toMatchObject({
          choices: {
            displayName: "Engineering Partner",
            excluded: ["file:workspace/checklist.md"],
          },
        });
        await gateway.deferNext("claws.drafts.publish");
        await dialog.getByRole("button", { name: "Publish to ClawHub" }).click();
        await gateway.waitForRequest("claws.drafts.publish");
        await dialog.getByRole("button", { name: "Refresh review" }).waitFor({
          state: "detached",
        });
        await expect
          .poll(() => dialog.locator("button.btn.primary").getAttribute("aria-busy"))
          .toBe("true");
        expect(await dialog.locator("openclaw-modal-actions button").count()).toBe(2);
        await dialog.locator(".btn__spinner").waitFor({ state: "visible" });
        await dialog.getByRole("button", { name: "Ask for changes" }).click();
        await dialog.waitFor({ state: "detached" });
        await gateway.rejectDeferred("claws.drafts.publish", {
          code: "UNAVAILABLE",
          message: "The package upload was interrupted.",
        });
        const publicationError = page.getByRole("alert");
        await publicationError.waitFor();
        expect(await publicationError.textContent()).toContain(
          "The package upload was interrupted.",
        );
        expect(await page.getByRole("button", { name: "Review Claw package" }).count()).toBe(0);
        await gateway.setMethodResponse("claws.drafts.review", {
          ...reviewed,
          reviewToken: "e".repeat(64),
          displayName: "Engineering Partner",
          items: reviewed.items.map((item) =>
            item.kind === "file" ? { ...item, included: false } : item,
          ),
          files: reviewed.files.filter((file) => file.path !== "workspace/checklist.md"),
        });
        await publicationError.getByRole("button", { name: "Retry review" }).click();
        await expect
          .poll(async () => (await gateway.getRequests("claws.drafts.review")).length)
          .toBe(4);
        await expect
          .poll(() => dialog.getByRole("button", { name: "Publish to ClawHub" }).isEnabled())
          .toBe(true);
        await dialog.getByRole("button", { name: "Publish to ClawHub" }).click();
        await expect
          .poll(async () => (await gateway.getRequests("claws.drafts.publish")).length)
          .toBe(2);
        const published = await gateway.getRequests("claws.drafts.publish");
        expect(published[1]?.params).toMatchObject({
          reviewToken: "e".repeat(64),
          choices: {
            displayName: "Engineering Partner",
            excluded: ["file:workspace/checklist.md"],
          },
        });
        await page
          .getByText("Submitted to ClawHub. Publication pending security review.")
          .waitFor({ state: "visible" });
        await page.getByRole("button", { name: "View on ClawHub" }).waitFor({ state: "visible" });
        expect(await page.locator(".claw-creator__notice").count()).toBe(0);
        await page.mouse.move(0, 0);
        await page
          .getByText("Submitted to ClawHub. Publication pending security review.")
          .waitFor({ state: "hidden", timeout: 8000 });
        expect(await dialog.count()).toBe(0);
      } finally {
        await context.close();
      }
    });
  },
);
