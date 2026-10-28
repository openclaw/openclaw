import { chromium, type Browser } from "playwright";
import { expect, it } from "vitest";
import { createDarkDesktopControlUiContextOptions } from "../../e2e/control-ui-browser-options.test-support.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
it.skipIf(!canRunPlaywrightChromium(executablePath))(
  "publishes the reviewed selection after closing a pending publish and retrying its failure",
  async () => {
    const server = await startControlUiE2eServer();
    let browser: Browser | undefined;
    try {
      browser = await chromium.launch({ executablePath });
      const page = await browser.newPage(createDarkDesktopControlUiContextOptions());
      const draftId = "ec8f46b0-4ca3-4991-8a73-dfdcc8764087";
      const optionalFile = "workspace/checklist.md";
      const scope = { input: "Repository", job: "Summarize", output: "Brief", authority: "Read" };
      const reviewed = {
        revision: "a".repeat(64),
        reviewToken: "b".repeat(64),
        publisher: "maker",
        name: "@maker/release-brief",
        displayName: "Release Brief",
        version: "0.1.0",
        description: "Summarizes releases",
        items: [
          {
            id: `file:${optionalFile}`,
            kind: "file",
            label: optionalFile,
            detail: "Check each date and citation.",
            included: true,
          },
        ],
        files: [
          { path: "CLAW.md", content: "Portable release instructions" },
          { path: optionalFile, content: "Check each date and citation." },
        ],
        scope,
      };
      const config = { gateway: { controlUi: { experimental: { claws: true } } } };
      const gateway = await installMockGateway(page, {
        featureMethods: ["create", "read", "review", "publish"].map((op) => `claws.drafts.${op}`),
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
      const setReview = (token: string) =>
        gateway.setMethodResponse("claws.drafts.review", {
          ...reviewed,
          reviewToken: token.repeat(64),
          items: reviewed.items.map((item) => ({ ...item, included: false })),
          files: reviewed.files.filter((file) => file.path !== optionalFile),
        });
      const waitForRequests = (method: string, count: number) =>
        expect.poll(async () => (await gateway.getRequests(method)).length).toBe(count);
      await page.goto(`${server.baseUrl}claws?draft=${draftId}&agent=main`);
      const dialog = page.getByRole("dialog", { name: "Review your Claw" });
      await dialog.waitFor();
      expect(await dialog.getByText("View", { exact: true }).count()).toBe(1);
      expect(await dialog.getByLabel("Description").inputValue()).toBe("Summarizes releases");
      await setReview("d");
      await dialog.getByRole("checkbox", { name: optionalFile }).uncheck();
      await waitForRequests("claws.drafts.review", 2);
      await gateway.deferNext("claws.drafts.publish");
      await dialog.getByRole("button", { name: "Publish to ClawHub" }).click();
      await gateway.waitForRequest("claws.drafts.publish");
      await expect
        .poll(() => dialog.locator("button.btn.primary").getAttribute("aria-busy"))
        .toBe("true");
      await dialog.locator(".btn__spinner").waitFor({ state: "visible" });
      await dialog.getByRole("button", { name: "Ask for changes" }).click();
      await dialog.waitFor({ state: "detached" });
      await gateway.rejectDeferred("claws.drafts.publish", {
        code: "UNAVAILABLE",
        message: "The package upload was interrupted.",
      });
      const publicationError = page.getByRole("alert");
      await publicationError.waitFor();
      expect(await publicationError.textContent()).toContain("The package upload was interrupted.");
      expect(await page.getByRole("button", { name: "Review Claw package" }).count()).toBe(0);
      await setReview("e");
      await publicationError.getByRole("button", { name: "Retry review" }).click();
      await waitForRequests("claws.drafts.review", 3);
      await dialog.getByRole("button", { name: "Publish to ClawHub" }).click();
      await waitForRequests("claws.drafts.publish", 2);
      const published = await gateway.getRequests("claws.drafts.publish");
      expect(published[1]?.params).toMatchObject({
        reviewToken: "e".repeat(64),
        choices: {
          excluded: [`file:${optionalFile}`],
        },
      });
      await page
        .getByText("Submitted to ClawHub. Publication pending security review.")
        .waitFor({ state: "visible" });
      await page.getByRole("button", { name: "View on ClawHub" }).waitFor({ state: "visible" });
      expect(await page.locator(".claw-creator__notice").count()).toBe(0);
      expect(await dialog.count()).toBe(0);
    } finally {
      await browser?.close();
      await server.close();
    }
  },
);
