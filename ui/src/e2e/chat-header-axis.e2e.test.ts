import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { chatFixture, newChatPage, sessionRow } from "./chat-flow-fixtures.test-support.ts";
import {
  chatSessionListResponse,
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { captureFrame } from "./sidebar-assertions.test-support.ts";

const suite = createChatFlowE2eSuite();
const sessionKey = "agent:main:session-a";
const parentLabel = "Release readiness and production rollout coordination";
const workspaceRow = (key: string, label: string, updatedAt: number, fields = {}) =>
  sessionRow(key, label, updatedAt, { spawnedCwd: "/repo/openclaw", ...fields });
const compactPage = (viewport: { width: number; height: number }) =>
  chatFixture(suite, { sessions: chatSessionListResponse().sessions }, { viewport });
suite.define(() => {
  for (const colorScheme of ["light", "dark"] as const) {
    for (const viewport of [
      { label: "desktop", width: 800 },
      { label: "mobile", width: 760 },
      { label: "phone", width: 390 },
    ] as const) {
      it(`lays out and navigates the ${viewport.label} project-parent-child trail in ${colorScheme} mode`, async () => {
        const { page } = await newChatPage(suite, {
          colorScheme,
          viewport: { height: 520, width: viewport.width },
        });
        const favicon = await readFile(path.resolve(process.cwd(), "ui/public/favicon.svg"));
        await page.route("**/__openclaw__/workspace-icon/**", async (route) => {
          await route.fulfill({ body: favicon, contentType: "image/svg+xml", status: 200 });
        });
        await installMockGateway(page, {
          sessions: [
            workspaceRow("agent:main:parent", parentLabel, 1),
            workspaceRow(
              sessionKey,
              "Implement parent breadcrumb navigation and polish overflow behavior",
              2,
              { parentSessionKey: "agent:main:parent" },
            ),
          ],
          sessionKey,
        });

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const header = page.locator(
          "openclaw-chat-pane.chat-pane-cache__pane--active .chat-pane__header",
        );
        const title = header.locator(".chat-pane__session-title-text");
        await header.waitFor();
        await header.locator(".workspace-icon").waitFor();

        if (captureUiProofEnabled) {
          await captureFrame(
            suite.artifactDir,
            `project-icon-${viewport.label}-${colorScheme}.png`,
            header,
            [header.locator(".workspace-icon"), title],
          );
        }

        const geometry = await header.evaluate((root) => {
          const main = root
            .closest("openclaw-chat-pane")
            ?.querySelector('[data-region="main"]:not([hidden])');
          if (!main) {
            throw new Error("Task header requires visible main content");
          }
          const element = (selector: string) => {
            const node = root.querySelector(selector);
            if (!node) {
              throw new Error(`missing header element: ${selector}`);
            }
            return node;
          };
          const rect = (selector: string) => element(selector).getBoundingClientRect();
          const centerY = (selector: string) => {
            const { top, height } = rect(selector);
            return top + height / 2;
          };
          const ellipses = (selector: string) => {
            const node = element(selector);
            return node.scrollWidth > node.clientWidth;
          };
          return {
            nav: centerY(".chat-pane__nav-toggle svg"),
            projectIcon: centerY(".workspace-icon"),
            projectText: centerY(".chat-pane__workspace-chip > .oc-menu-item__label > span"),
            menu: centerY(".chat-header-session-menu__trigger svg"),
            parentText: centerY(".chat-pane__parent-session-text"),
            sessionText: centerY(".chat-pane__session-title-text"),
            projectBottom: rect(".chat-pane__project-row").bottom,
            sessionTop: rect(".chat-pane__session-trail").top,
            separatorDisplays: [...root.querySelectorAll<HTMLElement>(".chat-pane__crumb-sep")].map(
              (node) => getComputedStyle(node).display,
            ),
            headerBottom: root.getBoundingClientRect().bottom,
            headerOverflow: root.scrollWidth - root.clientWidth,
            titleWidth: rect(".chat-pane__session-title-text").width,
            contentTop: main.getBoundingClientRect().top,
            parentEllipses: ellipses(".chat-pane__parent-session-text"),
            childEllipses: ellipses(".chat-pane__session-title-text"),
            trailWidth:
              rect(".chat-pane__session-title").right - rect(".chat-pane__parent-session").left,
            headerWidth: root.getBoundingClientRect().width,
          };
        });

        expect(Math.abs(geometry.menu - geometry.nav)).toBeLessThanOrEqual(0.1);
        expect(geometry.contentTop).toBeGreaterThanOrEqual(geometry.headerBottom - 0.1);
        expect(geometry.headerOverflow).toBeLessThanOrEqual(1);
        expect(geometry.titleWidth).toBeGreaterThan(0);
        expect(geometry.projectIcon, JSON.stringify(geometry)).toBeCloseTo(geometry.projectText, 1);
        if (viewport.label === "desktop") {
          for (const center of [
            geometry.projectIcon,
            geometry.projectText,
            geometry.parentText,
            geometry.sessionText,
          ]) {
            // The identity trail needs a 1px optical lift relative to Lucide actions.
            expect(geometry.nav - center, JSON.stringify(geometry)).toBeCloseTo(1, 1);
          }
          expect(geometry.separatorDisplays).toEqual(["block", "block"]);
        } else {
          expect(geometry.projectBottom - geometry.sessionTop).toBeLessThanOrEqual(0.1);
          expect(geometry.parentText).toBeCloseTo(geometry.sessionText, 1);
          expect(geometry.separatorDisplays).toEqual(["none", "none"]);
        }
        const parent = header.locator(".chat-pane__parent-session");
        expect(geometry).toMatchObject({ parentEllipses: true, childEllipses: true });
        expect(geometry.trailWidth).toBeLessThanOrEqual(geometry.headerWidth / 2 + 1);
        expect((await parent.textContent())?.trim()).toBe(parentLabel);
        await parent.click();
        await expect.poll(() => title.textContent()).toBe(parentLabel);
      });
    }
  }

  for (const viewport of [
    { height: 844, label: "portrait", width: 390 },
    { height: 393, label: "short landscape", width: 852 },
  ] as const) {
    it(`keeps compact ${viewport.label} transcript search below the task header`, async () => {
      const { page } = await compactPage(viewport);

      await page.goto(`${suite.server.baseUrl}chat`);
      await page.locator(".agent-chat__composer-combobox > textarea").focus();
      await page.keyboard.press("ControlOrMeta+f");
      const search = page.locator(".agent-chat__search-bar input");
      await search.waitFor();
      const [headerBox, searchBox] = await Promise.all([
        page.locator(".chat-pane__header").first().boundingBox(),
        search.boundingBox(),
      ]);
      expect(searchBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height);
      await search.click();
      await search.fill("reachable");
      expect(await search.inputValue()).toBe("reachable");
    });

    it(`preserves compact ${viewport.label} New Session composer edge margins`, async () => {
      const { context, page } = await compactPage(viewport);

      await page.goto(`${suite.server.baseUrl}new`);
      const protocol = await context.newCDPSession(page);
      await protocol.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: 34 } });
      const composer = page.locator(".new-session-page__composer");
      await composer.waitFor();
      await composer.scrollIntoViewIfNeeded();
      const bounds = await composer.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          bottom: rect.bottom,
          draftBottom: element.closest(".new-session-page__draft")!.getBoundingClientRect().bottom,
          shellBottom: element.closest(".shell")!.getBoundingClientRect().bottom,
        };
      });
      // The draft's 6px gap must not reserve the physical inset again.
      expect(bounds.shellBottom).toBeCloseTo(viewport.height - 34, 0);
      expect(bounds.draftBottom - bounds.bottom).toBeCloseTo(6, 0);
      expect(bounds.bottom).toBeLessThanOrEqual(bounds.shellBottom);
      expect(bounds.left).toBeGreaterThanOrEqual(20);
      expect(bounds.right).toBeLessThanOrEqual(viewport.width - 20);
      expect(bounds.left).toBeCloseTo(viewport.width - bounds.right, 0);
    });
  }

  it("repaints a mounted project icon after the Gateway advertises a retry", async () => {
    const { page } = await newChatPage(suite, {
      viewport: { height: 520, width: 800 },
    });
    const favicon = await readFile(path.resolve(process.cwd(), "ui/public/favicon.svg"));
    let requests = 0;
    await page.route("**/__openclaw__/workspace-icon/**", async (route) => {
      requests += 1;
      if (requests === 1) {
        await route.fulfill({
          body: "workspace icon snapshot is not ready",
          headers: { "retry-after": "1" },
          status: 503,
        });
        return;
      }
      await route.fulfill({ body: favicon, contentType: "image/svg+xml", status: 200 });
    });
    await installMockGateway(page, {
      sessions: [workspaceRow(sessionKey, "Workspace icon recovery", 1)],
      sessionKey,
    });

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
    const icon = page.locator(".chat-pane__header openclaw-workspace-icon").first();
    await icon.waitFor();
    await icon.locator("svg").waitFor();
    await icon.evaluate((element) => element.setAttribute("data-recovery-host", "mounted"));
    if (captureUiProofEnabled) {
      await page.screenshot({
        path: path.join(suite.artifactDir, "workspace-icon-recovery", "fallback.png"),
      });
    }

    await icon.locator(".workspace-icon").waitFor({ timeout: 10_000 });

    expect(requests).toBe(2);
    expect(await icon.getAttribute("data-recovery-host")).toBe("mounted");
    if (captureUiProofEnabled) {
      await page.screenshot({
        path: path.join(suite.artifactDir, "workspace-icon-recovery", "recovered.png"),
      });
    }
  });
});
