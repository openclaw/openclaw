import type { Page } from "playwright";
import { expect as expectBrowser } from "playwright/test";
import { afterEach, expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  pauseVirtualClock,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../test-helpers/control-ui-navigation.ts";
import { closeChatDetails, openChatDetailsPeople } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { replaceGatewayClient } from "./new-session-page.test-support.ts";
import { waitForMobileSidebarDrawerOpen } from "./session-management.test-support.ts";
import {
  collaborativeSessionsList,
  draftSessionsList,
  ownerRoster,
  sessionPerson,
  sessionsList,
} from "./session-ownership-fixtures.test-support.ts";
import {
  openSidebarSortMenu,
  routeAvatarFixtures,
} from "./session-ownership-visuals.test-support.ts";
import {
  chooseSidebarOwner,
  chooseSidebarMenuOption,
  closeSidebarMenu,
  openSidebarMenu,
} from "./sidebar-session-menu.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session ownership",
});

let activePage: Page | undefined;

function ownerSessions(visibility: "draft" | "shared", single = false) {
  const sessions = visibility === "draft" ? draftSessionsList() : sessionsList();
  const active = sessions.sessions[0];
  if (!active) {
    throw new Error("expected owner session fixture");
  }
  Object.assign(active, { visibility, sharingRole: "owner" });
  if (single) {
    sessions.count = 1;
    sessions.owners = [active.owner.actor];
    sessions.sessions = [active];
  }
  return sessions;
}

async function newPage(width = 1200) {
  const context = await suite.browser.newContext({ viewport: { height: 800, width } });
  activePage = await context.newPage();
  return activePage;
}

const chatMethods = ["chat.metadata", "chat.startup"];
const visibilityMethods = [...chatMethods, "session.visibility.set"];
const memberMethods = [
  "session.members.listEvidence",
  "session.members.add",
  "session.members.remove",
];

async function openSession(
  list: unknown,
  scenario: ControlUiMockGatewayScenario = {},
  options: {
    width?: number;
    clock?: boolean;
    avatars?: Parameters<typeof routeAvatarFixtures>[1];
  } = {},
) {
  const page = await newPage(options.width);
  await routeAvatarFixtures(page, options.avatars ?? []);
  const gateway = await installMockGateway(page, {
    sessionKey: "agent:main:ada",
    historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
    ...scenario,
    methodResponses: { "sessions.list": list, ...scenario.methodResponses },
  });
  if (options.clock) {
    await page.clock.install();
  }
  await page.goto(
    controlUiSessionUrl(suite.server.baseUrl, scenario.sessionKey ?? "agent:main:ada"),
  );
  return { page, gateway };
}

async function chooseOwner(page: Page, value: string) {
  await chooseSidebarOwner(page, value);
  await closeSidebarMenu(page);
}

function geometry(element: Element) {
  const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return {
    left,
    right,
    top,
    bottom,
    width,
    height,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    scrollTop: element.scrollTop,
    padding: Number.parseFloat(style.paddingInlineStart),
    position: style.position,
  };
}

suite.define(() => {
  afterEach(async () => {
    await activePage
      ?.context()
      .close()
      .catch(() => {});
    activePage = undefined;
  });

  it("keeps collaborative owner stacks legible without shifting session rows", async () => {
    const { page } = await openSession(
      collaborativeSessionsList(),
      {
        hasMultipleSessionSharingIdentities: true,
        sessionKey: "agent:main:collaboration",
      },
      {
        avatars: [
          { id: "profile-ada", background: "#3f6f76", label: "A" },
          { id: "profile-bob", background: "#985b42", label: "B" },
        ],
      },
    );
    const collaborativeRow = page.locator('[data-session-key="agent:main:collaboration"]');
    const overflowRow = page.locator('[data-session-key="agent:main:release-planning"]');
    const singleOwnerRow = page.locator('[data-session-key="agent:main:single-owner"]');
    await collaborativeRow.waitFor();
    await overflowRow.waitFor();
    await singleOwnerRow.waitFor();
    await expect.poll(() => collaborativeRow.locator(".session-owner-stack img").count()).toBe(2);
    await expect
      .poll(() =>
        collaborativeRow
          .locator(".session-owner-stack img")
          .evaluateAll((images) =>
            images.every(
              (image) =>
                image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
            ),
          ),
      )
      .toBe(true);

    const [stack, back, front, slot, text] = await Promise.all(
      [
        ".session-owner-stack",
        ".session-owner-stack__back .viewer-avatar",
        ".session-owner-stack__front",
        ".sidebar-session-indicator",
        ".sidebar-recent-session__text",
      ].map((selector) => collaborativeRow.locator(selector).evaluate(geometry)),
    );
    if (!stack || !back || !front || !slot || !text) {
      throw new Error("expected complete collaborative row geometry");
    }
    const size = (bounds: typeof stack) => [Math.round(bounds.width), Math.round(bounds.height)];
    const stackGeometry = {
      backSize: size(back),
      frontSize: size(front),
      stackSize: size(stack),
      centerDelta: stack.left + stack.width / 2 - (slot.left + slot.width / 2),
      overlap: back.right - front.left,
      reveal: front.left - back.left,
      slotWidth: slot.width,
      textGap: text.left - stack.right,
    };
    expect(stackGeometry).toEqual({
      backSize: [18, 18],
      centerDelta: 0,
      frontSize: [18, 18],
      overlap: 8,
      reveal: 10,
      slotWidth: 20,
      stackSize: [28, 20],
      textGap: 4,
    });
    await expectBrowser(overflowRow.locator(".session-owner-stack__overflow")).toHaveText("+2");
    const [collaborative, single] = await Promise.all(
      [collaborativeRow, singleOwnerRow].map((row) =>
        row.evaluate((element) => ({
          height: element.getBoundingClientRect().height,
          titleLeft: element.querySelector(".sidebar-recent-session__text")?.getBoundingClientRect()
            .left,
        })),
      ),
    );
    expect(collaborative?.height).toBeCloseTo(single?.height ?? 0, 5);
    expect(collaborative?.titleLeft).toBeCloseTo(single?.titleLeft ?? 0, 5);
  });

  it.each([1200, 390])("keeps inline-owner activity last at %ipx", async (width) => {
    const patrick = sessionPerson("profile-patrick", "Patrick");
    const mira = sessionPerson("profile-mira", "Mira");
    const states: Array<[string, Record<string, unknown>]> = [
      ["idle", {}],
      ["unread", { unread: true }],
      ["running", { hasActiveRun: true, status: "running", activeRunIds: ["run-1"] }],
      ["parent", { hasActiveRun: true, status: "running", childSessions: ["agent:main:child"] }],
    ];
    const rows = states.map(([id, state], index) =>
      Object.assign(
        {
          key: `agent:main:${id}`,
          kind: "direct",
          label: `Inline ${id} session`,
          createdActor: patrick,
          owner: { actor: patrick },
          updatedAt: 10 - index,
        },
        state,
      ),
    );
    rows.push({
      key: "agent:main:child",
      kind: "direct",
      label: "Inline child session",
      createdActor: patrick,
      owner: { actor: patrick },
      spawnedBy: "agent:main:parent",
      updatedAt: 2,
    });
    rows.push({
      key: "agent:main:mira",
      kind: "direct",
      label: "Mira session",
      createdActor: mira,
      owner: { actor: mira },
      updatedAt: 1,
    });
    const { page } = await openSession(
      ownerRoster(rows, [patrick, mira]),
      {
        sessionKey: "agent:main:mira",
        presenceUsers: [{ self: true, id: "profile-patrick", name: "Patrick" }],
      },
      { width },
    );
    if (width === 390) {
      await navigationDrawerToggle(page).click();
    }
    await page.getByText("Inline idle session", { exact: true }).waitFor();
    await chooseSidebarMenuOption(page, "Group by", "Person");
    await closeSidebarMenu(page);
    await chooseOwner(page, "owner:profile-patrick");
    // The picker helper's Escape also dismisses the mobile drawer.
    if (width === 390) {
      await navigationDrawerToggle(page).click();
      await waitForMobileSidebarDrawerOpen(page);
    }
    const group = page.locator(".sidebar-recent-sessions__group--inline-owner");
    const row = (id: string) => group.locator(`[data-session-key="agent:main:${id}"]`);
    await row("running").locator(".session-glyph__ring").waitFor();
    await row("unread").locator(".session-unread-dot").waitFor();
    // Park the pointer away from the list so no row shows hover actions.
    await page.mouse.move(1100, 700);

    const rowGeometry = (id: string) =>
      row(id).evaluate((element) => {
        const box = (selector: string) => element.querySelector(selector)?.getBoundingClientRect();
        return {
          top: element.getBoundingClientRect().top,
          right: element.getBoundingClientRect().right,
          text: box(".sidebar-recent-session__text"),
          indicator: box(".sidebar-session-indicator:not(:empty)"),
          actions: box(".session-row-actions"),
          toggle: box("[data-child-session-toggle]"),
        };
      });
    const header = await page
      .locator("#sidebar-session-owner-title")
      .evaluate((element) => element.getBoundingClientRect().bottom);
    const [idle, unread, running] = await Promise.all([
      rowGeometry("idle"),
      rowGeometry("unread"),
      rowGeometry("running"),
    ]);
    expect(idle.top - header).toBeLessThanOrEqual(12);
    expect(idle.indicator).toBeUndefined();
    for (const status of [unread, running]) {
      expect(status.text?.left).toBeCloseTo(idle.text?.left ?? 0, 5);
      expect(status.indicator?.left).toBeGreaterThanOrEqual(status.text?.right ?? Infinity);
    }

    // Hover actions must appear before the fixed trailing status, not push it left.
    await row("running").hover();
    await expectBrowser(row("running").locator(".session-row-actions button").first()).toHaveCSS(
      "opacity",
      "1",
    );
    const hovered = await rowGeometry("running");
    expect(hovered.indicator?.left).toBeGreaterThanOrEqual(hovered.actions?.right ?? Infinity);
    expect(hovered.right - (hovered.indicator?.right ?? 0)).toBeCloseTo(
      running.right - (running.indicator?.right ?? 0),
      5,
    );
    await page.mouse.move(1100, 700);
    await row("running").locator("a").focus();
    const focused = await rowGeometry("running");
    expect(focused.indicator?.left).toBeGreaterThanOrEqual(focused.actions?.right ?? Infinity);
    expect(focused.right - (focused.indicator?.right ?? 0)).toBeCloseTo(
      running.right - (running.indicator?.right ?? 0),
      5,
    );
    await page.locator("#sidebar-session-owner-title").focus();
    await page.mouse.move(width - 10, 700);
    await expectBrowser(page.locator(".session-progress-hovercard")).toBeHidden();
    await row("parent").hover();
    const parent = await rowGeometry("parent");
    expect(parent.toggle).toBeDefined();
    expect(parent.indicator?.left).toBeGreaterThanOrEqual(parent.toggle?.right ?? Infinity);
    expect(parent.right - (parent.indicator?.right ?? 0)).toBeCloseTo(
      running.right - (running.indicator?.right ?? 0),
      5,
    );
    const toggle = row("parent").locator("[data-child-session-toggle]");
    await toggle.click();
    await expectBrowser(group.locator('[data-session-key="agent:main:child"]')).toContainText(
      "Inline child session",
    );
    await expectBrowser(toggle).toHaveAttribute("aria-expanded", "true");
  });

  it("derives People controls and owner filtering from current session owners", async () => {
    const { page, gateway } = await openSession(
      sessionsList(["profile-ada", "profile-bob"], true),
      {
        hasMultipleSessionSharingIdentities: false,
        presenceUsers: [
          {
            self: true,
            id: "profile-patrick",
            name: "Patrick",
            avatarUrl: "/api/users/profile-patrick/avatar?v=1",
          },
        ],
      },
      {
        avatars: [
          { id: "profile-patrick", background: "#27496d", label: "P" },
          { id: "profile-ada", background: "#3f6f76", label: "A" },
          { id: "profile-bob", background: "#985b42", label: "B" },
        ],
      },
    );
    await chooseOwner(page, "all");
    await page.getByText("Ada research", { exact: true }).first().waitFor();
    await page.getByText("Bob operations", { exact: true }).first().waitFor();
    await page.locator('[data-session-key="agent:main:ada"] a').click();
    await page.getByText("Ready.", { exact: true }).waitFor();
    for (const sessionKey of ["agent:main:ada", "agent:main:bob"]) {
      await expectBrowser(
        page.locator('[data-session-key="' + sessionKey + '"] openclaw-session-owner-chip'),
      ).toHaveCount(1);
    }
    const people = await openChatDetailsPeople(page);
    await expectBrowser(people.getByRole("link", { name: "Ada Owner", exact: true })).toBeVisible();
    await closeChatDetails(page);

    const ownerMenu = await openSidebarSortMenu(page);
    for (const [control, name] of [
      ["group", "Person"],
      ["sort", "Owners"],
    ]) {
      await ownerMenu.locator(`#sidebar-sessions-${control}`).click();
      await expectBrowser(ownerMenu.getByRole("option", { name, exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    }
    const ownerSelect = page.locator("#sidebar-session-owner-title");
    await ownerSelect.click();
    const ownerRows = page.locator(
      '.sidebar-session-owner-filter [role="option"][data-value^="owner:"]',
    );
    await expectBrowser(ownerRows).toHaveCount(3);
    await expectBrowser(ownerRows.first()).toHaveAttribute("data-value", "owner:profile-patrick");
    await expectBrowser(ownerRows.first()).toContainText("My sessions");

    await page.keyboard.press("Escape");
    await chooseSidebarMenuOption(ownerMenu.page(), "Group by", "Person");
    await closeSidebarMenu(page);
    await expectBrowser(
      page.locator('[data-session-section="person:profile:profile-ada"]'),
    ).toContainText("Ada research");
    await expectBrowser(
      page.locator('[data-session-section="person:profile:profile-bob"]'),
    ).toContainText("Bob operations");

    const groupedMenu = await openSidebarSortMenu(page);
    await expectBrowser(groupedMenu.locator("#sidebar-sessions-group")).toHaveAccessibleName(
      "Group by: Person",
    );
    await chooseSidebarMenuOption(groupedMenu.page(), "Group by", "Custom groups");
    await closeSidebarMenu(page);

    const sortableMenu = await openSidebarSortMenu(page);
    await chooseSidebarMenuOption(sortableMenu.page(), "Sort by", "Owners");
    await closeSidebarMenu(page);
    const peopleMenu = await openSidebarSortMenu(page);
    await expectBrowser(peopleMenu.locator("#sidebar-sessions-sort")).toHaveAccessibleName(
      "Sort by: Owners",
    );

    const expectOwnerFilter = async (after: number) => {
      // The chat title survives a sidebar refresh; wait for the filtered row itself.
      await expectBrowser(page.locator('[data-session-section="category:Research"]')).toContainText(
        "Ada research",
      );
      await expectBrowser(page.locator('[data-session-key="agent:main:ada"]')).toBeVisible();
      await expectBrowser(page.locator('[data-session-key="agent:main:bob"]')).toHaveCount(0);
      await expectBrowser(page.locator('[data-session-section="category:Operations"]')).toHaveCount(
        0,
      );
      // The shared roster may also refresh, so the filtered request need not be last.
      await gateway.waitForRequest("sessions.list", { match: { ownerId: "profile-ada" }, after });
      await expectBrowser(page.locator("#sidebar-session-owner-title")).toHaveAccessibleName(
        "Owners: Ada",
      );
    };
    const beforeSelection = (await gateway.getRequests("sessions.list", { ownerId: "profile-ada" }))
      .length;
    await openSidebarMenu(page);
    await chooseOwner(page, "owner:profile-ada");
    await expectOwnerFilter(beforeSelection);

    const initialConnections = (await gateway.getRequests("connect")).length;
    const beforeReconnect = (await gateway.getRequests("sessions.list", { ownerId: "profile-ada" }))
      .length;
    await gateway.closeLatest(1012, "owner filter reconnect proof");
    await expect
      .poll(async () => (await gateway.getRequests("connect")).length)
      .toBeGreaterThan(initialConnections);
    await expectOwnerFilter(beforeReconnect);

    await page.reload();
    // Reload starts a new in-page request log, so no earlier traffic can satisfy this.
    await expectOwnerFilter(0);
  });

  it("keeps unrelated active sessions out of the involving-me filter", async () => {
    const allSessions = sessionsList(["profile-ada", "profile-bob"]);
    const { page, gateway } = await openSession(
      {
        cases: [
          {
            match: { involvingMe: true },
            response: {
              ...allSessions,
              count: 1,
              sessions: allSessions.sessions.filter((session) => session.key === "agent:main:ada"),
            },
          },
          { response: allSessions },
        ],
      },
      {
        hasMultipleSessionSharingIdentities: true,
        presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
        methodResponses: { "config.get": { config: {}, hash: "owner-filter-fixture" } },
      },
    );
    await chooseOwner(page, "all");
    await page.getByText("Bob operations", { exact: true }).first().waitFor();
    await chooseOwner(page, "involving-me");
    await expect.poll(() => page.locator('[data-session-key="agent:main:bob"]').count()).toBe(0);
    await gateway.waitForRequest("sessions.list", { match: { involvingMe: true } });

    await gateway.emitGatewayEvent("session.message", {
      sessionKey: "agent:main:bob",
      key: "agent:main:bob",
      kind: "direct",
      updatedAt: 3,
      archived: false,
      hasActiveRun: true,
      status: "running",
      owner: { actor: { type: "human", id: "profile-bob", label: "Bob" } },
      participants: [],
      participantCount: 0,
    });

    await expect.poll(() => page.locator('[data-session-key="agent:main:bob"]').count()).toBe(0);
    await expectBrowser(page.locator('[data-session-key="agent:main:ada"]')).toBeVisible();
    await expectBrowser(page.locator("#sidebar-session-owner-title")).toHaveAccessibleName(
      "Owners: Involving me",
    );

    await page.reload();
    await expectBrowser(page.locator('[data-session-key="agent:main:ada"]')).toBeVisible();
    const restored = await gateway.waitForRequest("sessions.list", {
      match: { involvingMe: true },
    });
    expect(restored.params).not.toHaveProperty("ownerId");
    await expectBrowser(page.locator('[data-session-key="agent:main:bob"]')).toHaveCount(0);
    await expectBrowser(page.locator("#sidebar-session-owner-title")).toHaveAccessibleName(
      "Owners: Involving me",
    );
  });

  it("hides owner avatars with one human and agents, then reveals them for another human", async () => {
    const solo = sessionsList(["profile-ada", "profile-ada"]);
    const identity = { type: "agent" as const, id: "research" };
    const agent = { ...identity, identity, label: "Research" };
    const result = {
      ...solo,
      owners: [...solo.owners, agent],
      sessions: solo.sessions.map((session) =>
        Object.assign({}, session, {
          participants: [{ identity: agent.identity, label: agent.label }],
          participantCount: 5,
        }),
      ),
    };
    const { page, gateway } = await openSession(
      result,
      {
        presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
      },
      { clock: true },
    );
    await chooseOwner(page, "all");
    const row = page.locator('[data-session-key="agent:main:ada"]');
    await expectBrowser(row).toBeVisible();
    await page.getByText("Ready.", { exact: true }).waitFor();

    await expectBrowser(row.locator("openclaw-session-owner-chip")).toHaveCount(0);

    await pauseVirtualClock(page);
    await page.evaluate(() => {
      Math.random = () => 0;
    });
    const rosterMatch = { includeGlobal: true };
    const initialRequests = (await gateway.getRequests("sessions.list", rosterMatch)).length;
    await gateway.setMethodResponse("sessions.list", sessionsList(["profile-ada", "profile-bob"]));
    await gateway.emitGatewayEvent("sessions.changed", {});
    await page.clock.runFor(4_999);
    expect(await gateway.getRequests("sessions.list", rosterMatch)).toHaveLength(initialRequests);
    await expectBrowser(row.locator("openclaw-session-owner-chip")).toHaveCount(0);
    // Cross the event window and deliver the nested mock response timer.
    await page.clock.runFor(2);
    expect(await gateway.getRequests("sessions.list", rosterMatch)).toHaveLength(
      initialRequests + 1,
    );
    await page.clock.resume();
    await expectBrowser(row.locator("openclaw-session-owner-chip")).toHaveCount(1);
  });

  it("keeps global session actions accessible to keyboard users", async () => {
    const { page } = await openSession(sessionsList(["profile-ada", "profile-ada"]), {
      featureMethods: [...chatMethods, "sessions.create"],
    });
    await page.getByText("Ada research", { exact: true }).first().waitFor();
    await page.getByText("Bob operations", { exact: true }).first().waitFor();

    const filterAndSort = page.getByRole("button", { name: "Filter & sort", exact: true });
    await filterAndSort.focus();
    await page.keyboard.press("Enter");

    const menu = page.locator(".sidebar-session-sort-menu");
    await menu.getByRole("dialog").waitFor();
    expect(await menu.locator("#sidebar-sessions-owner").count()).toBe(0);
    await menu.locator("#sidebar-sessions-group").click();
    expect(await menu.getByRole("option", { name: "Person", exact: true }).count()).toBe(0);
    await page.keyboard.press("Escape");
    await menu.locator("#sidebar-sessions-sort").click();
    expect(await menu.getByRole("option", { name: "Owners", exact: true }).count()).toBe(0);
    await page.keyboard.press("Escape");
    await chooseSidebarMenuOption(menu.page(), "Group by", "None");
    await closeSidebarMenu(page);

    await expect.poll(() => page.locator('[data-session-section^="category:"]').count()).toBe(0);
    const threads = page.locator('[data-session-section="ungrouped"]');
    await expect.poll(() => threads.locator(".sidebar-recent-session").count()).toBe(2);

    const newThread = page.locator(".sidebar-rail").getByRole("link", { name: "New conversation" });
    await newThread.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
  });

  it("keeps own drafts subtle and fades admin-visible drafts from other people", async () => {
    const { page } = await openSession(draftSessionsList(), {
      presenceUsers: [{ self: true, id: "profile-ada", name: "Ada" }],
      historyMessages: undefined,
    });
    await chooseOwner(page, "all");
    const ownDraft = page.locator('[data-session-key="agent:main:ada"]');
    const otherDraft = page.locator('[data-session-key="agent:main:bob"]');
    await ownDraft.waitFor();
    await otherDraft.waitFor();
    await expect
      .poll(() => ownDraft.getAttribute("class"))
      .toContain("session-row-host--draft-owner");
    await expect
      .poll(() => otherDraft.getAttribute("class"))
      .toContain("session-row-host--draft-other");
    expect(await page.locator(".session-row-draft-indicator").count()).toBe(2);
  });

  it("creates a draft atomically from the multi-person new-session flow", async () => {
    const page = await newPage();
    const gateway = await installMockGateway(page, {
      allowedSessionVisibilities: ["shared", "draft"],
      featureMethods: [...chatMethods, "sessions.create"],
      hasMultipleSessionSharingIdentities: true,
      methodResponses: {
        "sessions.list": sessionsList(["profile-ada", "profile-bob"]),
        "sessions.create": { key: "agent:main:new-draft", runStarted: true },
      },
    });

    await page.goto(`${suite.server?.baseUrl ?? ""}new`);
    // Playwright check()/isChecked() support role="switch" buttons via aria-checked.
    const draftToggle = page.getByRole("switch", { name: "Draft", exact: true });
    await page.locator(".new-session-page__composer .agent-chat__composer-footer").hover();
    await draftToggle.waitFor();

    await draftToggle.check();
    await expectBrowser(draftToggle).toBeChecked();
    await page.locator(".new-session-page__message").fill("work privately first");

    await page.getByRole("button", { name: "Start session" }).click();

    const create = await gateway.waitForRequest("sessions.create");
    expect(create.params).toMatchObject({
      agentId: "main",
      message: "work privately first",
      visibility: "draft",
    });
  });

  it("keeps rejected visibility-only sharing changes visible after the menu closes", async () => {
    const { page, gateway } = await openSession(ownerSessions("draft"), {
      allowedSessionVisibilities: ["shared", "draft"],
      deferredMethods: ["session.visibility.set"],
      featureMethods: visibilityMethods,
      operatorScopes: ["operator.write"],
    });
    await page.getByText("Ready.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Session sharing" }).click();
    const dropdown = page.locator(".chat-pane__sharing-menu");
    const panel = dropdown.locator(".chat-pane__sharing-panel");
    await expect
      .poll(() => panel.evaluate((element) => element.matches(":popover-open")))
      .toBe(true);
    await expectBrowser(dropdown.locator(".chat-pane__sharing-permissions")).toHaveCount(0);
    await dropdown.getByRole("menuitem", { name: "Session access" }).click();
    await dropdown.getByRole("menuitemradio", { name: "Shared", exact: true }).click();
    await gateway.waitForRequest("session.visibility.set");
    await page.getByRole("button", { name: "Session sharing" }).click();
    await expect
      .poll(() => panel.evaluate((element) => element.matches(":popover-open")))
      .toBe(false);
    expect(await gateway.getRequests("session.members.listEvidence")).toHaveLength(0);

    const message = "visibility change rejected";
    await gateway.rejectDeferred("session.visibility.set", {
      code: "INVALID_REQUEST",
      message,
    });
    const alert = page.locator(".chat-error[role=alert]").filter({ hasText: message });
    await expectBrowser(alert).toBeVisible();

    await page.getByRole("button", { name: "Session sharing" }).click();
    await expectBrowser(dropdown.getByRole("alert").filter({ hasText: message })).toBeVisible();
  });

  it("lets a read-scoped owner inspect sharing but blocks mutations", async () => {
    const { page, gateway } = await openSession(ownerSessions("draft"), {
      featureMethods: [...visibilityMethods, ...memberMethods],
      operatorScopes: ["operator.read"],
      methodResponses: {
        "session.members.listEvidence": {
          sessionKey: "agent:main:ada",
          members: [],
          identities: [{ type: "human", id: "profile-bob", label: "Bob" }],
          role: "owner",
          allowedVisibilities: ["shared", "draft"],
        },
      },
    });

    await page.getByText("Ready.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Session sharing", exact: true }).click();
    await gateway.waitForRequest("session.members.listEvidence");
    const dropdown = page.locator(".chat-pane__sharing-menu");
    const member = dropdown.getByRole("menuitemcheckbox", { name: "Bob", exact: true });
    await expectBrowser(member).toBeVisible();
    await expectBrowser(member).toBeDisabled();
    await member.evaluate((element) => (element as HTMLButtonElement).click());
    await dropdown.getByRole("menuitem", { name: "Session access" }).click();
    const publish = dropdown.getByRole("menuitemradio", { name: "Shared", exact: true });
    await expectBrowser(publish).toBeVisible();
    await expectBrowser(publish).toBeDisabled();
    await publish.evaluate((element) => (element as HTMLButtonElement).click());

    expect(await gateway.getRequests("session.visibility.set")).toHaveLength(0);
    expect(await gateway.getRequests("session.members.add")).toHaveLength(0);
  });

  it("scrolls the complete sharing directory while keeping access controls visible", async () => {
    const longMemberLabel =
      "Alexandria Montgomery-Santiago from the International Collaboration Working Group";
    const longMemberId = `profile:${"member-without-a-display-name-".repeat(6)}`;
    const humanIdentities = [
      { type: "human" as const, id: "profile-long-name", label: longMemberLabel },
      { type: "human" as const, id: longMemberId },
      ...Array.from({ length: 28 }, (_, index) => ({
        type: "human" as const,
        id: `profile-member-${index}`,
        label: `Member ${index + 1}`,
      })),
    ];
    const nonHumanIdentities = [
      { type: "agent" as const, id: "agent-design", label: "Design" },
      { type: "system" as const, id: "system-operations", label: "Operations" },
    ];
    const { page, gateway } = await openSession(
      ownerSessions("shared", true),
      {
        hasMultipleSessionSharingIdentities: true,
        featureMethods: [...chatMethods, ...memberMethods, "session.visibility.set"],
        operatorScopes: ["operator.read", "operator.write"],
        methodResponses: {
          "session.members.listEvidence": {
            sessionKey: "agent:main:ada",
            members: [{ identityId: longMemberId, addedBy: "profile-ada", addedAt: 1 }],
            identities: [...humanIdentities, ...nonHumanIdentities],
            role: "owner",
            allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
          },
        },
      },
      { width: 1280 },
    );

    await page.getByText("Ready.", { exact: true }).waitFor();
    await page.locator(".chat-pane__sharing-trigger").click();
    await gateway.waitForRequest("session.members.listEvidence");
    const dropdown = page.locator(".chat-pane__sharing-menu");
    const roster = dropdown.locator(".chat-pane__sharing-roster");
    const people = roster.locator(".chat-pane__sharing-person");
    await expectBrowser(people).toHaveCount(32);
    const longNameItem = dropdown.getByRole("menuitemcheckbox", {
      name: longMemberLabel,
      exact: true,
    });
    const longIdItem = dropdown.getByRole("menuitemcheckbox", {
      name: longMemberId,
      exact: true,
    });
    await longIdItem.scrollIntoViewIfNeeded();
    await expectBrowser(longIdItem).toBeChecked();
    const selectedIndicator = longIdItem.locator(".chat-pane__sharing-member-check");
    await expectBrowser(selectedIndicator).toBeVisible();
    await expectBrowser(selectedIndicator).toHaveAttribute("aria-label", "Member");
    expect(
      await longIdItem.evaluate((item) => {
        const indicator = item.querySelector<HTMLElement>(".chat-pane__sharing-member-check")!;
        const itemRect = item.getBoundingClientRect();
        const indicatorRect = indicator.getBoundingClientRect();
        return indicatorRect.left >= itemRect.left && indicatorRect.right <= itemRect.right;
      }),
    ).toBe(true);

    for (const item of [longNameItem, longIdItem]) {
      const label = item.locator(".chat-pane__sharing-member-label");
      const labelGeometry = await label.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const menu = element.closest(".chat-pane__sharing-panel")!.getBoundingClientRect();
        return {
          contained: rect.left >= menu.left && rect.right <= menu.right,
          overflow: element.scrollWidth > element.clientWidth,
          ellipsis: getComputedStyle(element).textOverflow,
        };
      });
      expect(labelGeometry).toEqual({ contained: true, overflow: true, ellipsis: "ellipsis" });
    }

    await roster.evaluate((element) => {
      element.scrollTop = 0;
    });
    const readGeometry = () =>
      dropdown.evaluate((element) => {
        const menu = element.querySelector<HTMLElement>(".chat-pane__sharing-panel")!;
        const list = element.querySelector<HTMLElement>(".chat-pane__sharing-roster")!;
        const rows = list.querySelectorAll<HTMLElement>(".chat-pane__sharing-person");
        const menuRect = menu.getBoundingClientRect();
        const listRect = list.getBoundingClientRect();
        return {
          menuTop: menuRect.top,
          menuBottom: menuRect.bottom,
          viewportHeight: innerHeight,
          menuScrollTop: menu.scrollTop,
          scrollTop: list.scrollTop,
          scrollHeight: list.scrollHeight,
          clientHeight: list.clientHeight,
          scrollWidth: list.scrollWidth,
          clientWidth: list.clientWidth,
          firstTop: rows[0]!.getBoundingClientRect().top,
          lastBottom: rows[rows.length - 1]!.getBoundingClientRect().bottom,
          listBottom: listRect.bottom,
          accessTop: element
            .querySelector<HTMLElement>('[data-value="access"]')!
            .getBoundingClientRect().top,
          permissionsTop: element
            .querySelector<HTMLElement>(
              ".chat-pane__sharing-permissions .chat-pane__sharing-section-label",
            )!
            .getBoundingClientRect().top,
        };
      });
    const beforeScroll = await readGeometry();
    await people.last().scrollIntoViewIfNeeded();
    const afterScroll = await readGeometry();
    expect(beforeScroll.menuTop).toBeGreaterThanOrEqual(0);
    expect(beforeScroll.menuBottom).toBeLessThanOrEqual(beforeScroll.viewportHeight);
    expect(beforeScroll.scrollHeight).toBeGreaterThan(beforeScroll.clientHeight);
    expect(beforeScroll.scrollWidth).toBe(beforeScroll.clientWidth);
    expect(afterScroll.scrollTop).toBeGreaterThan(0);
    expect(afterScroll.firstTop).toBeLessThan(beforeScroll.firstTop);
    expect(afterScroll.lastBottom).toBeLessThanOrEqual(afterScroll.listBottom + 1);
    expect(afterScroll.menuScrollTop).toBe(0);
    expect(afterScroll.accessTop).toBeCloseTo(beforeScroll.accessTop, 1);
    expect(afterScroll.permissionsTop).toBeCloseTo(beforeScroll.permissionsTop, 1);
    await expectBrowser(roster.locator("openclaw-session-owner-chip")).toHaveCount(30);
    // All identities share one list; owner-chip presentation remains human-only.
    await expectBrowser(roster.locator(".chat-pane__sharing-member-icon > svg")).toHaveCount(2);
    await expectBrowser(dropdown.getByRole("button", { name: "Next", exact: true })).toHaveCount(0);
    await expectBrowser(
      dropdown.getByRole("button", { name: "Previous", exact: true }),
    ).toHaveCount(0);
  });

  it("clears a selected draft mode when sharing policy becomes unavailable", async () => {
    const page = await newPage();
    const gateway = await installMockGateway(page, {
      allowedSessionVisibilities: ["shared", "draft"],
      hasMultipleSessionSharingIdentities: true,
      methodResponses: { "sessions.list": sessionsList(["profile-ada", "profile-bob"]) },
    });

    await page.goto(`${suite.server?.baseUrl ?? ""}new`);
    const draftToggle = page.getByRole("switch", { name: "Draft", exact: true });
    await page.locator(".new-session-page__composer .agent-chat__composer-footer").hover();
    await draftToggle.check();
    await gateway.setSessionSharingPolicy({
      allowedSessionVisibilities: ["shared"],
      hasMultipleSessionSharingIdentities: false,
    });
    await replaceGatewayClient(page);
    await expect
      .poll(() => page.getByRole("button", { name: "Draft", exact: true }).count())
      .toBe(0);

    await gateway.setSessionSharingPolicy({
      allowedSessionVisibilities: ["shared", "draft"],
      hasMultipleSessionSharingIdentities: true,
    });
    await replaceGatewayClient(page);
    await page.locator(".new-session-page__composer .agent-chat__composer-footer").hover();
    await draftToggle.waitFor();
    expect(await draftToggle.isChecked()).toBe(false);
  });

  it("aligns the sharing and Details icons in the session toolbar", async () => {
    const { page } = await openSession(ownerSessions("shared"), {
      featureMethods: visibilityMethods,

      operatorScopes: ["operator.write"],
    });
    await page.getByText("Ready.", { exact: true }).waitFor();
    const share = page.locator(".chat-pane__sharing-trigger");
    const details = page.locator(".chat-details-toggle");
    await share.waitFor();
    await details.waitFor();
    const measure = (trigger: typeof share) =>
      trigger.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const icon = button.querySelector("svg")!.getBoundingClientRect();
        return {
          center: icon.top + icon.height / 2,
          iconOffset: icon.top + icon.height / 2 - (bounds.top + bounds.height / 2),
        };
      });
    const [shareMetrics, detailsMetrics] = await Promise.all([measure(share), measure(details)]);
    expect(shareMetrics.center).toBeCloseTo(detailsMetrics.center, 1);
    expect(shareMetrics.iconOffset).toBeCloseTo(detailsMetrics.iconOffset, 1);
    await share.click({ trial: true });
    await details.click({ trial: true });
  });
});
