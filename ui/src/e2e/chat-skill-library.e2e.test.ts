import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import type {
  SkillsLibraryListResult,
  SkillsLibraryReadResult,
} from "../../../packages/gateway-protocol/src/index.ts";
import { waitForControlUiProofSurface } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
} from "../test-helpers/control-ui-e2e.ts";
import { buildSkillLibraryMock } from "../test-helpers/skill-library-fixtures.ts";
import { sessionResponseCase } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Session skill library selections" });
const [alice, bob, team] = buildSkillLibraryMock();
const sessionKey = "agent:main:alice-session";
const bobSessionKey = "agent:main:bob-session";
const bobEntry = {
  ...bob.entry,
  canEdit: true,
  description: "Prepare the team's customer-facing release summary with complete review evidence.",
};
const teamEntry = {
  ...team.entry,
  description:
    "Turn a detailed support report into a reproducible investigation for the whole team.",
};
function projection(
  selected: SkillsLibraryReadResult[],
  key = sessionKey,
): SkillsLibraryListResult {
  return {
    entries: [bobEntry, teamEntry],
    profileId: "profile-bob",
    multipleProfiles: true,
    defaultTarget: "personal",
    canManageWorkspace: false,
    defaultSelectionLimit: 64,
    session: {
      sessionKey: key,
      selections: selected.map(({ entry }) => {
        const { skillId, revision, name, ownerProfileId, ownerLabel, slug, description } = entry;
        return { skillId, revision, name, ownerProfileId, ownerLabel, slug, description };
      }),
      attachable: [bobEntry, teamEntry].filter(
        (candidate) => !selected.some(({ entry }) => entry.skillId === candidate.skillId),
      ),
    },
  };
}
async function openSkills(page: Page) {
  const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
  const menu = pane.locator(".agent-chat__capability-menu");
  if (!(await menu.evaluate((node) => node.hasAttribute("open")))) {
    await pane.getByRole("button", { name: "Add attachment", exact: true }).click();
  }
  if ((await menu.getAttribute("data-view"))?.startsWith("library:")) {
    await menu.getByRole("menuitem", { name: "Back", exact: true }).click();
  }
  const root = menu.getByRole("menuitem", { name: "Skills", exact: true });
  if ((await menu.getAttribute("data-view")) === "root") {
    await root.click();
  }
  await menu.getByText("Selected for this session", { exact: true }).waitFor();
  await waitForMenuFocusHandoff(page, menu, "skills");
  return menu;
}

async function waitForMenuFocusHandoff(page: Page, menu: Locator, view: string) {
  await expect.poll(() => menu.getAttribute("data-view")).toBe(view);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
}

function activation(selected: SkillsLibraryReadResult[]) {
  return {
    sessionKey,
    sessionActivation: "next-turn",
    selections: selected.map(({ entry }) => {
      const { skillId, name, revision, ownerProfileId } = entry;
      return { skillId, name, revision, ownerProfileId };
    }),
  };
}

async function focusFirstAction(page: Page, action: Locator) {
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => action.evaluate((node) => node.matches(":focus"))).toBe(true);
  await page.keyboard.press("Enter");
}

suite.define(() => {
  it("keeps Alice's private pin while Bob browses with operator access", async () => {
    await suite.withPage({ viewport: { width: 375, height: 844 } }, async ({ page }) => {
      const commands = [
        {
          name: alice.entry.name,
          skillDisplayName: `${alice.entry.slug} · Alice`,
          description: alice.entry.description,
          source: "skill",
          scope: "both",
          acceptsArgs: true,
          skillModelVisible: true,
          textAliases: [`/${alice.entry.name}`],
        },
      ];
      const gateway = await installMockGateway(page, {
        sessionKey,
        sessions: [
          { key: sessionKey, sessionId: "synthetic-alice-session" },
          { key: bobSessionKey, sessionId: "synthetic-bob-session" },
        ],
        operatorScopes: ["operator.read", "operator.write"],
        methodResponses: {
          "chat.startup": sessionResponseCase(
            { sessionKey },
            {
              messages: [],
              sessionId: "synthetic-alice-session",
              thinkingLevel: null,
              metadata: { commands, models: [] },
            },
          ),
          "skills.library.list": projection([alice]),
          "skills.library.read": { ...alice, entry: { ...alice.entry, canEdit: false } },
          "skills.library.activate": { sessionKey, selections: [], sessionActivation: "next-turn" },
          "chat.metadata": { commands, models: [] },
        },
      });
      const { getRequests } = gateway;
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      await gateway.waitForRequest("chat.startup");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Use $release");
      const references = page.getByRole("listbox", { name: "Skill references" });
      await references.getByRole("option").filter({ hasText: "Alice" }).waitFor();
      await composer.press("Enter");
      await expect.poll(() => composer.inputValue()).toBe(`Use $${alice.entry.name} `);
      await composer.fill("");

      let menu = await openSkills(page);
      const item = (name: string | RegExp, exact = true) =>
        menu.getByRole("menuitem", { name, exact });
      const selected = (skillId: string) =>
        menu.locator(`.oc-menu-item[data-value="library-selected:${skillId}"]`);
      expect((await gateway.waitForRequest("skills.library.list")).params).toEqual({ sessionKey });
      const aliceItem = selected(alice.entry.skillId);
      await aliceItem.waitFor();
      expect(await aliceItem.textContent()).toContain("release-notes · Alice");
      await item("Attach release-notes · Bob", false).waitFor();
      const attachables = menu.locator('.oc-menu-item[data-value^="library-attach:"]');
      const menuPanel = menu.locator(".oc-menu");
      // Visible content can still share the dropdown's opening scale animation.
      await waitForControlUiProofSurface(menuPanel, [aliceItem, attachables.first()]);
      expect(
        await attachables.evaluateAll((items) =>
          items.every((row) => {
            const note = row.querySelector<HTMLElement>(".agent-chat__capability-menu-note")!;
            return (
              note.getBoundingClientRect().height <=
              Number.parseFloat(getComputedStyle(note).lineHeight) + 1
            );
          }),
        ),
      ).toBe(true);
      expect(await attachables.first().textContent()).toContain(bobEntry.description);
      const note = attachables.first().locator(".agent-chat__capability-menu-note");
      expect(await note.getAttribute("title")).toBe(bobEntry.description);
      const listWidth = await menuPanel.evaluate((node) => node.getBoundingClientRect().width);
      await focusFirstAction(page, aliceItem);
      const readAction = item("Read selected revision");
      await waitForMenuFocusHandoff(page, menu, `library:${alice.entry.skillId}`);
      await readAction.waitFor({ state: "visible" });
      expect(await menu.getByText("release-notes · Alice", { exact: true }).count()).toBe(1);
      await waitForControlUiProofSurface(menuPanel, [
        readAction,
        menu.getByText("Selected revision 11111111", { exact: true }),
      ]);
      const actionBounds = await menuPanel.evaluate((node) =>
        node.getBoundingClientRect().toJSON(),
      );
      expect(actionBounds.width).toBeCloseTo(listWidth, 0);
      expect(actionBounds.left).toBeGreaterThanOrEqual(0);
      expect(actionBounds.right).toBeLessThanOrEqual(375);
      const actions = menu.locator('.oc-menu-item[data-value^="library-"]');
      for (const action of await actions.all()) {
        expect(await action.isVisible()).toBe(true);
        expect(
          await action.evaluate(
            (node) =>
              node.scrollWidth <= node.clientWidth + 1 && node.getBoundingClientRect().right <= 375,
          ),
        ).toBe(true);
      }
      await focusFirstAction(page, readAction);
      await page.getByLabel("SKILL.md", { exact: true }).waitFor();
      expect((await gateway.waitForRequest("skills.library.read")).params).toEqual({
        sessionKey,
        skillId: alice.entry.skillId,
        revision: alice.entry.revision,
      });
      expect(await page.getByLabel("SKILL.md", { exact: true }).inputValue()).toBe(alice.content);
      expect(await page.getByRole("button", { name: "Save skill", exact: true }).count()).toBe(0);
      expect(await page.getByLabel("Retained revision", { exact: true }).count()).toBe(0);
      const panel = page.locator(".skill-reader-dialog");
      expect(await panel.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      expect(await getRequests("skills.library.activate")).toHaveLength(0);
      await page.getByRole("button", { name: "Close", exact: true }).click();

      menu = await openSkills(page);
      await item("Back").click();
      await item(/^Plugins/u, false).click();
      await item("Add MCP server…").waitFor();
      expect(await menu.getByText("Selected for this session", { exact: true }).count()).toBe(0);
      expect(await menu.getByText("Add from your libraries", { exact: true }).count()).toBe(0);
      expect(await menu.locator('.oc-menu-item[data-value^="library-"]').count()).toBe(0);
      await item("Back").click();
      menu = await openSkills(page);
      await gateway.setMethodResponse("skills.library.list", projection([]));
      const metadataBeforeActivation = (await getRequests("chat.metadata")).length;
      await selected(alice.entry.skillId).click();
      await item("Detach").click();
      expect((await gateway.waitForRequest("skills.library.activate")).params).toEqual({
        action: "detach",
        sessionKey,
        skillId: alice.entry.skillId,
      });
      await menu.getByText("No managed skills selected.", { exact: true }).waitFor();
      await gateway.waitForRequest("chat.metadata", { after: metadataBeforeActivation });
      await menu.getByText(/updated for the next turn/u).waitFor();

      await gateway.setMethodResponse("skills.library.activate", activation([bob]));
      await gateway.setMethodResponse("skills.library.list", projection([bob]));
      await item("Attach release-notes · Bob", false).click();
      await expect.poll(async () => (await getRequests("skills.library.activate")).length).toBe(2);
      expect((await getRequests("skills.library.activate"))[1]?.params).toEqual({
        action: "attach",
        sessionKey,
        skillId: bob.entry.skillId,
        revision: bob.entry.revision,
      });
      const bobItem = selected(bob.entry.skillId);
      await bobItem.waitFor();
      const newer = { ...bob, entry: { ...bob.entry, revision: "2".repeat(64) } };
      await gateway.setMethodResponse("skills.library.activate", activation([newer]));
      await gateway.setMethodResponse("skills.library.list", projection([newer]));
      await bobItem.click();
      await item("Refresh revision").click();
      await expect.poll(async () => (await getRequests("skills.library.activate")).length).toBe(3);
      expect((await getRequests("skills.library.activate"))[2]?.params).toEqual({
        action: "refresh",
        sessionKey,
        skillId: bob.entry.skillId,
      });
      await menu.getByText("Selected revision 22222222", { exact: true }).waitFor();
      await menu.getByText(/updated for the next turn/u).waitFor();

      await gateway.setMethodResponse("skills.library.list", projection([], bobSessionKey));
      await navigateToControlUiSession(page, bobSessionKey);
      menu = await openSkills(page);
      await menu.getByText("No managed skills selected.", { exact: true }).waitFor();
      expect((await getRequests("skills.library.list")).at(-1)?.params).toEqual({
        sessionKey: bobSessionKey,
      });
      expect(await getRequests("skills.library.activate")).toHaveLength(3);
      expect(await getRequests("skills.library.save")).toHaveLength(0);
      expect(await getRequests("sessions.patch")).toHaveLength(0);
    });
  });
});
