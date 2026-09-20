import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  takeControlUiElementScreenshot,
  takeControlUiViewportScreenshot,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  captureUiProofEnabled,
  chatSessionListResponse,
  createChatFlowE2eSuite,
  expectDefined,
  expectRequestCountStable,
  controlUiSessionUrl,
  installMockGateway,
  requireRecord,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const rosterMatch = { includeGlobal: true };

suite.define(() => {
  it("keeps a running subtitle and row height stable when its session is opened", async () => {
    if (captureUiProofEnabled) {
      await mkdir(path.join(suite.artifactDir, "sidebar-subtitle-stability"), { recursive: true });
    }
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProofEnabled
        ? {
            recordVideo: {
              dir: path.join(suite.artifactDir, "sidebar-subtitle-stability"),
              size: { height: 900, width: 1280 },
            },
          }
        : {}),
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem("openclaw:sidebar:sessions:show-preview", "true");
    });
    const proofVideo = page.video();
    const firstKey = "agent:main:session-a";
    const secondKey = "agent:main:session-b";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse([
          {
            key: firstKey,
            kind: "direct",
            label: "First running session",
            updatedAt: 2,
            activeRunIds: ["run-first"],
            hasActiveRun: true,
            status: "running",
          },
          {
            key: secondKey,
            kind: "direct",
            label: "Second running session",
            updatedAt: 1,
            activeRunIds: ["run-second"],
            hasActiveRun: true,
            status: "running",
          },
        ]),
      },
      sessionKey: firstKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, firstKey));
      const secondRow = page.locator(`.sidebar-recent-session[data-session-key="${secondKey}"]`);
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.messages.subscribe")).some(
            (request) => requireRecord(request.params).key === secondKey,
          ),
        )
        .toBe(true);
      await gateway.emitGatewayEvent("agent", {
        sessionKey: secondKey,
        runId: "run-second",
        stream: "tool",
        data: { name: "bash" },
      });
      await secondRow.getByText("Using bash").waitFor();
      const heightBefore = await secondRow.evaluate((row) => row.getBoundingClientRect().height);
      if (captureUiProofEnabled) {
        await page.waitForTimeout(800);
        await writeFile(
          path.join(
            path.join(suite.artifactDir, "sidebar-subtitle-stability"),
            "01-running-before-open.png",
          ),
          await takeControlUiElementScreenshot(page, secondRow, [
            secondRow.getByText("Using bash"),
          ]),
        );
      }

      await secondRow.locator("a.sidebar-recent-session__link").click();
      await expect.poll(() => secondRow.getAttribute("class")).toContain("--active");
      await secondRow.getByText("Using bash").waitFor();
      const heightAfter = await secondRow.evaluate((row) => row.getBoundingClientRect().height);

      // Sub-pixel tolerance: getBoundingClientRect returns 1/65536 fractions that
      // drift under CPU contention, so exact equality fails ~1 run in 3 in a loaded
      // shard. The contract is "the row does not change size", not bit-identical floats.
      expect(heightAfter).toBeCloseTo(heightBefore, 1);
      if (captureUiProofEnabled) {
        await page.waitForTimeout(800);
        await writeFile(
          path.join(
            path.join(suite.artifactDir, "sidebar-subtitle-stability"),
            "02-running-after-open.png",
          ),
          await takeControlUiElementScreenshot(page, secondRow, [
            secondRow.getByText("Using bash"),
          ]),
        );
      }
    } finally {
      await suite.closeBrowserContext(context);
      if (proofVideo) {
        await proofVideo.saveAs(
          path.join(
            path.join(suite.artifactDir, "sidebar-subtitle-stability"),
            "sidebar-subtitle-stability.webm",
          ),
        );
      }
    }
  });

  it("replaces an intermediate running subtitle with the unread final digest", async () => {
    if (captureUiProofEnabled) {
      await mkdir(path.join(suite.artifactDir, "remote-session-sidebar-metadata"), {
        recursive: true,
      });
    }
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProofEnabled
        ? {
            recordVideo: {
              dir: path.join(suite.artifactDir, "remote-session-sidebar-metadata"),
              size: { height: 900, width: 1280 },
            },
          }
        : {}),
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem("openclaw:sidebar:sessions:show-preview", "true");
    });
    const key = "agent:main:session-a";
    const runId = "run-sidebar-metadata";
    const running = chatSessionListResponse([
      {
        key,
        kind: "direct",
        label: "Sidebar metadata repair",
        updatedAt: Date.now(),
        activeRunIds: [runId],
        hasActiveRun: true,
        status: "running",
        observerDigest: {
          agentId: "main",
          runId,
          headline: "Implementing the repair",
          health: "on-track",
          updatedAt: Date.now(),
          revision: 1,
        },
      },
    ]);
    const completed = chatSessionListResponse([
      {
        key,
        kind: "direct",
        label: "Sidebar metadata repair",
        updatedAt: Date.now() + 1,
        activeRunIds: [],
        hasActiveRun: false,
        status: "done",
        lastMessagePreview: "The repaired sidebar now shows the final reply.",
        observerDigest: {
          agentId: "main",
          runId,
          headline: "Repair landed cleanly",
          health: "done",
          updatedAt: Date.now() + 1,
          revision: 2,
        },
      },
    ]);
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": running },
      sessionKey: key,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      await row.getByText("Implementing the repair").waitFor();
      if (captureUiProofEnabled) {
        await writeFile(
          path.join(
            path.join(suite.artifactDir, "remote-session-sidebar-metadata"),
            "01-running-subtitle.png",
          ),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [row]),
        );
      }
      await gateway.setSessionsListResponse(completed);
      const listCount = (await gateway.getRequests("sessions.list", rosterMatch)).length;
      await gateway.emitGatewayEvent("session.message", {
        activeRunIds: [],
        hasActiveRun: false,
        message: {
          content: [{ type: "text", text: "The repaired sidebar now shows the final reply." }],
          role: "assistant",
          timestamp: Date.now(),
        },
        messageId: "terminal-sidebar-reply",
        messageSeq: 2,
        session: expectDefined(completed.sessions[0], "completed sidebar session fixture"),
        sessionKey: key,
        status: "done",
      });
      await row.getByText("Repair landed cleanly").waitFor();
      await expectRequestCountStable(gateway, "sessions.list", listCount, 500, rosterMatch);
      expect(await row.textContent()).not.toContain("[[");
      if (captureUiProofEnabled) {
        await writeFile(
          path.join(
            path.join(suite.artifactDir, "remote-session-sidebar-metadata"),
            "02-final-reply-subtitle.png",
          ),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [row]),
        );
      }
      const listRequests = await gateway.getRequests("sessions.list", rosterMatch);
      expect(listRequests.at(-1)?.params).toMatchObject({ includeLastMessage: true });
    } finally {
      await suite.closeBrowserContext(context);
    }
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
      const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
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

      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));
        await expect.poll(() => page.locator("html").getAttribute("dir")).toBe(direction);
        const row = page.locator(
          '.sidebar-recent-session[data-session-key="agent:main:session-b"]',
        );
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
        await expect
          .poll(() => label.evaluate((element) => getComputedStyle(element).maskImage))
          .toContain(direction === "rtl" ? "to left" : "to right");
        expect(await shortLabel.evaluate((element) => getComputedStyle(element).maskImage)).toBe(
          "none",
        );
        const rowWidth = await row.evaluate((element) => element.getBoundingClientRect().width);

        await row.hover();
        await expect.poll(offset).toBeLessThan(-2);
        const movingOffset = await offset();
        await expect.poll(offset).toBeLessThan(movingOffset - 5);
        const controls = row.locator("button[data-session-menu]");
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
        await row.locator("button[data-session-menu]").focus();
        await expect.poll(offset).toBeLessThan(focusedOffset - 5);

        await page.emulateMedia({ reducedMotion: "reduce" });
        await expect.poll(offset).toBe(0);
        await row.hover();
        await page.waitForTimeout(750);
        expect(await offset()).toBe(0);
        expect(await label.evaluate((element) => getComputedStyle(element).maskImage)).toContain(
          "linear-gradient",
        );
        expect(await shortLabel.evaluate((element) => getComputedStyle(element).maskImage)).toBe(
          "none",
        );

        await row.locator("a.sidebar-recent-session__link").click();
        await expect.poll(() => row.getAttribute("class")).toContain("--active");
        expect(await offset()).toBe(0);
        expect(await label.evaluate((element) => getComputedStyle(element).maskImage)).toContain(
          "linear-gradient",
        );
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );

  it("keeps session titles on the first line and collapses rows that have no second line", async () => {
    if (captureUiProofEnabled) {
      await mkdir(path.join(suite.artifactDir, "session-status-second-row-implementation"), {
        recursive: true,
      });
    }
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProofEnabled
        ? {
            recordVideo: {
              dir: path.join(suite.artifactDir, "session-status-second-row-implementation"),
              size: { height: 900, width: 1280 },
            },
          }
        : {}),
    });
    const page = await context.newPage();
    const busyKey = "agent:main:busy-session";
    const plainKey = "agent:main:plain-session";
    const longKey = "agent:main:long-title-session";
    const unreadKey = "agent:main:unread-session";
    const runningKey = "agent:main:running-session";
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": chatSessionListResponse([
          {
            key: unreadKey,
            kind: "direct",
            label: "Movies and recommendations for the weekend",
            icon: "🎬",
            updatedAt: 3,
            unread: true,
          },
          {
            key: runningKey,
            kind: "direct",
            label: "Running session",
            hasActiveRun: true,
            status: "running",
            updatedAt: 4,
          },
          {
            key: busyKey,
            kind: "direct",
            label: "Terminal tab bar redesign proposal",
            updatedAt: 2,
            hasActiveRun: false,
            lastMessagePreview:
              "The isolated clone is ready, but direct Git fetch and every remaining operation continue in the background",
            incognito: true,
            hasAutomation: true,
            boardFace: "dashboard",
            status: "done",
            unread: true,
          },
          {
            key: plainKey,
            kind: "direct",
            label: "A session without secondary metadata",
            updatedAt: 1,
          },
          {
            key: longKey,
            kind: "direct",
            label:
              "An extremely long single-line session title that keeps going and going far past the sidebar width",
            incognito: true,
            updatedAt: 1,
            hasActiveRun: false,
            status: "done",
            unread: true,
          },
        ]),
      },
      sessionKey: plainKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, plainKey));
      const busyRow = page.locator(`.sidebar-recent-session[data-session-key="${busyKey}"]`);
      const plainRow = page.locator(`.sidebar-recent-session[data-session-key="${plainKey}"]`);
      await busyRow.locator(".session-row-badges").waitFor();
      expect(await busyRow.locator(".sidebar-recent-session__subtitle").count()).toBe(0);
      expect(await busyRow.getAttribute("class")).toContain("sidebar-recent-session--single-line");
      if (captureUiProofEnabled) {
        await writeFile(
          path.join(
            path.join(suite.artifactDir, "session-status-second-row-implementation"),
            "00-default-hidden-preview.png",
          ),
          await takeControlUiElementScreenshot(page, page.locator(".shell-nav"), [busyRow]),
        );
      }
      await page.locator(".sidebar-session-toolbar .sidebar-session-sort").click();
      const previewToggle = page.locator('wa-dropdown-item[value="show-preview"]');
      expect(
        await previewToggle.evaluate(
          (item) => (item as HTMLElement & { checked: boolean }).checked,
        ),
      ).toBe(false);
      await previewToggle.click();
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
        if (captureUiProofEnabled) {
          await writeFile(
            path.join(
              path.join(suite.artifactDir, "session-status-second-row-implementation"),
              `indicators-${colorScheme}.png`,
            ),
            await takeControlUiElementScreenshot(page, page.locator(".shell-nav"), [busyRow]),
          );
        }
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
          .poll(async () => Math.round((await shellNav.boundingBox())?.width ?? 0))
          .toBe(sidebarWidth);
        await page.mouse.move(900, 400);
        if (captureUiProofEnabled) {
          await writeFile(
            path.join(
              path.join(suite.artifactDir, "session-status-second-row-implementation"),
              `01-second-row-endcap-${sidebarWidth}.png`,
            ),
            await takeControlUiViewportScreenshot(page, page.locator(".shell"), [busyRow]),
          );
          await writeFile(
            path.join(
              path.join(suite.artifactDir, "session-status-second-row-implementation"),
              `01-sidebar-${sidebarWidth}.png`,
            ),
            await takeControlUiElementScreenshot(page, shellNav, [busyRow]),
          );
        }
        badgeSizes.push(
          await ordinaryBadge.evaluate((element) => {
            const { height, width } = element.getBoundingClientRect();
            return { height, width };
          }),
        );
      }

      const layout = await busyRow.evaluate((row) => {
        const rect = (selector: string) => {
          const element = row.querySelector<HTMLElement>(selector);
          if (!element) {
            throw new Error(`Missing session row fixture ${selector}`);
          }
          const box = element.getBoundingClientRect();
          return {
            bottom: box.bottom,
            height: box.height,
            left: box.left,
            right: box.right,
            top: box.top,
          };
        };
        return {
          atoms: Array.from(
            row.querySelectorAll(".sidebar-recent-session__details-endcap svg"),
            (element) => {
              const box = element.getBoundingClientRect();
              return { bottom: box.bottom, left: box.left, right: box.right, top: box.top };
            },
          ),
          badges: rect(".session-row-badges"),
          busyHeight: row.getBoundingClientRect().height,
          endcap: rect(".sidebar-recent-session__details-endcap"),
          name: rect(".sidebar-recent-session__name"),
          unread: rect(".sidebar-session-indicator .session-unread-dot"),
          lead: rect(".sidebar-session-indicator"),
          subtitle: rect(".sidebar-recent-session__subtitle"),
        };
      });
      const plain = await plainRow.evaluate((row) => ({
        height: row.getBoundingClientRect().height,
        singleLine: row.classList.contains("sidebar-recent-session--single-line"),
        nameLeft: row.querySelector(".sidebar-recent-session__name")!.getBoundingClientRect().left,
      }));

      // A row with no secondary metadata no longer reserves the second line: it
      // collapses so its endcap rides beside the title instead of hanging alone
      // beneath it. Only rows that actually have a subtitle keep the two-line shape.
      expect(plain.singleLine).toBe(true);
      expect(plain.height).toBeLessThan(layout.busyHeight);
      expect(layout.badges.top).toBeGreaterThanOrEqual(layout.name.bottom - 1);
      expect(layout.name.right).toBeGreaterThan(layout.badges.left);
      expect((layout.badges.top + layout.badges.bottom) / 2).toBeCloseTo(
        (layout.subtitle.top + layout.subtitle.bottom) / 2,
        1,
      );
      expect((layout.unread.top + layout.unread.bottom) / 2).toBeCloseTo(
        (layout.lead.top + layout.lead.bottom) / 2,
        1,
      );
      expect((layout.unread.left + layout.unread.right) / 2).toBeCloseTo(
        (layout.lead.left + layout.lead.right) / 2,
        1,
      );
      expect(layout.unread.right - layout.unread.left).toBe(7);
      expect(layout.unread.height).toBe(7);
      expect(layout.unread.left).toBeGreaterThanOrEqual(layout.lead.left);
      expect(layout.unread.right).toBeLessThanOrEqual(layout.lead.right);
      expect(layout.unread.top).toBeGreaterThanOrEqual(layout.lead.top);
      expect(layout.unread.bottom).toBeLessThanOrEqual(layout.lead.bottom);
      expect(layout.lead.right).toBeLessThanOrEqual(layout.name.left);
      expect(layout.name.left).toBeCloseTo(plain.nameLeft, 1);
      expect(await busyRow.locator(".session-row-state").count()).toBe(0);
      expect(layout.atoms).toHaveLength(1);
      for (const atom of layout.atoms) {
        expect(atom.left).toBeGreaterThanOrEqual(layout.endcap.left);
        expect(atom.right).toBeLessThanOrEqual(layout.endcap.right);
        expect(atom.top).toBeGreaterThanOrEqual(layout.endcap.top);
        expect(atom.bottom).toBeLessThanOrEqual(layout.endcap.bottom);
      }

      // Long titles must not crush either the leading unread dot or trailing metadata.
      const longRow = page.locator(`.sidebar-recent-session[data-session-key="${longKey}"]`);
      const longLayout = await longRow.evaluate((row) => {
        const endcap = row.querySelector(".sidebar-recent-session__details-endcap");
        const name = row.querySelector(".sidebar-recent-session__name");
        const lead = row.querySelector(".sidebar-session-indicator");
        const unread = lead?.querySelector(".session-unread-dot");
        if (!endcap || !name || !lead || !unread) {
          throw new Error("Missing long-title session row fixture");
        }
        const endcapBox = endcap.getBoundingClientRect();
        const rowBox = row.getBoundingClientRect();
        const rect = (element: Element) => {
          const { x, y, left, right, top, bottom, width, height } = element.getBoundingClientRect();
          return { x, y, left, right, top, bottom, width, height };
        };
        return {
          atoms: Array.from(
            endcap.querySelectorAll(":scope svg"),
            (element) => element.getBoundingClientRect().width,
          ),
          endcapWidth: endcapBox.width,
          endcapRight: endcapBox.right,
          nameOverflowing: name.scrollWidth > name.clientWidth,
          rowRight: rowBox.right,
          lead: rect(lead),
          unread: rect(unread),
          nameLeft: name.getBoundingClientRect().left,
          singleLine: row.classList.contains("sidebar-recent-session--single-line"),
        };
      });
      expect(longLayout.singleLine).toBe(true);
      expect(longLayout.nameOverflowing).toBe(true);
      expect(longLayout.endcapRight).toBeLessThanOrEqual(longLayout.rowRight);
      const intrinsicAtomWidth = longLayout.atoms.reduce((sum, width) => sum + width, 0);
      expect(intrinsicAtomWidth).toBeGreaterThan(0);
      expect(longLayout.endcapWidth).toBeGreaterThanOrEqual(intrinsicAtomWidth);
      expect(longLayout.unread.width).toBe(7);
      expect(longLayout.unread.height).toBe(7);
      expect(longLayout.unread.x + longLayout.unread.width / 2).toBeCloseTo(
        longLayout.lead.x + longLayout.lead.width / 2,
        1,
      );
      expect(longLayout.unread.y + longLayout.unread.height / 2).toBeCloseTo(
        longLayout.lead.y + longLayout.lead.height / 2,
        1,
      );
      expect(longLayout.unread.left).toBeGreaterThanOrEqual(longLayout.lead.left);
      expect(longLayout.unread.right).toBeLessThanOrEqual(longLayout.lead.right);
      expect(longLayout.unread.top).toBeGreaterThanOrEqual(longLayout.lead.top);
      expect(longLayout.unread.bottom).toBeLessThanOrEqual(longLayout.lead.bottom);
      expect(longLayout.lead.right).toBeLessThanOrEqual(longLayout.nameLeft);
      expect(longLayout.nameLeft).toBeCloseTo(plain.nameLeft, 1);

      const unreadRow = page.locator(`.sidebar-recent-session[data-session-key="${unreadKey}"]`);
      const unreadBadge = unreadRow.locator(
        ".sidebar-session-indicator .session-glyph__badge--unread",
      );
      const unreadTitle = unreadRow.locator(".sidebar-recent-session__name");
      await unreadBadge.waitFor({ state: "visible" });
      const restingBadge = await unreadBadge.boundingBox();
      const restingTitle = await unreadTitle.boundingBox();
      const restingWidth = await unreadTitle.evaluate((element) => element.clientWidth);
      await unreadRow.hover();
      if (captureUiProofEnabled) {
        await writeFile(
          path.join(
            path.join(suite.artifactDir, "session-status-second-row-implementation"),
            "03-unread-hover.png",
          ),
          await takeControlUiElementScreenshot(page, shellNav, [unreadRow]),
        );
      }
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
      await unreadRow.locator("[data-session-menu]").focus();
      await unreadBadge.waitFor({ state: "visible" });
      expect(await unreadBadge.boundingBox()).toEqual(restingBadge);
      expect((await unreadTitle.boundingBox())?.x).toBe(restingTitle?.x);
      expect(await unreadTitle.evaluate((element) => element.clientWidth)).toBe(hoverWidth);
      await sidebarResizer.focus();
      await unreadBadge.waitFor({ state: "visible" });

      await busyRow.hover();
      await expect
        .poll(() =>
          busyRow
            .locator(".sidebar-recent-session__details-endcap")
            .evaluate((element) => getComputedStyle(element).opacity),
        )
        .toBe("1");
      await expect
        .poll(() =>
          busyRow
            .locator("[data-session-menu]")
            .evaluate((element) => getComputedStyle(element).opacity),
        )
        .toBe("1");
      if (captureUiProofEnabled) {
        await writeFile(
          path.join(
            path.join(suite.artifactDir, "session-status-second-row-implementation"),
            "02-hover-actions.png",
          ),
          await takeControlUiViewportScreenshot(page, page.locator(".shell"), [busyRow]),
        );
      }
      await plainRow.waitFor();
      for (const size of badgeSizes) {
        expect(size).toEqual({ height: 12, width: 12 });
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps the authenticated assistant avatar stable across same-agent switches", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
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

    try {
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

      const sessionRow = (sessionKey: string) =>
        page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
      const sessionB = sessionRow("agent:main:session-b");
      await sessionB.locator("a.sidebar-recent-session__link").click();
      await expect
        .poll(() => sessionB.getAttribute("class"))
        .toContain("sidebar-recent-session--active");
      await expect.poll(() => avatar.getAttribute("src")).toMatch(/^blob:/);
      await expect.poll(() => avatar.isVisible()).toBe(true);

      const sessionA = sessionRow("agent:main:session-a");
      await sessionA.locator("a.sidebar-recent-session__link").click();
      await expect
        .poll(() => sessionA.getAttribute("class"))
        .toContain("sidebar-recent-session--active");

      await expect.poll(() => avatar.getAttribute("src")).toMatch(/^blob:/);
      await expect.poll(() => avatar.isVisible()).toBe(true);
      expect(avatarAuthorizations).toEqual(["Bearer e2e-device-token"]);
      expect(
        await page.evaluate(
          () =>
            (window as Window & { __openclawAvatarTestDocument?: string })[
              "__openclawAvatarTestDocument"
            ],
        ),
      ).toBe(documentMarker);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
