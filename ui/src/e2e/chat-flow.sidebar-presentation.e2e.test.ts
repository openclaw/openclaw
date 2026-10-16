import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  chatMessage,
  newChatPage,
  chatSessionListResponse,
  createChatFlowE2eSuite,
  expectDefined,
  expectRequestCountStable,
  controlUiSessionUrl,
  installMockGateway,
  requireRecord,
} from "./chat-flow.test-support.ts";
import { waitForSessionRosterHydration } from "./session-management.test-support.ts";
import { closeSidebarMenu, openSidebarMenu } from "./sidebar-session-menu.test-support.ts";

const suite = createChatFlowE2eSuite();
const firstKey = "agent:main:session-a";
const secondKey = "agent:main:session-b";
const rosterMatch = { includeGlobal: true };
const sessionRow = (page: Page, key: string) =>
  page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
const part = (row: Locator, name: string) => row.locator(`.sidebar-recent-session__${name}`);
const link = (row: Locator) => part(row, "link");
const archive = (row: Locator) => row.locator("[data-sidebar-session-archive]");
const opacity = (row: Locator) => row.evaluate((element) => getComputedStyle(element).opacity);
const session = (key: string, label: string, extra: Record<string, unknown> = {}) => ({
  key,
  kind: "direct",
  label,
  updatedAt: 1,
  ...extra,
});
const mask = (label: Locator) => label.evaluate((element) => getComputedStyle(element).maskImage);

async function openChat(
  key = firstKey,
  methodResponses: NonNullable<Parameters<typeof installMockGateway>[1]>["methodResponses"] = {},
  settings: { preview?: boolean; locale?: string } = {},
) {
  const page = await newChatPage(suite);
  await page.addInitScript(({ preview, locale }) => {
    if (preview) {
      localStorage.setItem("openclaw:sidebar:sessions:show-preview", "true");
    }
    if (locale) {
      localStorage.setItem("openclaw.i18n.locale", locale);
    }
  }, settings);
  const gateway = await installMockGateway(page, { methodResponses, sessionKey: key });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
  return { page, gateway };
}

async function activate(row: Locator) {
  await link(row).click();
  await expect.poll(() => row.getAttribute("class")).toContain("sidebar-recent-session--active");
}

function titleMetrics(label: Locator, direction: string) {
  return label.evaluate((element, readingDirection) => {
    const text = element.querySelector(".hover-marquee__text")!;
    const style = getComputedStyle(element);
    const transform = getComputedStyle(text).transform;
    const x = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
    const bounds = element.getBoundingClientRect();
    const textBounds = text.getBoundingClientRect();
    const row = element.closest(".sidebar-recent-session")!;
    const fade = Number.parseFloat(style.getPropertyValue("--hover-marquee-fade-width"));
    return {
      offset: x === 0 ? 0 : readingDirection === "rtl" ? -x : x,
      overflow:
        readingDirection === "rtl"
          ? bounds.left + fade - textBounds.left
          : textBounds.right - (bounds.right - fade),
      right: bounds.right,
      controlsLeft: row.querySelector(".session-row-actions")!.getBoundingClientRect().left,
      width: row.getBoundingClientRect().width,
    };
  }, direction);
}

function rowLayout(locator: Locator) {
  return locator.evaluate((row) => {
    const rect = (element: Element) => {
      const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
      return { left, right, top, bottom, width, height };
    };
    const get = (selector: string) => rect(row.querySelector(selector)!);
    const name = row.querySelector(".sidebar-recent-session__name")!;
    return {
      row: rect(row),
      name: rect(name),
      lead: get(".sidebar-session-indicator"),
      unread: get(".sidebar-session-indicator .session-unread-dot"),
      endcap: get(".sidebar-recent-session__details-endcap"),
      atoms: Array.from(row.querySelectorAll(".sidebar-recent-session__details-endcap svg"), rect),
      nameOverflowing: name.scrollWidth > name.clientWidth,
      singleLine: row.classList.contains("sidebar-recent-session--single-line"),
    };
  });
}

function expectUnreadLayout(layout: Awaited<ReturnType<typeof rowLayout>>, nameLeft: number) {
  const { unread, lead, name } = layout;
  expect(unread).toMatchObject({ width: 7, height: 7 });
  for (const [start, end] of [
    ["left", "right"],
    ["top", "bottom"],
  ] as const) {
    expect((unread[start] + unread[end]) / 2).toBeCloseTo((lead[start] + lead[end]) / 2, 1);
    expect(unread[start]).toBeGreaterThanOrEqual(lead[start]);
    expect(unread[end]).toBeLessThanOrEqual(lead[end]);
  }
  expect(lead.right).toBeLessThanOrEqual(name.left);
  expect(name.left).toBeCloseTo(nameLeft, 1);
}

suite.define(() => {
  it("keeps a running subtitle and row height stable when its session is opened", async () => {
    const running = (key: string, label: string, run: string, updatedAt = 1) =>
      session(key, label, {
        updatedAt,
        activeRunIds: [run],
        hasActiveRun: true,
        status: "running",
      });
    const { page, gateway } = await openChat(
      firstKey,
      {
        "sessions.list": chatSessionListResponse([
          running(firstKey, "First running session", "run-first", 2),
          running(secondKey, "Second running session", "run-second"),
        ]),
      },
      { preview: true },
    );
    const secondRow = sessionRow(page, secondKey);
    await expect
      .poll(async () =>
        (await gateway.getRequests("sessions.messages.subscribe")).some(
          (request) => requireRecord(request.params).key === secondKey,
        ),
      )
      .toBe(true);
    const narrationText = "Checking the running session";
    await gateway.emitGatewayEvent("chat", {
      sessionKey: secondKey,
      runId: "run-second",
      state: "delta",
      message: chatMessage("assistant", narrationText),
    });
    await gateway.emitGatewayEvent("agent", {
      sessionKey: secondKey,
      runId: "run-second",
      stream: "tool",
      data: { name: "bash", toolCallId: "sidebar-tool", phase: "start" },
    });
    await gateway.emitGatewayEvent("agent", {
      sessionKey: secondKey,
      runId: "run-second",
      stream: "item",
      data: {
        kind: "tool",
        itemId: "tool:sidebar-tool",
        toolCallId: "sidebar-tool",
        name: "bash",
        phase: "update",
        title: "Shell",
        progressText: "Checking the running session",
      },
    });
    const narration = secondRow.getByText(narrationText, { exact: true });
    const tool = secondRow.getByRole("img", { name: "Tool: bash", exact: true });
    await narration.waitFor();
    await tool.waitFor();
    expect(
      await Promise.all(
        ["title-row", "details"].map((name) =>
          part(secondRow, name).locator(".sidebar-session-tool").count(),
        ),
      ),
    ).toEqual([0, 1]);
    const heightBefore = await secondRow.evaluate((row) => row.getBoundingClientRect().height);

    await activate(secondRow);
    await narration.waitFor();
    await tool.waitFor();
    const heightAfter = await secondRow.evaluate((row) => row.getBoundingClientRect().height);

    expect(heightAfter).toBeCloseTo(heightBefore, 1);
  });

  it("replaces an intermediate running subtitle with the unread final digest", async () => {
    const key = firstKey;
    const runId = "run-sidebar-metadata";
    const roster = (revision: number, headline: string, health: string, extra = {}) => {
      const updatedAt = Date.now() + revision - 1;
      return chatSessionListResponse([
        session(key, "Sidebar metadata repair", {
          updatedAt,
          activeRunIds: revision === 1 ? [runId] : [],
          hasActiveRun: revision === 1,
          status: revision === 1 ? "running" : "done",
          observerDigest: { agentId: "main", runId, headline, health, updatedAt, revision },
          ...extra,
        }),
      ]);
    };
    const running = roster(1, "Implementing the repair", "on-track");
    const completed = roster(2, "Repair landed cleanly", "done", {
      lastMessagePreview: "The repaired sidebar now shows the final reply.",
    });
    const { page, gateway } = await openChat(key, { "sessions.list": running }, { preview: true });
    const row = sessionRow(page, key);
    await row.getByText("Implementing the repair").waitFor();

    await waitForSessionRosterHydration(page);
    await gateway.setSessionsListResponse(completed);
    const listCount = (await gateway.getRequests("sessions.list", rosterMatch)).length;
    await gateway.emitGatewayEvent("session.message", {
      activeRunIds: [],
      hasActiveRun: false,
      message: chatMessage("assistant", "The repaired sidebar now shows the final reply.", {
        timestamp: Date.now(),
      }),
      messageId: "terminal-sidebar-reply",
      messageSeq: 2,
      session: expectDefined(completed.sessions[0], "completed sidebar session fixture"),
      sessionKey: key,
      status: "done",
    });
    await row.getByText("Repair landed cleanly").waitFor();
    await expectRequestCountStable(gateway, "sessions.list", listCount, 500, rosterMatch);
    expect(await row.textContent()).not.toContain("[[");

    const listRequests = await gateway.getRequests("sessions.list", rosterMatch);
    expect(listRequests.at(-1)?.params).toMatchObject({ includeLastMessage: true });
  });

  it.each([
    {
      locale: "en",
      direction: "ltr",
      title: "Review sidebar title clipping and reveal this ending",
    },
    {
      locale: "ar",
      direction: "rtl",
      title: "مراجعة عناوين الجلسات الطويلة وإظهار النهاية عند التركيز",
    },
  ])(
    "reveals overflowing $direction sidebar titles with pointer and keyboard controls",
    async ({ locale, direction, title }) => {
      const sessions = chatSessionListResponse([
        session(firstKey, "Short", { updatedAt: 2 }),
        session(secondKey, title),
      ]);
      const { page } = await openChat(firstKey, { "sessions.list": sessions }, { locale });
      await expect.poll(() => page.locator("html").getAttribute("dir")).toBe(direction);
      const row = sessionRow(page, secondKey);
      const label = part(row, "name");
      const shortLabel = part(sessionRow(page, firstKey), "name");
      const metrics = () => titleMetrics(label, direction);
      const offset = async () => (await metrics()).offset;
      await label.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => mask(label)).toContain(direction === "rtl" ? "to left" : "to right");
      expect(await mask(shortLabel)).toBe("none");
      const rowWidth = (await metrics()).width;

      await row.hover();
      await expect.poll(offset).toBeLessThan(-2);
      const movingOffset = await offset();
      await expect.poll(offset).toBeLessThan(movingOffset - 5);
      await expect.poll(() => opacity(archive(row))).toBe("1");
      const geometry = await metrics();
      expect(geometry.right).toBeLessThanOrEqual(geometry.controlsLeft + 1);
      await expect
        .poll(async () => (await metrics()).overflow, { timeout: 15_000 })
        .toBeLessThanOrEqual(1);
      expect((await metrics()).width).toBeCloseTo(rowWidth, 1);

      await page.mouse.move(900, 600);
      await expect.poll(offset).toBe(0);
      await page.keyboard.press("Tab");
      await link(row).focus();
      await expect.poll(offset).toBeLessThan(-2);
      const focusedOffset = await offset();
      await archive(row).focus();
      await expect.poll(offset).toBeLessThan(focusedOffset - 5);

      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect.poll(offset).toBe(0);
      await row.hover();
      await page.waitForTimeout(750);
      expect(await offset()).toBe(0);
      expect(await mask(label)).toContain("linear-gradient");
      expect(await mask(shortLabel)).toBe("none");

      await activate(row);
      expect(await offset()).toBe(0);
      expect(await mask(label)).toContain("linear-gradient");
    },
  );

  it("keeps session titles on the first line and collapses rows that have no second line", async () => {
    const busyKey = "agent:main:busy-session";
    const plainKey = "agent:main:plain-session";
    const longKey = "agent:main:long-title-session";
    const unreadKey = "agent:main:unread-session";
    const runningKey = "agent:main:running-session";
    const { page } = await openChat(plainKey, {
      "sessions.list": chatSessionListResponse([
        session(unreadKey, "Movies and recommendations for the weekend", {
          icon: "🎬",
          updatedAt: 3,
          unread: true,
        }),
        session(runningKey, "Running session", {
          hasActiveRun: true,
          status: "running",
          updatedAt: 4,
        }),
        session(busyKey, "Terminal tab bar redesign proposal", {
          updatedAt: 2,
          hasActiveRun: false,
          lastMessagePreview:
            "The isolated clone is ready, but direct Git fetch and every remaining operation continue in the background",
          incognito: true,
          hasAutomation: true,
          boardFace: "dashboard",
          status: "done",
          unread: true,
        }),
        session(plainKey, "A session without secondary metadata"),
        session(
          longKey,
          "An extremely long single-line session title that keeps going and going far past the sidebar width",
          { incognito: true, hasActiveRun: false, status: "done", unread: true },
        ),
      ]),
    });
    const busyRow = sessionRow(page, busyKey);
    const plainRow = sessionRow(page, plainKey);
    await busyRow.locator(".session-row-badges").waitFor();
    expect(await part(busyRow, "subtitle").count()).toBe(0);
    expect(await busyRow.getAttribute("class")).toContain("sidebar-recent-session--single-line");

    await page.locator(".sidebar-session-toolbar .sidebar-session-sort").click();
    await openSidebarMenu(page);
    const previewToggle = page.getByRole("switch", { name: "Show message preview", exact: true });
    expect(await previewToggle.getAttribute("aria-checked")).toBe("false");
    await previewToggle.click();
    await closeSidebarMenu(page);
    await part(busyRow, "subtitle").waitFor();
    const sidebar = page.locator("openclaw-app-sidebar");
    expect(await sidebar.getByRole("img", { name: "Dashboard available" }).count()).toBe(0);
    expect(await sidebar.getByRole("img", { name: "Automation attached" }).count()).toBe(0);
    const ordinaryBadge = busyRow.locator(".session-row-badge--incognito svg");
    for (const colorScheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(colorScheme);
      for (const reducedMotion of ["no-preference", "reduce"] as const) {
        await page.emulateMedia({ reducedMotion });
        const spinnerColors = await sessionRow(page, runningKey)
          .locator(".sidebar-session-indicator .session-glyph__ring")
          .evaluate((element) => {
            const style = getComputedStyle(element);
            const accent = document.createElement("span").style;
            accent.color = style.getPropertyValue("--accent").trim();
            return { actual: style.borderTopColor, expected: accent.color };
          });
        expect.soft(spinnerColors.actual).toBe(spinnerColors.expected);
      }
      await page.emulateMedia({ reducedMotion: "no-preference" });
    }
    const shellNav = page.locator(".shell-nav");
    const sidebarResizer = page.getByRole("separator", { name: "Resize sidebar" });
    const badgeSizes = [];
    for (const sidebarWidth of [258, 240]) {
      if (sidebarWidth === 240) {
        await sidebarResizer.focus();
        await page.keyboard.press("Home");
      }
      await expect
        .poll(() =>
          shellNav.evaluate((element) => {
            const rail = element.querySelector(".sidebar-rail");
            if (!rail) {
              throw new Error("Expected the persistent rail");
            }
            return Math.round(
              element.getBoundingClientRect().width - rail.getBoundingClientRect().width,
            );
          }),
        )
        .toBe(sidebarWidth);
      await page.mouse.move(900, 400);

      badgeSizes.push(
        await ordinaryBadge.evaluate((element) => {
          const { height, width } = element.getBoundingClientRect();
          return { height, width };
        }),
      );
    }

    const layout = await rowLayout(busyRow);
    const badges = await busyRow.locator(".session-row-badges").boundingBox();
    const badgeBox = expectDefined(badges, "badges");
    const subtitleBox = expectDefined(await part(busyRow, "subtitle").boundingBox(), "subtitle");
    const plain = await plainRow.evaluate((row) => ({
      height: row.getBoundingClientRect().height,
      singleLine: row.classList.contains("sidebar-recent-session--single-line"),
      nameLeft: row.querySelector(".sidebar-recent-session__name")!.getBoundingClientRect().left,
    }));

    expect(plain.singleLine).toBe(true);
    expect(plain.height).toBeLessThan(layout.row.height);
    expect(badgeBox.y).toBeGreaterThanOrEqual(layout.name.bottom - 1);
    expect(layout.name.right).toBeGreaterThan(badgeBox.x);
    expect(badgeBox.y + badgeBox.height / 2).toBeCloseTo(subtitleBox.y + subtitleBox.height / 2, 1);
    expectUnreadLayout(layout, plain.nameLeft);
    expect(await busyRow.locator(".session-row-state").count()).toBe(0);
    expect(layout.atoms).toHaveLength(1);
    for (const atom of layout.atoms) {
      for (const edge of ["left", "top"] as const) {
        expect(atom[edge]).toBeGreaterThanOrEqual(layout.endcap[edge]);
      }
      for (const edge of ["right", "bottom"] as const) {
        expect(atom[edge]).toBeLessThanOrEqual(layout.endcap[edge]);
      }
    }

    const longLayout = await rowLayout(sessionRow(page, longKey));
    expect(longLayout).toMatchObject({ singleLine: true, nameOverflowing: true });
    expect(longLayout.endcap.right).toBeLessThanOrEqual(longLayout.row.right);
    const intrinsicAtomWidth = longLayout.atoms.reduce((sum, atom) => sum + atom.width, 0);
    expect(intrinsicAtomWidth).toBeGreaterThan(0);
    expect(longLayout.endcap.width).toBeGreaterThanOrEqual(intrinsicAtomWidth);
    expectUnreadLayout(longLayout, plain.nameLeft);

    const unreadRow = sessionRow(page, unreadKey);
    const unreadBadge = unreadRow.locator(
      ".sidebar-session-indicator .session-glyph__badge--unread",
    );
    const unreadTitle = part(unreadRow, "name");
    const titleWidth = () => unreadTitle.evaluate((element) => element.clientWidth);
    await unreadBadge.waitFor({ state: "visible" });
    const restingBadge = await unreadBadge.boundingBox();
    const restingTitle = await unreadTitle.boundingBox();
    const restingWidth = await titleWidth();
    await unreadRow.hover();

    await unreadBadge.waitFor({ state: "visible" });
    expect(await unreadBadge.boundingBox()).toEqual(restingBadge);
    expect((await unreadTitle.boundingBox())?.x).toBe(restingTitle?.x);
    const hoverWidth = await titleWidth();
    const actionReserve = await unreadRow.evaluate((element) =>
      Number.parseFloat(
        getComputedStyle(element).getPropertyValue("--session-row-actions-reserve"),
      ),
    );
    expect(restingWidth - hoverWidth).toBeCloseTo(actionReserve, 0);
    await page.mouse.move(900, 400);
    await unreadBadge.waitFor({ state: "visible" });
    await archive(unreadRow).focus();
    await unreadBadge.waitFor({ state: "visible" });
    expect(await unreadBadge.boundingBox()).toEqual(restingBadge);
    expect((await unreadTitle.boundingBox())?.x).toBe(restingTitle?.x);
    expect(await titleWidth()).toBe(hoverWidth);
    await sidebarResizer.focus();
    await unreadBadge.waitFor({ state: "visible" });

    await busyRow.hover();
    for (const selector of [
      ".sidebar-recent-session__details-endcap",
      "[data-sidebar-session-archive]",
    ]) {
      await expect.poll(() => opacity(busyRow.locator(selector))).toBe("1");
    }

    await plainRow.waitFor();
    for (const size of badgeSizes) {
      expect(size).toEqual({ height: 12, width: 12 });
    }
  });

  it("keeps the authenticated assistant avatar stable across same-agent switches", async () => {
    const page = await newChatPage(suite);
    const avatarBody = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nPcAAAAASUVORK5CYII=",
      "base64",
    );
    const avatarAuthorizations: Array<string | undefined> = [];
    await page.route(/\/avatar\/main\?v=fixture$/, (route) => {
      avatarAuthorizations.push(route.request().headers().authorization);
      return route.fulfill({ contentType: "image/png", body: avatarBody });
    });
    await installMockGateway(page, {
      methodResponses: {
        "agent.identity.get": {
          agentId: "main",
          name: "OpenClaw",
          avatar: "/avatar/main?v=fixture",
          avatarStatus: "local",
        },
        "sessions.list": chatSessionListResponse(),
      },
      sessionKey: firstKey,
    });
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, firstKey));
    const documentMarker = await page.evaluate(
      () => (document.documentElement.dataset.avatarTestDocument = crypto.randomUUID()),
    );
    const avatar = page.locator(
      'openclaw-chat-pane[aria-hidden="false"] .agent-chat__welcome-avatar img',
    );
    await avatar.waitFor({ state: "visible" });
    await expect.poll(() => avatar.getAttribute("src")).toMatch(/^blob:/);

    for (const key of [secondKey, firstKey]) {
      const row = sessionRow(page, key);
      await activate(row);
      await expect.poll(() => avatar.getAttribute("src")).toMatch(/^blob:/);
      await expect.poll(() => avatar.isVisible()).toBe(true);
    }
    expect(avatarAuthorizations).toEqual(["Bearer e2e-device-token"]);
    expect(await page.evaluate(() => document.documentElement.dataset.avatarTestDocument)).toBe(
      documentMarker,
    );
  });
});
