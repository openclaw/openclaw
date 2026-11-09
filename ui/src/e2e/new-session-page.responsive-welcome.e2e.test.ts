import { expect, it } from "vitest";
import { waitForLayoutSettled } from "../pages/chat/chat-layout.browser.test-support.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createPageOpener } from "./new-session-page.scenario.test-support.ts";
import {
  captureUiProof,
  captureUiProofEnabled,
  createNewSessionPageE2eSuite,
  installMockGateway,
  waitForGatewayRecoveryScope,
  pollAttribute,
  pollCount,
  pollText,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const openPage = createPageOpener(suite);
const recent = (id: string, label: string, updatedAt: number) => ({
  key: `agent:main:dashboard:${id}`,
  kind: "direct",
  label,
  updatedAt,
});
const sessionList = (sessions: ReturnType<typeof recent>[], ts = Date.now()) => ({
  count: sessions.length,
  defaults: { contextTokens: null, model: null, modelProvider: null },
  path: "",
  sessions,
  ts,
});

suite.define(() => {
  it.each([1, 2])("keeps phone setup compact with %s agents", async (agentCount) => {
    const page = await openPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await installMockGateway(page, {
      workspace: "/workspace/openclaw",
      workspaceGit: true,
      featureMethods: ["projects.list", "sessions.create", "worktrees.branches"],
      methodResponses: {
        "agents.list": {
          agents: (
            [
              ["main", "Roboclaw", "/workspace/openclaw"],
              ["research", "Research", "/workspace/research"],
            ] as const
          )
            .slice(0, agentCount)
            .map(([id, name, workspace]) => ({
              id,
              name,
              workspace,
              workspaceGit: true,
            })),
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "worktrees.branches": {
          branches: [{ kind: "local", name: "main" }],
          defaultBranch: "main",
          headBranch: "main",
          repositoryStatus: "git",
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}new`);
    const checkout = page.locator("#new-session-checkout-trigger");
    const triggerRow = page.locator(".new-session-page__triggers");
    await checkout.waitFor();
    await page.mouse.move(0, 0);

    expect(
      await page
        .locator("#new-session-project-trigger .new-session-page__trigger-label")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await checkout.click();
    await page
      .getByRole("button", { name: "New worktree Isolated copy of the repo", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await pollAttribute(checkout, "data-worktree").toBe("true");
    const selectors = page.locator(
      ".new-session-page .agent-select__trigger, .new-session-page__triggers .new-session-page__trigger",
    );
    await pollCount(selectors).toBe(agentCount + 2);
    await page.evaluate(() => document.fonts.ready);
    for (const { width, mobile } of [
      { width: 390, mobile: true },
      { width: 320, mobile: true },
      { width: 430, mobile: true },
      { width: 560, mobile: true },
      { width: 1280, mobile: false },
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await page
        .locator(mobile ? ".shell--mobile-nav" : ".shell:not(.shell--mobile-nav)")
        .waitFor();
      await selectors.first().click({ trial: true });
      await checkout.evaluate((element) => element.blur());
      await page.mouse.move(0, 0);
      await waitForLayoutSettled(page, ".new-session-page__triggers button");

      if (captureUiProofEnabled && width === 390 && agentCount === 2) {
        await evaluateControlUiContext(page, (context) => context.theme.setMode("dark"));
        await pollAttribute(page.locator("html"), "data-theme-mode").toBe("dark");

        await evaluateControlUiContext(page, (context) => context.theme.setMode("light"));
      }
      const layout = await triggerRow.locator(".new-session-page__trigger").evaluateAll((buttons) =>
        buttons.map((button) => {
          const box = button.getBoundingClientRect();
          // Flex/grid aligns the wrapper; inline button baselines can differ within one row.
          const item = button.closest(".new-session-page__select")!.getBoundingClientRect();
          return {
            row: Math.round(item.top + item.height / 2),
            left: box.left,
            right: box.right,
            height: box.height,
            width: box.width,
          };
        }),
      );
      expect(new Set(layout.map((box) => box.row)).size).toBeLessThanOrEqual(mobile ? 2 : 1);
      if (mobile) {
        // #192044 renamed Local to This computer; keep the picker within half a row.
        const device = page.locator("#new-session-where-trigger");
        const rowWidth = (await triggerRow.boundingBox())!.width;
        expect((await device.boundingBox())!.width).toBeLessThanOrEqual(rowWidth / 2);
      }
      for (const [index, box] of layout.entries()) {
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.right).toBeLessThanOrEqual(width);
        expect(box.height).toBeGreaterThanOrEqual(width <= 560 ? 44 : 26);
        if (mobile) {
          expect(box.width).toBeGreaterThanOrEqual(44);
        }
        const next = layout[index + 1];
        if (next && box.row === next.row) {
          expect(box.right).toBeLessThanOrEqual(next.left);
        }
      }
    }
    await page.setViewportSize({ width: 320, height: 700 });
    for (const selector of await selectors.all()) {
      await selector.click();
      await pollAttribute(selector, "aria-expanded").toBe("true");
      const panelSelector =
        ".oc-popover.new-session-page__picker-popover:popover-open, .agent-select__menu:popover-open";
      await waitForLayoutSettled(page, panelSelector);
      const panelBox = await page.locator(panelSelector).boundingBox();
      expect(panelBox!.x).toBeGreaterThanOrEqual(0);
      expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(320);
      expect(await page.evaluate(() => window.scrollX)).toBe(0);
      await page.keyboard.press("Escape");
      await pollAttribute(selector, "aria-expanded").toBe("false");
      await selector.focus();
      await page.keyboard.press("Enter");
      await pollAttribute(selector, "aria-expanded").toBe("true");
      await page.keyboard.press("Escape");
      await pollAttribute(selector, "aria-expanded").toBe("false");
    }
    await checkout.click();
    const baseRef = page.locator("#new-session-worktree-base-ref");
    await baseRef.fill("feature/mobile-layout-with-a-long-branch-name");
    await page.keyboard.press("Escape");
    await pollText(checkout).toContain("feature/mobile-layout-with-a-long-branch-name");
    expect(await triggerRow.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await checkout.evaluate((element) => element.blur());
    await page.mouse.move(0, 0);

    const heading = page.locator(".agent-chat__welcome-name");
    if (agentCount > 1) {
      expect(
        await heading
          .locator(".agent-select__trigger")
          .evaluate((element) => getComputedStyle(element).fontSize),
      ).toBe(await heading.evaluate((element) => getComputedStyle(element).fontSize));
    }
    expect(await page.locator(".agent-chat__welcome-identity .agent-select__trigger").count()).toBe(
      agentCount - 1,
    );
    expect(await triggerRow.locator(".agent-select__trigger").count()).toBe(0);
    const projectBox = await page.locator("#new-session-project-trigger").boundingBox();
    const checkoutBox = await checkout.boundingBox();
    expect(projectBox!.y).toBe(checkoutBox!.y);
    expect(
      await page
        .locator("#new-session-project-trigger .new-session-page__trigger-label")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
  });

  it("keeps empty-state suggestions desktop-only across viewport changes", async () => {
    const page = await openPage({ viewport: { width: 1280, height: 900 } });
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionList([]),
      },
    });

    await page.goto(`${suite.server.baseUrl}new`);
    const suggestions = page.locator(".agent-chat__suggestion:visible");
    await pollCount(suggestions).toBe(4);

    await page.setViewportSize({ width: 390, height: 844 });
    await pollCount(suggestions).toBe(0);

    await page.setViewportSize({ width: 1280, height: 900 });
    await pollCount(suggestions).toBe(4);
  });

  it("offers session-scoped guests starter prompts within their own sessions", async () => {
    const page = await openPage({ viewport: { width: 1280, height: 900 } });
    await installMockGateway(page, {
      operatorScopes: ["operator.sessions.write"],
      methodResponses: {
        "sessions.list": sessionList([]),
      },
    });

    await page.goto(`${suite.server.baseUrl}new`);
    const suggestions = page.locator(".agent-chat__suggestion:visible");
    await pollCount(suggestions).toBe(4);
    expect(await suggestions.allTextContents()).toEqual([
      "What can you do?",
      "Tour OpenClaw’s code and docs",
      "Investigate an issue in a sandbox",
      "Fix a bug and open a draft PR",
    ]);
  });

  it("keeps recent-chat timestamps on one right-aligned line in a narrow column", async () => {
    const page = await openPage({ viewport: { width: 1280, height: 900 } });
    const now = Date.now();
    const checkout = (branch?: string) => ({
      worktree: { repoRoot: "/workspace/workspace-openclaw", ...(branch ? { branch } : {}) },
    });
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionList(
          [5_000, 32 * 60_000, 2 * 86_400_000, 5 * 86_400_000].map((age, index) =>
            Object.assign(
              recent(
                String(index),
                index === 1 ? "A long recent chat title. ".repeat(4) : "Recent work",
                now - age,
              ),
              index === 3 ? {} : checkout(["neat-lobster", undefined, "tender-krill"][index]),
            ),
          ),
          now,
        ),
      },
    });

    await page.goto(`${suite.server.baseUrl}new`);
    const rows = page.locator(".agent-chat__recent");
    await pollCount(rows).toBe(4);
    await page.evaluate(() => document.fonts.ready);
    // A narrow chat pane; the second pass lets inherited text wrap, as a
    // theme or plugin stylesheet may, which must not squeeze the timestamp.
    await page.addStyleTag({ content: ".agent-chat__recents { width: 320px; }" });
    for (const textWrap of ["default", "inherited-wrap"] as const) {
      if (textWrap === "inherited-wrap") {
        await page.addStyleTag({
          content: ".agent-chat__recent-time { white-space: normal; }",
        });
      }
      await waitForLayoutSettled(page, ".agent-chat__recent");

      const layout = await rows.evaluateAll((elements) =>
        elements.map((row) => {
          const time = row.querySelector<HTMLElement>(".agent-chat__recent-time")!;
          const name = row.querySelector<HTMLElement>(".agent-chat__recent-name")!;
          const lineHeight = Number.parseFloat(getComputedStyle(time).lineHeight);
          return {
            timeRight: Math.round(time.getBoundingClientRect().right),
            timeHeight: time.getBoundingClientRect().height,
            lineHeight,
            timeClipped: time.scrollWidth > time.clientWidth,
            nameTruncated: name.scrollWidth > name.clientWidth,
            rowRight: Math.round(row.getBoundingClientRect().right),
          };
        }),
      );
      expect(new Set(layout.map((row) => row.timeRight)).size, JSON.stringify(layout)).toBe(1);
      for (const row of layout) {
        expect(row.timeHeight, JSON.stringify(row)).toBeLessThanOrEqual(row.lineHeight + 1);
        expect(row.timeClipped, JSON.stringify(row)).toBe(false);
        expect(row.timeRight).toBeLessThanOrEqual(row.rowRight);
      }
      // The left side gives up the width: the long title truncates instead.
      expect(layout[1]!.nameTruncated).toBe(true);
    }
  });

  it("fits the docked mobile composer and scrolls long prompts inside the editor", async () => {
    const page = await openPage({ viewport: { width: 320, height: 568 } });
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionList([recent("recent", "Recent work", Date.now())]),
      },
    });

    await page.goto(`${suite.server.baseUrl}new`);
    await pollCount(page.locator(".agent-chat__recent")).toBe(1);
    expect(await page.locator(".agent-chat__recent").isVisible()).toBe(false);
    const scroll = page.locator(".new-session-page__scroll");
    const composer = page.locator(".new-session-page__composer");
    const textarea = page.locator(".new-session-page__message");
    await waitForLayoutSettled(page, ".new-session-page__composer");
    expect(await scroll.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);
    const composerBox = await composer.boundingBox();
    expect(composerBox!.y).toBeGreaterThan(58);
    expect(composerBox!.y + composerBox!.height).toBeLessThan(568);

    await textarea.fill("A line of a longer first prompt.\n".repeat(20));
    await waitForLayoutSettled(page, ".new-session-page__composer");
    await composer.scrollIntoViewIfNeeded();
    expect(await textarea.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    const sendBox = await page.locator(".new-session-page__start-submit").boundingBox();
    expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(568);
    await textarea.fill("");
    await waitForLayoutSettled(page, ".new-session-page__composer");
    expect(await scroll.evaluate((element) => element.scrollHeight - element.clientHeight)).toBe(0);

    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await page.locator(".agent-chat__recent").isVisible()).toBe(true);
  });

  it("shows font-sized people inline in the cold New Session document-aware editor", async () => {
    const page = await openPage({ viewport: { width: 1280, height: 900 } });
    const gateway = await installMockGateway(page, {
      presenceUsers: [
        {
          self: true,
          id: "profile-alice",
          identity: { type: "profile", id: "profile-alice" },
          name: "Alice",
        },
      ],
      methodResponses: {
        "users.mentionable": {
          users: [
            {
              profileId: "profile-bob",
              displayName: "Bob averylongmentionlabel",
              online: true,
            },
          ],
          truncated: false,
        },
      },
    });
    await page.goto(suite.server.baseUrl + "new");
    await waitForControlUiRoute(page, { pathname: "/new", routeId: "new-session" });
    await waitForGatewayRecoveryScope(page);
    const surface = page.locator(".new-session-page__composer");
    const textbox = surface.getByRole("textbox");
    const backing = surface.locator("textarea.new-session-page__message");
    await textbox.pressSequentially("@Bob");
    expect((await gateway.waitForRequest("users.mentionable")).params).toMatchObject({
      agentId: "main",
    });
    await page.getByRole("option", { name: /Bob/ }).click();
    const editor = surface.locator('[data-composer-editor="true"]');
    const mark = editor.locator(".chat-composer-mention");
    await pollText(mark).toContain("averylongmentionlabel");
    await pollCount(surface.getByRole("textbox")).toBe(1);
    await pollCount(page.locator(".chat-compose__mention-preview")).toBe(0);
    await expect
      .poll(() => backing.evaluate((element) => element instanceof HTMLElement && element.hidden))
      .toBe(true);
    await editor.pressSequentially("'s notes");
    await expect.poll(() => backing.inputValue()).toBe("@Bob averylongmentionlabel's notes");
    await captureUiProof(suite, page, "atomic-selected-mention-desktop.png");
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 720 });
      await waitForLayoutSettled(page, ".new-session-page__composer");
      const geometry = await editor.evaluate((element) => {
        const person = element.querySelector(".chat-composer-mention")!;
        const avatar = person
          .querySelector(".markdown-person-reference__avatar")!
          .getBoundingClientRect();
        const walker = document.createTreeWalker(person, NodeFilter.SHOW_TEXT);
        let nameNode = walker.nextNode();
        while (nameNode && !nameNode.textContent?.includes("averylongmentionlabel")) {
          nameNode = walker.nextNode();
        }
        const range = document.createRange();
        range.selectNodeContents(nameNode!);
        return {
          font: Number.parseFloat(getComputedStyle(person).fontSize),
          paddingTop: getComputedStyle(person.closest(".chat-composer-editor")!).paddingTop,
          avatarWidth: avatar.width,
          avatarHeight: avatar.height,
          gap: range.getBoundingClientRect().left - avatar.right,
          documentWidth: document.documentElement.scrollWidth,
        };
      });
      // Same avatar as a sent reference: the text size plus its 2px ring.
      expect(geometry.avatarWidth).toBeGreaterThanOrEqual(geometry.font);
      expect(geometry.avatarWidth).toBeLessThanOrEqual(geometry.font + 2.5);
      expect(geometry.avatarHeight).toBeCloseTo(geometry.avatarWidth, 1);
      expect(geometry.gap).toBeGreaterThanOrEqual(2);
      expect(geometry.documentWidth).toBeLessThanOrEqual(width);
      expect(geometry.paddingTop).toBe("10px");
      if (width === 390) {
        await captureUiProof(suite, page, "atomic-selected-mention-mobile.png");
      }
    }
    await textbox.press("Control+End");
    await page.keyboard.insertText("x".repeat(700));
    await expect
      .poll(() =>
        surface
          .locator(".cm-scroller")
          .evaluate((element) => element.scrollHeight > element.clientHeight),
      )
      .toBe(true);
    await textbox.fill("Edited without a mention");
    await pollCount(mark).toBe(0);
    await expect.poll(() => backing.inputValue()).toBe("Edited without a mention");
    await pollCount(surface.getByRole("textbox")).toBe(1);
  });
});
