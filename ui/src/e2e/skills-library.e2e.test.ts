import type { Page } from "playwright";
import { expect, it } from "vitest";
import type {
  SkillsLibraryListResult,
  SkillsLibraryReceipt,
} from "../../../packages/gateway-protocol/src/index.ts";
import { installMockGateway, reconnectMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { buildSkillLibraryMock } from "../test-helpers/skill-library-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Custom skill libraries" });
const own = buildSkillLibraryMock()[0];
const shared = buildSkillLibraryMock()[1];
const team = buildSkillLibraryMock()[2];
const list: SkillsLibraryListResult = {
  entries: [own.entry, shared.entry, team.entry],
  profileId: "profile-alice",
  multipleProfiles: true,
  defaultTarget: "personal",
  canManageWorkspace: false,
  defaultSelectionLimit: 64,
};
const published: SkillsLibraryReceipt = {
  state: "published",
  target: "personal",
  entry: { ...own.entry, revision: "2".repeat(64) },
  sessionActivation: "new-sessions",
  nextAction: "Refresh explicitly in existing sessions.",
};
const status = {
  workspaceDir: "/tmp/synthetic-workspace",
  managedSkillsDir: "/tmp/synthetic-skills",
  skills: [],
};

async function openSkillSettings(page: Page) {
  await page.goto(`${suite.server.baseUrl}skills`);
  await page.getByRole("button", { name: "Skill settings", exact: true }).click();
  await page.waitForURL(`${suite.server.baseUrl}settings/skills?agent=main`);
}

async function expectLibraryDialogOpen(page: Page) {
  const dialog = page.locator("openclaw-modal-dialog dialog");
  await dialog.evaluate(async (element) => {
    await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
  expect(await dialog.isVisible()).toBe(true);
}

// The Skills editor now uses the shared showConfirmDialog (an openclaw-modal-dialog
// mounted in document.body with exec-approval-actions) instead of a browser-native
// window.confirm, so Playwright's page.on("dialog") can no longer intercept it.
async function answerSharedConfirm(page: Page, message: string, action: "confirm" | "cancel") {
  const dialog = page.locator("openclaw-modal-dialog").filter({ hasText: message });
  await dialog.getByText(message, { exact: false }).waitFor();
  await dialog.evaluate(async (element) => {
    await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
  const label = action === "confirm" ? "Confirm" : "Cancel";
  await dialog.getByRole("button", { name: label, exact: true }).click();
}

async function expectSkillNameValidation(page: Page) {
  await expectLibraryDialogOpen(page);
  const input = page.getByLabel("Skill name", { exact: true });
  await input.hover();
  await page
    .locator("openclaw-tooltip[open] .tooltip-content")
    .getByText("Use 1–63 lowercase letters, digits, or hyphens; start with a letter or digit.", {
      exact: true,
    })
    .waitFor({ state: "visible" });
  for (const [name, valid] of [
    ["a", true],
    ["0", true],
    ["a--", true],
    ["a".repeat(63), true],
    ["", false],
    ["UPPER", false],
    ["has space", false],
    ["under_score", false],
    ["é", false],
    ["-leading", false],
  ] as const) {
    await input.fill(name);
    expect(await input.evaluate((element: HTMLInputElement) => element.checkValidity()), name).toBe(
      valid,
    );
  }
}

suite.define(() => {
  it("keeps workspace creation for a solo shared-token admin with many channel identities", async () => {
    await suite.withPage({}, async ({ page }) => {
      const proposal = {
        record: { id: "proposal-synthetic", status: "pending" },
        content: "Draft",
        revisionHash: "a".repeat(64),
      };
      const gateway = await installMockGateway(page, {
        presenceUsers: [
          { id: "channel-1", name: "Sender one" },
          { id: "channel-2", name: "Sender two" },
          { id: "channel-3", name: "Sender three" },
        ],
        methodResponses: {
          "skills.library.list": {
            entries: [],
            profileId: null,
            multipleProfiles: false,
            defaultTarget: "workspace",
            canManageWorkspace: true,
            defaultSelectionLimit: 64,
          },
          "skills.status": status,
          "skills.proposals.create": proposal,
          "skills.proposals.apply": {
            record: { ...proposal.record, status: "applied" },
            targetSkillFile: "/tmp/synthetic-workspace/skills/checklist/SKILL.md",
          },
        },
      });
      await openSkillSettings(page);
      await page.getByRole("button", { name: "Create skill", exact: true }).click();
      expect(await page.getByText("My skills", { exact: true }).count()).toBe(0);
      expect(await page.getByText("Team", { exact: true }).count()).toBe(0);
      await page.getByLabel("Skill name", { exact: true }).fill("checklist");
      await page.getByLabel("Description", { exact: true }).fill("A repeatable checklist");
      await page
        .getByLabel("SKILL.md", { exact: true })
        .fill("---\nname: checklist\ndescription: A repeatable checklist\n---\nDo the work.\n");
      await page.getByRole("button", { name: "Save workspace proposal" }).click();
      const request = await gateway.waitForRequest("skills.proposals.create");
      expect(request.params).toMatchObject({ agentId: "main", name: "checklist" });
      await page.getByText(/pending review and is not active yet/u).waitFor();
      expect(await gateway.getRequests("skills.proposals.apply")).toHaveLength(0);
      await page.getByRole("button", { name: "Apply to workspace" }).click();
      expect((await gateway.waitForRequest("skills.proposals.apply")).params).toEqual({
        agentId: "main",
        proposalId: "proposal-synthetic",
        expectedRevisionHash: "a".repeat(64),
      });
      await page.getByText(/Workspace main: applied/u).waitFor();
      expect(await gateway.getRequests("skills.library.save")).toHaveLength(0);
    });
  });

  it("saves and edits an operator's complete bundle, preserving a stale draft on a narrow viewport", async () => {
    await suite.withPage({ viewport: { width: 375, height: 844 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.write"],
        methodResponses: {
          "skills.library.list": list,
          "skills.status": status,
          "skills.library.read": own,
          "skills.library.save": published,
        },
      });
      await openSkillSettings(page);
      await page.getByRole("button", { name: "Create skill", exact: true }).click();
      await expectSkillNameValidation(page);
      await page.getByLabel("Skill name", { exact: true }).fill("a".repeat(64));
      expect(await page.getByLabel("Skill name", { exact: true }).inputValue()).toBe(
        "a".repeat(63),
      );
      await page.getByLabel("Skill name", { exact: true }).fill("release-notes");
      await page.getByLabel("SKILL.md", { exact: true }).fill(own.content);
      await page.getByLabel("SKILL.md", { exact: true }).press("Control+Enter");
      expect((await gateway.waitForRequest("skills.library.save")).params).toEqual({
        slug: "release-notes",
        content: own.content,
        files: [],
        expectedRevision: null,
      });
      await page.getByText(/Saved release-notes to personal library/u).waitFor();
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: /release-notes Draft concise/u }).click();
      expect((await gateway.waitForRequest("skills.library.read")).params).toEqual({
        skillId: own.entry.skillId,
      });
      await expect
        .poll(() => page.getByLabel("SKILL.md", { exact: true }).inputValue())
        .toBe(own.content);
      const currentRevision = "b".repeat(64);
      const externalContent = `${own.content}\nSaved by another editor.\n`;
      await gateway.setMethodResponse("skills.library.read", {
        ...own,
        entry: { ...own.entry, revision: currentRevision },
        content: externalContent,
      });
      await page.getByLabel("File", { exact: true }).selectOption("references/checklist.md");
      expect(
        await page.getByLabel("references/checklist.md", { exact: true }).inputValue(),
      ).toContain("Confirm the behavior");
      await page.getByLabel("File", { exact: true }).selectOption("assets/sample.bin");
      await page.getByText(/original bytes are preserved/u).waitFor();
      await page.getByLabel("Executable supporting file").check();
      await page.getByLabel("File", { exact: true }).selectOption("SKILL.md");
      const draft = `${own.content}\nKeep this draft.\n`;
      await page.getByLabel("SKILL.md", { exact: true }).fill(draft);
      const discardMessage = "Discard your unsaved skill changes?";
      await page.keyboard.press("Escape");
      await answerSharedConfirm(page, discardMessage, "cancel");
      await expectLibraryDialogOpen(page);
      expect(await page.getByLabel("SKILL.md", { exact: true }).inputValue()).toBe(draft);
      await gateway.deferNext("skills.library.save");
      await page.getByRole("button", { name: "Save skill", exact: true }).click();
      await expect
        .poll(async () => (await gateway.getRequests("skills.library.save")).length)
        .toBe(2);
      const saves = await gateway.getRequests("skills.library.save");
      expect(await page.getByRole("button", { name: "Close", exact: true }).isDisabled()).toBe(
        true,
      );
      await page.keyboard.press("Escape");
      await expectLibraryDialogOpen(page);
      expect(saves[1]?.params).toEqual({
        skillId: own.entry.skillId,
        slug: own.entry.slug,
        expectedRevision: own.entry.revision,
        content: draft,
        files: own.files.map((file) =>
          file.path === "assets/sample.bin" ? { ...file, executable: true } : file,
        ),
      });
      await gateway.rejectDeferred("skills.library.save", {
        code: "INVALID_REQUEST",
        message: "Concurrent update",
        details: { code: "SKILL_LIBRARY_CONFLICT", currentRevision },
      });
      await page.getByRole("alert").filter({ hasText: "Your draft is preserved" }).waitFor();
      expect(await page.getByLabel("SKILL.md", { exact: true }).inputValue()).toBe(draft);
      const form = page.locator("form.skill-reader-dialog");
      expect(await form.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
        true,
      );
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await answerSharedConfirm(page, "Discard your unsaved skill changes?", "confirm");
      await page.getByRole("button", { name: "Import skill", exact: true }).click();
      const importer = page.locator("openclaw-modal-dialog");
      await importer.getByLabel("Skill name", { exact: true }).waitFor();
      expect(await importer.getByLabel("Skill name", { exact: true }).inputValue()).toBe("");
      expect(await importer.getByRole("alert").allTextContents()).toEqual([]);
      expect(await importer.getByRole("status").allTextContents()).toEqual([]);
      expect(
        await importer
          .locator(".skill-reader-dialog__body")
          .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      await importer.getByLabel("Skill name", { exact: true }).fill("abandoned-import");
      await importer.locator('input[name="library-import-files"]').setInputFiles({
        name: "notes.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Missing SKILL.md"),
      });
      await importer.getByRole("button", { name: "Import skill", exact: true }).click();
      await importer.getByRole("alert").waitFor();
      await importer.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "Import skill", exact: true }).click();
      await importer.getByLabel("Skill name", { exact: true }).waitFor();
      expect(await importer.getByLabel("Skill name", { exact: true }).inputValue()).toBe("");
      expect(await importer.getByRole("alert").count()).toBe(0);
      expect(
        await importer.getByRole("button", { name: "Import skill", exact: true }).isDisabled(),
      ).toBe(true);
      await importer.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "Create skill", exact: true }).click();
      expect(await page.getByLabel("SKILL.md", { exact: true }).inputValue()).toBe("");
      expect(await page.locator("openclaw-modal-dialog").getByRole("alert").count()).toBe(0);
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: /release-notes Draft concise/u }).click();
      await expect
        .poll(() => page.getByLabel("SKILL.md", { exact: true }).inputValue())
        .toBe(externalContent);
      for (const method of [
        "skills.install",
        "skills.update",
        "config.patch",
        "skills.library.activate",
      ]) {
        expect(await gateway.getRequests(method)).toHaveLength(0);
      }
    });
  });

  it.each([1280, 375])(
    "keeps the file picker aligned through add, select, delete and keyboard save at %ipx",
    async (width) => {
      await suite.withPage({ viewport: { width, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          operatorScopes: ["operator.read", "operator.write"],
          methodResponses: {
            "skills.library.list": list,
            "skills.status": status,
            "skills.library.save": published,
          },
        });
        await openSkillSettings(page);
        await page.getByRole("button", { name: "Create skill", exact: true }).click();
        await page.getByLabel("Skill name", { exact: true }).fill("release-notes");
        const skill = page.getByLabel("SKILL.md", { exact: true });
        await skill.fill(own.content);
        await page.getByLabel("New text file path", { exact: true }).fill("references/lilac.txt");
        await page.getByRole("button", { name: "Add file", exact: true }).press("Enter");
        const support = page.getByLabel("references/lilac.txt", { exact: true });
        await support.fill("Supporting instructions.\n");
        const picker = page.getByLabel("File", { exact: true });
        expect(await picker.inputValue()).toBe("references/lilac.txt");
        expect(await support.inputValue()).toBe("Supporting instructions.\n");
        await support.press("Control+Enter");
        expect((await gateway.waitForRequest("skills.library.save")).params).toEqual({
          slug: "release-notes",
          content: own.content,
          files: [
            {
              path: "references/lilac.txt",
              content: "Supporting instructions.\n",
              encoding: "utf8",
            },
          ],
          expectedRevision: null,
        });
        await page.getByText(/Saved release-notes to personal library/u).waitFor();
        expect(await picker.inputValue()).toBe("references/lilac.txt");
        expect(await support.inputValue()).toBe("Supporting instructions.\n");
        await picker.selectOption("SKILL.md");
        expect(await skill.inputValue()).toBe(own.content);
        await picker.selectOption("references/lilac.txt");
        expect(await support.inputValue()).toBe("Supporting instructions.\n");
        const deleteFile = page.getByRole("button", { name: "Delete file", exact: true });
        // The saved receipt precedes refresh completion; press() does not wait for enabled controls.
        await expect.poll(() => deleteFile.isEnabled()).toBe(true);
        await deleteFile.press("Enter");
        await answerSharedConfirm(
          page,
          "Remove references/lilac.txt from the next saved bundle?",
          "confirm",
        );
        await picker.locator('option[value="references/lilac.txt"]').waitFor({ state: "detached" });
        expect(await picker.inputValue()).toBe("SKILL.md");
        expect(await skill.inputValue()).toBe(own.content);
        expect(await picker.locator('option[value="references/lilac.txt"]').count()).toBe(0);
        await skill.press("Control+Enter");
        await expect
          .poll(async () => (await gateway.getRequests("skills.library.save")).length)
          .toBe(2);
        expect((await gateway.getRequests("skills.library.save"))[1]?.params).toEqual({
          skillId: published.entry.skillId,
          expectedRevision: published.entry.revision,
          slug: "release-notes",
          content: own.content,
          files: [],
        });
      });
    },
  );

  it("imports local support files privately and keeps shared entries read-only", async () => {
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.write"],
        methodResponses: {
          "skills.library.list": list,
          "skills.status": status,
          "skills.library.read": {
            cases: [
              { match: { skillId: shared.entry.skillId }, response: shared },
              { match: { skillId: team.entry.skillId }, response: team },
            ],
          },
          "skills.library.save": published,
        },
      });
      await openSkillSettings(page);
      await page.getByRole("button", { name: "Import skill", exact: true }).click();
      await expectSkillNameValidation(page);
      await page.getByLabel("Skill name", { exact: true }).fill("a".repeat(64));
      expect(
        await page
          .getByLabel("Skill name", { exact: true })
          .evaluate((element: HTMLInputElement) => element.checkValidity()),
      ).toBe(false);
      await page.getByLabel("Skill name", { exact: true }).fill("checklist");
      const chooseFiles = page.getByRole("button", { name: "Choose files", exact: true });
      const [fileChooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        chooseFiles.press("Enter"),
      ]);
      const selectedFiles = [
        { name: "SKILL.md", mimeType: "text/markdown", buffer: Buffer.from(own.content) },
        { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("untouched\r\n") },
      ];
      await fileChooser.setFiles(selectedFiles);
      await page.getByText("2 files · SKILL.md, notes.txt", { exact: true }).waitFor();
      const importSkill = page
        .locator("openclaw-modal-dialog")
        .getByRole("button", { name: "Import skill", exact: true });
      await page.getByRole("button", { name: "Clear", exact: true }).click();
      expect(await importSkill.isDisabled()).toBe(true);
      expect(await page.getByText(/SKILL.md, notes.txt/u).count()).toBe(0);
      expect(await gateway.getRequests("skills.library.save")).toHaveLength(0);
      const [reselection] = await Promise.all([
        page.waitForEvent("filechooser"),
        chooseFiles.press("Enter"),
      ]);
      await reselection.setFiles(selectedFiles);
      await importSkill.click();
      await page.getByRole("button", { name: "Save skill", exact: true }).click();
      expect((await gateway.waitForRequest("skills.library.save")).params).toMatchObject({
        expectedRevision: null,
        slug: "checklist",
        files: [
          {
            path: "notes.txt",
            content: Buffer.from("untouched\r\n").toString("base64"),
            encoding: "base64",
          },
        ],
      });
      await page.getByText(/Saved release-notes to personal library/u).waitFor();
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("radio", { name: "Team", exact: true }).click();
      await page.getByRole("button", { name: /release-notes Prepare the team's/u }).click();
      await page.getByText(/Only its owner or an authorized administrator/u).waitFor();
      expect(await page.getByRole("button", { name: "Transfer to team" }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Share with team" }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Save skill", exact: true }).count()).toBe(0);
      expect(await page.getByLabel("Executable supporting file").count()).toBe(0);
      await page.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: /support-triage Turn a support report/u }).click();
      await page
        .getByText(`Team · revision ${team.entry.revision.slice(0, 8)}`, { exact: true })
        .waitFor();
      expect(await page.getByText(team.entry.skillId, { exact: true }).isVisible()).toBe(false);
      await page.getByText("Skill details", { exact: true }).click();
      await page.getByText(team.entry.skillId, { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Save skill", exact: true }).count()).toBe(0);
      expect(await gateway.getRequests("skills.install")).toHaveLength(0);
      expect(await gateway.getRequests("skills.update")).toHaveLength(0);
    });
  });

  it("uploads chosen ZIP bytes privately and reports the committed library", async () => {
    await suite.withPage({}, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      const bytes = Buffer.from([80, 75, 3, 4, 0, 255, 13, 10]);
      const uploadId = "44444444-4444-4444-8444-444444444444";
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.write"],
        methodResponses: {
          "skills.library.list": list,
          "skills.library.upload": {
            cases: [
              {
                match: { action: "begin" },
                response: { uploadId, offset: 0, maxChunkBytes: 256000 },
              },
              {
                match: { action: "chunk" },
                response: { uploadId, offset: bytes.length, maxChunkBytes: 256000 },
              },
              { match: { action: "commit" }, response: published },
            ],
          },
        },
      });
      await openSkillSettings(page);
      await page.getByRole("button", { name: "Import skill", exact: true }).click();
      await page.getByLabel("Skill name", { exact: true }).fill("release-notes");
      await page
        .locator('input[name="library-import-files"]')
        .setInputFiles({ name: "release-notes.zip", mimeType: "application/zip", buffer: bytes });
      expect(await gateway.getRequests("skills.library.upload")).toHaveLength(0);
      await gateway.deferNext("skills.library.upload");
      await page
        .locator("openclaw-modal-dialog")
        .getByRole("button", { name: "Import skill", exact: true })
        .click();
      await gateway.waitForRequest("skills.library.upload");
      await page.keyboard.press("Escape");
      await expectLibraryDialogOpen(page);
      await gateway.resolveDeferred("skills.library.upload", {
        uploadId,
        offset: 0,
        maxChunkBytes: 256000,
      });
      await page.getByText(/Saved release-notes to personal library/u).waitFor();
      const requests = await gateway.getRequests("skills.library.upload");
      expect(requests.map((request) => request.params)).toEqual([
        {
          action: "begin",
          slug: "release-notes",
          sizeBytes: bytes.length,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
        { action: "chunk", uploadId, offset: 0, data: bytes.toString("base64") },
        { action: "commit", uploadId },
      ]);
      expect(await gateway.getRequests("skills.install")).toHaveLength(0);
      expect(await gateway.getRequests("skills.library.save")).toHaveLength(0);
      expect(pageErrors).toEqual([]);
    });
  });

  it("uses stable identity for share, transfer, rollback, and removal receipts", async () => {
    await suite.withPage({}, async ({ page }) => {
      const oldRevision = "0".repeat(64);
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "skills.library.list": { ...list, canManageWorkspace: true },
          "skills.status": status,
          "skills.library.read": {
            ...own,
            revisions: [...own.revisions, { revision: oldRevision, createdAt: 1 }],
          },
          "skills.library.mutate": published,
        },
      });
      await openSkillSettings(page);
      await page.getByRole("button", { name: /release-notes Draft concise/u }).click();
      await page.getByRole("button", { name: "Share with team", exact: true }).click();
      expect((await gateway.waitForRequest("skills.library.mutate")).params).toMatchObject({
        skillId: own.entry.skillId,
        expectedRevision: own.entry.revision,
        action: "share",
      });
      await page.getByText(/Saved release-notes to personal library/u).waitFor();
      const restored = { ...published.entry, revision: oldRevision };
      await gateway.setMethodResponse("skills.library.mutate", { ...published, entry: restored });
      await gateway.setMethodResponse("skills.library.read", {
        ...own,
        entry: restored,
        content: `${own.content}Restored instructions.\n`,
      });
      await page.getByLabel("Retained revision").selectOption(oldRevision);
      await page.getByRole("button", { name: "Restore revision" }).click();
      await expect
        .poll(async () => (await gateway.getRequests("skills.library.mutate")).length)
        .toBe(2);
      expect((await gateway.getRequests("skills.library.mutate"))[1]?.params).toMatchObject({
        skillId: own.entry.skillId,
        action: "rollback",
        revision: oldRevision,
      });
      await expect
        .poll(() => page.getByLabel("SKILL.md", { exact: true }).inputValue())
        .toContain("Restored instructions.");
      expect((await gateway.getRequests("skills.library.read"))[1]?.params).toEqual({
        skillId: own.entry.skillId,
        revision: oldRevision,
      });
      await gateway.setMethodResponse("skills.library.mutate", {
        ...published,
        target: "team",
        entry: { ...published.entry, ownerProfileId: null, ownerLabel: "Team", shared: true },
      });
      await page.getByRole("button", { name: "Transfer to team", exact: true }).click();
      await answerSharedConfirm(
        page,
        "Transfer release-notes to team ownership? Team administrators will manage it.",
        "confirm",
      );
      await page.getByText(/Saved release-notes to team library/u).waitFor();
      await page
        .getByText(`Team · revision ${published.entry.revision.slice(0, 8)}`, { exact: true })
        .waitFor();
      const disabledNotice =
        "Disabled for new-session defaults. Existing sessions retain their selected revision; explicit attachment remains available.";
      await gateway.setMethodResponse("skills.library.mutate", {
        ...published,
        target: "team",
        entry: {
          ...published.entry,
          ownerProfileId: null,
          ownerLabel: "Team",
          shared: true,
          enabled: false,
        },
        nextAction: disabledNotice,
      });
      await page.getByRole("button", { name: "Disable", exact: true }).click();
      await page.getByText(disabledNotice, { exact: false }).waitFor();
      expect(await page.getByText(/Available in new sessions/u).count()).toBe(0);
      await page.getByRole("button", { name: "Enable", exact: true }).waitFor();
      await gateway.setMethodResponse("skills.library.mutate", {
        ...published,
        state: "removed",
        target: "team",
        entry: { ...published.entry, removed: true, ownerProfileId: null, ownerLabel: "Team" },
        nextAction:
          "Existing sessions retain their pinned revision. Create a new skill to add it to future sessions.",
      });
      await page.getByRole("button", { name: "Remove skill", exact: true }).click();
      await answerSharedConfirm(page, "Remove release-notes from the library?", "confirm");
      await page.getByText(/Removed release-notes from team library/u).waitFor();
      expect(
        (await gateway.getRequests("skills.library.mutate")).map(
          (request) => (request.params as { action: string }).action,
        ),
      ).toEqual(["share", "rollback", "transfer", "disable", "remove"]);
    });
  });
  it("cancels a pending confirm dialog when the Skills owner resets", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.write"],
        methodResponses: {
          "skills.library.list": list,
          "skills.status": status,
          "skills.library.save": published,
        },
      });
      await openSkillSettings(page);
      await page.getByRole("button", { name: "Create skill", exact: true }).click();
      await page.getByLabel("Skill name", { exact: true }).fill("release-notes");
      const skill = page.getByLabel("SKILL.md", { exact: true });
      await skill.fill(own.content);
      await page.getByLabel("New text file path", { exact: true }).fill("references/lilac.txt");
      await page.getByRole("button", { name: "Add file", exact: true }).press("Enter");
      const picker = page.getByLabel("File", { exact: true });
      await picker.selectOption("SKILL.md");
      await picker.selectOption("references/lilac.txt");
      const deleteFile = page.getByRole("button", { name: "Delete file", exact: true });
      await expect.poll(() => deleteFile.isEnabled()).toBe(true);
      await deleteFile.press("Enter");

      const message = "Remove references/lilac.txt from the next saved bundle?";
      const dialog = page.locator("openclaw-modal-dialog").filter({ hasText: message });
      await dialog.getByText(message).waitFor();
      await dialog.evaluate(async (element) => {
        await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      });
      expect(await dialog.isVisible()).toBe(true);

      // Gateway disconnect triggers owner reset, which aborts the pending confirmation.
      await gateway.closeLatest(1001, "mock Gateway restart");

      // The pending confirm dialog is removed from the DOM.
      await expect.poll(() => dialog.count()).toBe(0);

      // Reconnect and prove the confirmation lock was released by opening and
      // answering a *new* confirmation — not just checking the old dialog is gone.
      await reconnectMockGateway(page, gateway);
      await page.getByRole("button", { name: "Create skill", exact: true }).click();
      await page.getByLabel("Skill name", { exact: true }).fill("release-notes");
      await skill.fill(own.content);
      await page.getByLabel("New text file path", { exact: true }).fill("references/violet.txt");
      await page.getByRole("button", { name: "Add file", exact: true }).press("Enter");
      await page.getByLabel("File", { exact: true }).selectOption("references/violet.txt");
      await expect.poll(() => deleteFile.isEnabled()).toBe(true);
      await deleteFile.press("Enter");

      const secondMessage = "Remove references/violet.txt from the next saved bundle?";
      const secondDialog = page.locator("openclaw-modal-dialog").filter({ hasText: secondMessage });
      await secondDialog.getByText(secondMessage).waitFor();
      expect(await secondDialog.isVisible()).toBe(true);
      await secondDialog.getByRole("button", { name: "Confirm", exact: true }).click();

      // The second confirmation was answered successfully — the lock was released.
      await page.locator('option[value="references/violet.txt"]').waitFor({ state: "detached" });

      // No stale dialog from the aborted confirmation remains.
      expect(await dialog.count()).toBe(0);
    });
  });

  it("preserves the draft and file when the confirm dialog is dismissed via Escape", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.write"],
        methodResponses: {
          "skills.library.list": list,
          "skills.status": status,
          "skills.library.save": published,
        },
      });
      await openSkillSettings(page);
      await page.getByRole("button", { name: "Create skill", exact: true }).click();
      await page.getByLabel("Skill name", { exact: true }).fill("release-notes");
      const skill = page.getByLabel("SKILL.md", { exact: true });
      await skill.fill(own.content);
      await page.getByLabel("New text file path", { exact: true }).fill("references/lilac.txt");
      await page.getByRole("button", { name: "Add file", exact: true }).press("Enter");
      const picker = page.getByLabel("File", { exact: true });
      await picker.selectOption("references/lilac.txt");
      const support = page.getByLabel("references/lilac.txt", { exact: true });
      const supportContent = "Supporting instructions.\n";
      await support.fill(supportContent);
      const deleteFile = page.getByRole("button", { name: "Delete file", exact: true });
      await expect.poll(() => deleteFile.isEnabled()).toBe(true);
      await deleteFile.press("Enter");

      const message = "Remove references/lilac.txt from the next saved bundle?";
      const dialog = page.locator("openclaw-modal-dialog").filter({ hasText: message });
      await dialog.getByText(message).waitFor();
      await dialog.evaluate(async (element) => {
        await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      });
      expect(await dialog.isVisible()).toBe(true);

      // Escape triggers modal-cancel on the shared confirm dialog, which
      // resolves it as false without mutating the draft.
      await page.keyboard.press("Escape");
      await expect.poll(() => dialog.count()).toBe(0);

      // The Skills editor dialog is still open — only the confirm was dismissed.
      await expectLibraryDialogOpen(page);

      // Record scroll position before dismissal.
      const scrollBeforeEscape = await page.evaluate(() => ({
        x: window.scrollX,
        y: window.scrollY,
      }));

      // Focus returns to the Delete file button (the control that opened the
      // confirmation), identified by its accessible name. The modal dialog
      // restores focus asynchronously via setTimeout(0), so poll for it.
      await expect
        .poll(() =>
          page.evaluate(() => {
            const active = document.activeElement;
            return (
              active instanceof HTMLElement &&
              (active.textContent?.trim() === "Delete file" ||
                active.closest("button")?.textContent?.trim() === "Delete file")
            );
          }),
        )
        .toBe(true);

      // Scroll position is unchanged.
      const scrollAfterEscape = await page.evaluate(() => ({
        x: window.scrollX,
        y: window.scrollY,
      }));
      expect(scrollAfterEscape).toEqual(scrollBeforeEscape);

      // The file, its content, and the SKILL.md content are all preserved.
      expect(await picker.inputValue()).toBe("references/lilac.txt");
      expect(await support.inputValue()).toBe(supportContent);
      await picker.selectOption("SKILL.md");
      expect(await page.getByLabel("SKILL.md", { exact: true }).inputValue()).toBe(own.content);

      // No library save was requested.
      expect(await gateway.getRequests("skills.library.save")).toHaveLength(0);
    });
  });

  it("preserves the draft and file when the confirm dialog is dismissed via backdrop click", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.write"],
        methodResponses: {
          "skills.library.list": list,
          "skills.status": status,
          "skills.library.save": published,
        },
      });
      await openSkillSettings(page);
      await page.getByRole("button", { name: "Create skill", exact: true }).click();
      await page.getByLabel("Skill name", { exact: true }).fill("release-notes");
      const skill = page.getByLabel("SKILL.md", { exact: true });
      await skill.fill(own.content);
      await page.getByLabel("New text file path", { exact: true }).fill("references/lilac.txt");
      await page.getByRole("button", { name: "Add file", exact: true }).press("Enter");
      const picker = page.getByLabel("File", { exact: true });
      await picker.selectOption("references/lilac.txt");
      const support = page.getByLabel("references/lilac.txt", { exact: true });
      const supportContent = "Supporting instructions.\n";
      await support.fill(supportContent);
      const deleteFile = page.getByRole("button", { name: "Delete file", exact: true });
      await expect.poll(() => deleteFile.isEnabled()).toBe(true);
      await deleteFile.press("Enter");

      const message = "Remove references/lilac.txt from the next saved bundle?";
      const dialog = page.locator("openclaw-modal-dialog").filter({ hasText: message });
      await dialog.getByText(message).waitFor();
      await dialog.evaluate(async (element) => {
        await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      });
      expect(await dialog.isVisible()).toBe(true);

      // Record scroll position before dismissal to verify it doesn't change.
      const scrollBefore = await page.evaluate(() => ({
        x: window.scrollX,
        y: window.scrollY,
      }));

      // Click the backdrop — a real pointer event on the overlay area outside
      // the dialog panel. The native <dialog> fills the viewport; clicking a
      // corner (outside the centered panel) triggers pointerdown → requestClose.
      const panelBox = await dialog.evaluate((element) => {
        const wa = element.shadowRoot?.querySelector("wa-dialog");
        const nativeDialog = wa?.shadowRoot?.querySelector("dialog");
        const rect = nativeDialog?.getBoundingClientRect();
        return rect
          ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
          : null;
      });
      // Click at a point guaranteed to be outside the panel but inside the dialog overlay.
      const clickX = panelBox ? Math.max(2, panelBox.left - 20) : 2;
      const clickY = panelBox ? Math.max(2, panelBox.top - 20) : 2;
      await page.mouse.click(clickX, clickY);
      await expect.poll(() => dialog.count()).toBe(0);

      // The Skills editor dialog is still open — only the confirm was dismissed.
      await expectLibraryDialogOpen(page);

      // Focus returns to the Delete file button (the control that opened the
      // confirmation), identified by its accessible name.
      await expect
        .poll(() =>
          page.evaluate(() => {
            const active = document.activeElement;
            return (
              active instanceof HTMLElement &&
              (active.textContent?.trim() === "Delete file" ||
                active.closest("button")?.textContent?.trim() === "Delete file")
            );
          }),
        )
        .toBe(true);

      // Scroll position is unchanged — the page did not jump.
      const scrollAfter = await page.evaluate(() => ({
        x: window.scrollX,
        y: window.scrollY,
      }));
      expect(scrollAfter).toEqual(scrollBefore);

      // The file, its content, and the SKILL.md content are all preserved.
      expect(await picker.inputValue()).toBe("references/lilac.txt");
      expect(await support.inputValue()).toBe(supportContent);
      await picker.selectOption("SKILL.md");
      expect(await page.getByLabel("SKILL.md", { exact: true }).inputValue()).toBe(own.content);

      // No library save was requested.
      expect(await gateway.getRequests("skills.library.save")).toHaveLength(0);
    });
  });

  it("does not mutate a stale draft when a late confirmation resolves", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        operatorScopes: ["operator.read", "operator.write"],
        methodResponses: {
          "skills.library.list": list,
          "skills.status": status,
          "skills.library.save": published,
        },
      });
      await openSkillSettings(page);
      await page.getByRole("button", { name: "Create skill", exact: true }).click();
      await page.getByLabel("Skill name", { exact: true }).fill("release-notes");
      const skill = page.getByLabel("SKILL.md", { exact: true });
      await skill.fill(own.content);
      await page.getByLabel("New text file path", { exact: true }).fill("references/lilac.txt");
      await page.getByRole("button", { name: "Add file", exact: true }).press("Enter");
      const picker = page.getByLabel("File", { exact: true });
      await picker.selectOption("references/lilac.txt");
      const deleteFile = page.getByRole("button", { name: "Delete file", exact: true });
      await expect.poll(() => deleteFile.isEnabled()).toBe(true);
      await deleteFile.press("Enter");

      const message = "Remove references/lilac.txt from the next saved bundle?";
      const dialog = page.locator("openclaw-modal-dialog").filter({ hasText: message });
      await dialog.getByText(message).waitFor();
      await dialog.evaluate(async (element) => {
        await Promise.allSettled(element.getAnimations().map((animation) => animation.finished));
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      });
      expect(await dialog.isVisible()).toBe(true);

      // While the confirmation is pending, invalidate the draft so the captured
      // target is stale. The controller's re-check (library.draft !== draft)
      // must prevent the late confirmation from mutating anything.
      await page.evaluate(() => {
        const skillsPage = document.querySelector("openclaw-skills-page") as {
          library?: { draft: unknown };
        };
        if (skillsPage?.library) {
          skillsPage.library.draft = null;
        }
      });

      // Confirm the stale dialog — it should resolve but not delete the file
      // because the draft reference no longer matches.
      await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
      await expect.poll(() => dialog.count()).toBe(0);

      // The file is still present in the picker — the stale-target guard
      // (library.draft !== draft) prevented the late confirmation from removing it.
      expect(await picker.locator('option[value="references/lilac.txt"]').count()).toBe(1);

      // No library save was requested.
      expect(await gateway.getRequests("skills.library.save")).toHaveLength(0);
    });
  });
});
