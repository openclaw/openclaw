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
const rosterMatch = { includeGlobal: true };
const sessionRow = (page: Page, key: string) =>
  page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
const session = (key: string, label: string, extra: Record<string, unknown> = {}) => ({
  key,
  kind: "direct",
  label,
  updatedAt: 1,
  ...extra,
});
const previewEnabled = () => {
  localStorage.setItem("openclaw:sidebar:sessions:show-preview", "true");
};
const mask = (label: Locator) => label.evaluate((element) => getComputedStyle(element).maskImage);

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
    const page = await newChatPage(suite);
    await page.addInitScript(previewEnabled);

    const firstKey = "agent:main:session-a";
    const secondKey = "agent:main:session-b";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse([
          session(firstKey, "First running session", {
            updatedAt: 2,
            activeRunIds: ["run-first"],
            hasActiveRun: true,
            status: "running",
          }),
          session(secondKey, "Second running session", {
            activeRunIds: ["run-second"],
            hasActiveRun: true,
            status: "running",
          }),
        ]),
      },
      sessionKey: firstKey,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, firstKey));
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
    const narration = secondRow.getByText("Checking the running session", { exact: true });
    const tool = secondRow.getByRole("img", { name: "Tool: bash", exact: true });
    await narration.waitFor();
    await tool.waitFor();
    expect(
      await Promise.all(
        ["title-row", "details"].map((part) =>
          secondRow.locator(`.sidebar-recent-session__${part} .sidebar-session-tool`).count(),
        ),
      ),
    ).toEqual([0, 1]);
    const heightBefore = await secondRow.evaluate((row) => row.getBoundingClientRect().height);

    await secondRow.locator("a.sidebar-recent-session__link").click();
    await expect.poll(() => secondRow.getAttribute("class")).toContain("--active");
    await narration.waitFor();
    await tool.waitFor();
    const heightAfter = await secondRow.evaluate((row) => row.getBoundingClientRect().height);

    // Sub-pixel tolerance avoids float drift under contention, not visible resize.
    expect(heightAfter).toBeCloseTo(heightBefore, 1);
  });

  it("replaces an intermediate running subtitle with the unread final digest", async () => {
    const page = await newChatPage(suite);
    await page.addInitScript(previewEnabled);
    const key = "agent:main:session-a";
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
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": running },
      sessionKey: key,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
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
      const page = await newChatPage(suite);
      await page.addInitScript((value) => {
        localStorage.setItem("openclaw.i18n.locale", value);
      }, locale);
      const sessions = chatSessionListResponse();
      const firstSession = expectDefined(sessions.sessions[0], "first chat session fixture");
      const secondSession = expectDefined(sessions.sessions[1], "second chat session fixture");
      firstSession.label = "Short";
      secondSession.label = title;
      await installMockGateway(page, {
        methodResponses: { "sessions.list": sessions },
        sessionKey: "agent:main:session-a",
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));
      await expect.poll(() => page.locator("html").getAttribute("dir")).toBe(direction);
      const row = page.locator('.sidebar-recent-session[data-session-key="agent:main:session-b"]');
      const label = row.locator(".sidebar-recent-session__name");
      const text = label.locator(".hover-marquee__text");
      const shortLabel = page.locator(
        '.sidebar-recent-session[data-session-key="agent:main:session-a"] .sidebar-recent-session__name',
      );
      const offset = () =>
        text.evaluate((element, readingDirection) => {
          const transform = getComputedStyle(element).transform;
          const x = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
          return x === 0 ? 0 : readingDirection === "rtl" ? -x : x;
        }, direction);
      await label.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => mask(label)).toContain(direction === "rtl" ? "to left" : "to right");
      expect(await mask(shortLabel)).toBe("none");
      const rowWidth = await row.evaluate((element) => element.getBoundingClientRect().width);

      await row.hover();
      await expect.poll(offset).toBeLessThan(-2);
      const movingOffset = await offset();
      await expect.poll(offset).toBeLessThan(movingOffset - 5);
      const controls = row.locator("button[data-sidebar-session-archive]");
      await expect
        .poll(() => controls.evaluate((element) => Number(getComputedStyle(element).opacity)))
        .toBe(1);
      const geometry = await label.evaluate((element) => {
        const actions = element
          .closest(".sidebar-recent-session")!
          .querySelector(".session-row-actions")!;
        return {
          right: element.getBoundingClientRect().right,
          controlsLeft: actions.getBoundingClientRect().left,
        };
      });
      expect(geometry.right).toBeLessThanOrEqual(geometry.controlsLeft + 1);
      // At the endpoint, even the final glyph is inside the opaque part of the mask.
      await expect
        .poll(
          () =>
            label.evaluate((element, readingDirection) => {
              const titleText = element.querySelector(".hover-marquee__text")!;
              const fade = Number.parseFloat(
                getComputedStyle(element).getPropertyValue("--hover-marquee-fade-width"),
              );
              const bounds = element.getBoundingClientRect();
              const textBounds = titleText.getBoundingClientRect();
              return readingDirection === "rtl"
                ? bounds.left + fade - textBounds.left
                : textBounds.right - (bounds.right - fade);
            }, direction),
          { timeout: 15_000 },
        )
        .toBeLessThanOrEqual(1);
      expect(await row.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(
        rowWidth,
        1,
      );

      await page.mouse.move(900, 600);
      await expect.poll(offset).toBe(0);
      await page.keyboard.press("Tab");
      await row.locator("a.sidebar-recent-session__link").focus();
      await expect.poll(offset).toBeLessThan(-2);
      const focusedOffset = await offset();
      await row.locator("button[data-sidebar-session-archive]").focus();
      await expect.poll(offset).toBeLessThan(focusedOffset - 5);

      await page.emulateMedia({ reducedMotion: "reduce" });
      await expect.poll(offset).toBe(0);
      await row.hover();
      await page.waitForTimeout(750);
      expect(await offset()).toBe(0);
      expect(await mask(label)).toContain("linear-gradient");
      expect(await mask(shortLabel)).toBe("none");

      await row.locator("a.sidebar-recent-session__link").click();
      await expect.poll(() => row.getAttribute("class")).toContain("--active");
      expect(await offset()).toBe(0);
      expect(await mask(label)).toContain("linear-gradient");
    },
  );

  it("keeps session titles on the first line and collapses rows that have no second line", async () => {
    const page = await newChatPage(suite);
    const busyKey = "agent:main:busy-session";
    const plainKey = "agent:main:plain-session";
    const longKey = "agent:main:long-title-session";
    const unreadKey = "agent:main:unread-session";
    const runningKey = "agent:main:running-session";
    await installMockGateway(page, {
      methodResponses: {
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
      },
      sessionKey: plainKey,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, plainKey));
    const busyRow = sessionRow(page, busyKey);
    const plainRow = sessionRow(page, plainKey);
    await busyRow.locator(".session-row-badges").waitFor();
    expect(await busyRow.locator(".sidebar-recent-session__subtitle").count()).toBe(0);
    expect(await busyRow.getAttribute("class")).toContain("sidebar-recent-session--single-line");

    await page.locator(".sidebar-session-toolbar .sidebar-session-sort").click();
    await openSidebarMenu(page);
    const previewToggle = page.getByRole("switch", {
      name: "Show message preview",
      exact: true,
    });
    expect(await previewToggle.getAttribute("aria-checked")).toBe("false");
    await previewToggle.click();
    await closeSidebarMenu(page);
    await busyRow.locator(".sidebar-recent-session__subtitle").waitFor();
    const sidebar = page.locator("openclaw-app-sidebar");
    expect(await sidebar.getByRole("img", { name: "Dashboard available" }).count()).toBe(0);
    expect(await sidebar.getByRole("img", { name: "Automation attached" }).count()).toBe(0);
    const ordinaryBadge = busyRow.locator(".session-row-badge--incognito svg");
    for (const colorScheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(colorScheme);
      for (const reducedMotion of ["no-preference", "reduce"] as const) {
        await page.emulateMedia({ reducedMotion });
        const spinnerColors = await page
          .locator(`[data-session-key="${runningKey}"]`)
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
    const subtitle = await busyRow.locator(".sidebar-recent-session__subtitle").boundingBox();
    const badgeBox = expectDefined(badges, "busy row badges");
    const subtitleBox = expectDefined(subtitle, "busy row subtitle");
    const plain = await plainRow.evaluate((row) => ({
      height: row.getBoundingClientRect().height,
      singleLine: row.classList.contains("sidebar-recent-session--single-line"),
      nameLeft: row.querySelector(".sidebar-recent-session__name")!.getBoundingClientRect().left,
    }));

    // Only rows with a subtitle reserve the second line.
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

    // Long titles must not crush either the leading unread dot or trailing metadata.
    const longRow = sessionRow(page, longKey);
    const longLayout = await rowLayout(longRow);
    expect(longLayout.singleLine).toBe(true);
    expect(longLayout.nameOverflowing).toBe(true);
    expect(longLayout.endcap.right).toBeLessThanOrEqual(longLayout.row.right);
    const intrinsicAtomWidth = longLayout.atoms.reduce((sum, atom) => sum + atom.width, 0);
    expect(intrinsicAtomWidth).toBeGreaterThan(0);
    expect(longLayout.endcap.width).toBeGreaterThanOrEqual(intrinsicAtomWidth);
    expectUnreadLayout(longLayout, plain.nameLeft);

    const unreadRow = sessionRow(page, unreadKey);
    const unreadBadge = unreadRow.locator(
      ".sidebar-session-indicator .session-glyph__badge--unread",
    );
    const unreadTitle = unreadRow.locator(".sidebar-recent-session__name");
    await unreadBadge.waitFor({ state: "visible" });
    const restingBadge = await unreadBadge.boundingBox();
    const restingTitle = await unreadTitle.boundingBox();
    const restingWidth = await unreadTitle.evaluate((element) => element.clientWidth);
    await unreadRow.hover();

    await unreadBadge.waitFor({ state: "visible" });
    expect(await unreadBadge.boundingBox()).toEqual(restingBadge);
    expect((await unreadTitle.boundingBox())?.x).toBe(restingTitle?.x);
    const hoverWidth = await unreadTitle.evaluate((element) => element.clientWidth);
    const actionReserve = await unreadRow.evaluate((element) =>
      Number.parseFloat(
        getComputedStyle(element).getPropertyValue("--session-row-actions-reserve"),
      ),
    );
    // The leading badge stays fixed while the title reserves the full action width.
    expect(restingWidth - hoverWidth).toBeCloseTo(actionReserve, 0);
    await page.mouse.move(900, 400);
    await unreadBadge.waitFor({ state: "visible" });
    await unreadRow.locator("[data-sidebar-session-archive]").focus();
    await unreadBadge.waitFor({ state: "visible" });
    expect(await unreadBadge.boundingBox()).toEqual(restingBadge);
    expect((await unreadTitle.boundingBox())?.x).toBe(restingTitle?.x);
    expect(await unreadTitle.evaluate((element) => element.clientWidth)).toBe(hoverWidth);
    await sidebarResizer.focus();
    await unreadBadge.waitFor({ state: "visible" });

    await busyRow.hover();
    for (const selector of [
      ".sidebar-recent-session__details-endcap",
      "[data-sidebar-session-archive]",
    ]) {
      await expect
        .poll(() =>
          busyRow.locator(selector).evaluate((element) => getComputedStyle(element).opacity),
        )
        .toBe("1");
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
      sessionKey: "agent:main:session-a",
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));
    const documentMarker = await page.evaluate(() => {
      const marker = crypto.randomUUID();
      (window as Window & { __openclawAvatarTestDocument?: string })[
        "__openclawAvatarTestDocument"
      ] = marker;
      return marker;
    });
    const avatar = page.locator(
      'openclaw-chat-pane[aria-hidden="false"] .agent-chat__welcome-avatar img',
    );
    await avatar.waitFor({ state: "visible" });
    await expect.poll(() => avatar.getAttribute("src")).toMatch(/^blob:/);

    for (const key of ["agent:main:session-b", "agent:main:session-a"]) {
      const row = sessionRow(page, key);
      await row.locator("a.sidebar-recent-session__link").click();
      await expect
        .poll(() => row.getAttribute("class"))
        .toContain("sidebar-recent-session--active");
      await expect.poll(() => avatar.getAttribute("src")).toMatch(/^blob:/);
      await expect.poll(() => avatar.isVisible()).toBe(true);
    }
    expect(avatarAuthorizations).toEqual(["Bearer e2e-device-token"]);
    expect(
      await page.evaluate(
        () =>
          (window as Window & { __openclawAvatarTestDocument?: string })[
            "__openclawAvatarTestDocument"
          ],
      ),
    ).toBe(documentMarker);
  });
});
