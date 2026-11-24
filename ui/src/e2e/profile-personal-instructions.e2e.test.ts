import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Personal instructions recovery readiness" });
const profile = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Test Person",
  emails: ["test@example.test"],
  avatarMime: null,
  hasAvatar: false,
  githubIdentity: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
};
const file = {
  agentId: "main",
  profileId: profile.id,
  content: "Keep it concise.",
  hash: "saved-1",
  missing: false,
};

suite.define(() => {
  it("offers draft recovery only when personal instructions contain unsaved edits", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 1000 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          hasMultipleSessionSharingIdentities: true,
          presenceUsers: [{ id: profile.id, name: profile.displayName, self: true }],
          deferredMethods: ["users.personalFile.get"],
          methodResponses: {
            "users.self": { profile },
            "users.personalFile.get": file,
            "users.prefs.get": { status: "ok", entries: {} },
          },
        });
        await page.goto(suite.server.baseUrl + "settings/profile");
        await gateway.waitForRequest("users.personalFile.get");
        const section = page.locator("openclaw-personal-instructions");
        await section.waitFor();
        const editor = section.getByRole("textbox", { name: "Personal instructions", exact: true });
        const copyAdvice = section.getByText(/Your draft is unchanged/);
        expect(await editor.count()).toBe(0);
        await gateway.rejectDeferred("users.personalFile.get", {
          code: "UNAVAILABLE",
          message: "Could not read personal instructions",
        });
        const error = section.getByRole("alert");
        await error.waitFor();
        expect(await error.textContent()).toContain("Could not read personal instructions");
        expect(await editor.count()).toBe(0);
        const needlessRecovery = await copyAdvice.count();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(page, section, [error], {
            animations: "disabled",
            scrollTo: section,
          });
          await writeFile(path.join(suite.artifactDir, "first-read-error.png"), frame.png);
        }
        await section.getByRole("button", { name: "Reload", exact: true }).click();
        await editor.waitFor();
        expect(await editor.inputValue()).toBe(file.content);
        expect(await copyAdvice.count()).toBe(0);
        await editor.fill("Keep this unsaved draft.");
        await gateway.deferNext("users.personalFile.set");
        await section.getByRole("button", { name: "Save", exact: true }).click();
        const save = await gateway.waitForRequest("users.personalFile.set");
        expect(save.params).toEqual({
          agentId: "main",
          content: "Keep this unsaved draft.",
          expectedHash: "saved-1",
        });
        await gateway.rejectDeferred("users.personalFile.set", {
          code: "CONFLICT",
          message: "Personal instructions changed elsewhere",
        });
        await copyAdvice.waitFor();
        expect(await editor.inputValue()).toBe("Keep this unsaved draft.");
        await section.getByRole("button", { name: "Reload", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        expect(await editor.inputValue()).toBe("Keep this unsaved draft.");
        await editor.fill(file.content);
        const revertedRecovery = await copyAdvice.count();
        await editor.fill("Keep this unsaved draft.");
        const reads = (await gateway.getRequests("users.personalFile.get")).length;
        await gateway.setMethodResponse("users.personalFile.get", {
          ...file,
          content: "External edit",
          hash: "saved-2",
        });
        await section.getByRole("button", { name: "Reload", exact: true }).click();
        await dialog.getByRole("button", { name: "Discard", exact: true }).click();
        await gateway.waitForRequest("users.personalFile.get", { after: reads });
        await expect.poll(() => editor.inputValue()).toBe("External edit");
        expect(await copyAdvice.count()).toBe(0);
        expect(await gateway.getRequests("users.personalFile.set")).toHaveLength(1);
        expect(revertedRecovery, "Reverted edits no longer need draft-copy recovery").toBe(0);
        expect(
          needlessRecovery,
          "There is no personal-file draft to copy after a first-read failure",
        ).toBe(0);
      },
    );
  });
});
