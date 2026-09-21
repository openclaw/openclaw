// @vitest-environment node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";
import { withBrowserPage } from "../../test-helpers/browser-page.ts";
import {
  canRunChatLayoutBrowser,
  createChatLayoutBrowser,
  getBoundingBox,
  getRect,
  messageCircleOffSvg,
  readUiCss,
  rectsOverlap,
  waitForLayoutSettled,
} from "./chat-layout.browser.test-support.ts";

const describeBrowserLayout = canRunChatLayoutBrowser ? describe : describe.skip;
const layoutBrowser = createChatLayoutBrowser();
const { openBrowserPage } = layoutBrowser;

// Playwright types generic trace records as string dictionaries, while Chromium
// sends structured arguments. Validate the records this regression relies on.
const layoutTraceEventSchema = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("Layout"),
    args: z.object({ beginData: z.object({ frame: z.string() }) }),
  }),
  z.object({
    name: z.literal("LayoutInvalidationTracking"),
    args: z.object({
      data: z.object({
        frame: z.string(),
        reason: z.string(),
        nodeName: z.string().optional(),
      }),
    }),
  }),
]);

describeBrowserLayout.concurrent("chat footer browser layout", () => {
  beforeAll(() => layoutBrowser.start());
  afterAll(() => layoutBrowser.close());

  it("does not rebuild the footer layout tree while autosizing the editor", async () => {
    await withBrowserPage(openBrowserPage(1200, 800), async (page) => {
      // Keep the grid/flex chain: a directly sized conversation cannot reproduce
      // the intermediate height-query changes during flex measurement.
      await page.setContent(`<style>${readUiCss()}</style>
        <section class="chat">
          <div class="chat-workbench"><div class="chat-workbench__main">
            <div class="chat-split-container"><div class="chat-main">
              <div class="chat-main__conversation-column">
                <div class="chat-main__conversation-frame"><div class="chat-main__conversation">
                  <div class="chat-thread">${"<p>Earlier message</p>".repeat(20)}</div>
                  <div class="chat-footer"><div class="agent-chat__composer-shell">
                    <div class="agent-chat__input agent-chat__input--chat">
                      <div class="agent-chat__composer-combobox"><textarea></textarea></div>
                    </div>
                  </div></div>
                </div></div>
              </div>
            </div></div>
          </div></div>
        </section>`);
      await waitForLayoutSettled(page, ".chat-main__conversation, .chat-footer");
      const before = await getRect(page, ".chat-main__conversation");
      expect(before.height).toBeGreaterThan(320);
      const client = await page.context().newCDPSession(page);
      const { frameTree } = await client.send("Page.getFrameTree");
      let layouts = 0;
      const footerReattachments: string[] = [];
      const traceErrors: string[] = [];
      client.on("Tracing.dataCollected", ({ value }) => {
        for (const rawEvent of value) {
          if (rawEvent.name !== "Layout" && rawEvent.name !== "LayoutInvalidationTracking") {
            continue;
          }
          const parsed = layoutTraceEventSchema.safeParse(rawEvent);
          if (!parsed.success) {
            traceErrors.push(parsed.error.message);
            continue;
          }
          const event = parsed.data;
          if (event.name === "Layout") {
            if (event.args.beginData.frame === frameTree.frame.id) {
              layouts++;
            }
            continue;
          }
          const { data } = event.args;
          if (
            data.frame === frameTree.frame.id &&
            data.reason === "Added to layout" &&
            data.nodeName?.includes("class='chat-footer'")
          ) {
            footerReattachments.push(data.nodeName);
          }
        }
      });
      await client.send("Tracing.start", {
        categories: "devtools.timeline,disabled-by-default-devtools.timeline.invalidationTracking",
        transferMode: "ReportEvents",
      });
      try {
        await page.locator("textarea").evaluate((editor: HTMLTextAreaElement) => {
          for (const letter of "typing中文") {
            editor.value += letter;
            // Match the synchronous auto/scrollHeight sizing boundary without
            // app startup or a machine-dependent elapsed-time assertion.
            editor.style.height = "auto";
            editor.style.height = `${editor.scrollHeight}px`;
            editor.getBoundingClientRect();
          }
        });
      } finally {
        const complete = new Promise<void>((resolve) => {
          client.once("Tracing.tracingComplete", () => resolve());
        });
        await client.send("Tracing.end");
        await complete;
        await client.detach();
      }
      expect(await getRect(page, ".chat-main__conversation")).toEqual(before);
      expect(traceErrors).toEqual([]);
      expect(layouts).toBeGreaterThan(0);
      expect(footerReattachments).toEqual([]);

      // The fix must retain height queries, not just avoid their invalidations.
      const fadeDisplay = () =>
        page
          .locator(".chat-footer")
          .evaluate((footer) => getComputedStyle(footer, "::before").display);
      const editorCap = () =>
        page
          .locator("textarea")
          .evaluate((editor) => Number.parseFloat(getComputedStyle(editor).maxHeight));
      expect(await fadeDisplay()).not.toBe("none");
      const tallEditorCap = await editorCap();
      await page.setViewportSize({ width: 1200, height: 260 });
      const shortConversation = await getRect(page, ".chat-main__conversation");
      const thread = await getRect(page, ".chat-thread");
      const footer = await getRect(page, ".chat-footer");
      expect(shortConversation.height).toBe(260);
      expect(await fadeDisplay()).toBe("none");
      expect(await editorCap()).toBeLessThan(tallEditorCap);
      expect(thread.height).toBeGreaterThan(0);
      expect(thread.bottom).toBeLessThanOrEqual(footer.top);
      expect(footer.bottom).toBeLessThanOrEqual(shortConversation.bottom);
    });
  });

  it("aligns and separates mobile cards above the composer after Chat styles load", async () => {
    await withBrowserPage(openBrowserPage(390, 844), async (page) => {
      // New Session can load composer styles before Chat's lazy layout stylesheet.
      await page.setContent(`<style>${readUiCss()}${readStyleSheet("ui/src/styles/chat/layout.css")}</style>
        <section class="chat"><div class="chat-main__conversation-frame"><div class="chat-main__conversation">
          <div class="chat-footer">
            <div class="agent-chat__composer-shell">
              <div class="chat-footer__context">
                <div class="chat-inline-approval">Approval</div>
                <div class="chat-prs"><article class="chat-pr">Pull request</article></div>
                <div class="session-suggestions">Suggestion</div>
                <div class="chat-swarm">Parallel task</div>
                <openclaw-plugin-contributions><button data-plugin-action>Plugin action</button></openclaw-plugin-contributions>
              </div>
              <div class="agent-chat__input">Composer</div>
            </div>
          </div>
        </div></div></section>`);
      const composer = await getRect(page, ".agent-chat__input");
      for (const selector of [
        ".chat-prs",
        ".chat-swarm",
        ".session-suggestions",
        ".chat-inline-approval",
      ]) {
        const card = await getRect(page, selector);
        expect(card.left, selector).toBeCloseTo(composer.left, 0);
        expect(card.right, selector).toBeCloseTo(composer.right, 0);
      }
      for (const selector of [".session-suggestions", ".chat-swarm", "[data-plugin-action]"]) {
        const pullRequest = await getRect(page, ".chat-pr");
        const neighbor = await getRect(page, selector);
        expect(neighbor.top, selector).toBeGreaterThan(pullRequest.bottom);
        await page.locator(selector).evaluate((element) => element.remove());
      }
    });
  });

  it.each([
    [1200, 800, "desktop"],
    [390, 844, "mobile"],
  ] as const)(
    "keeps the complete interrupted status above the input inside the %s footer",
    async (width, height, label) => {
      await withBrowserPage(openBrowserPage(width, height), async (page) => {
        await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body>
        <section class="chat">
          <div class="chat-main__conversation-frame"><div class="chat-main__conversation">
            <div class="chat-thread" role="log"><div class="chat-thread-inner">Transcript</div></div>
            <div class="chat-footer">
              <div class="agent-chat__composer-shell">
                <div class="chat-footer__context">
                <div class="agent-chat__composer-notices">
                  <div class="agent-chat__composer-run-status">
                    <span class="agent-chat__run-status agent-chat__run-status--interrupted">
                  ${messageCircleOffSvg()}<span class="agent-chat__run-status-label">Interrupted</span>
                    </span>
                  </div>
                </div>
                </div>
                <div class="agent-chat__input">Composer</div>
              </div>
            </div>
          </div></div>
        </section>
      </body></html>`);

        const [composer, status, input, footer, thread] = await Promise.all([
          getRect(page, ".agent-chat__composer-shell"),
          getRect(page, ".agent-chat__composer-run-status"),
          getRect(page, ".agent-chat__input"),
          getRect(page, ".chat-footer"),
          getRect(page, ".chat-thread"),
        ]);
        expect(
          Math.abs(status.left + status.width / 2 - (composer.left + composer.width / 2)),
        ).toBeLessThan(1);
        expect(status.top).toBeGreaterThanOrEqual(composer.top);
        expect(status.bottom).toBeLessThanOrEqual(input.top);
        expect(thread.bottom).toBeLessThanOrEqual(footer.top);
        expect(composer.bottom).toBeLessThanOrEqual(footer.bottom);
        expect(
          await page.locator(".agent-chat__run-status-label").evaluate((node) => ({
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
            text: node.textContent,
          })),
        ).toEqual(expect.objectContaining({ text: "Interrupted" }));
        const labelWidths = await page
          .locator(".agent-chat__run-status-label")
          .evaluate((node) => ({
            clientWidth: node.clientWidth,
            scrollWidth: node.scrollWidth,
          }));
        expect(labelWidths.scrollWidth).toBeLessThanOrEqual(labelWidths.clientWidth);
        const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
        if (artifactDir) {
          await mkdir(artifactDir, { recursive: true });
          await page.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, `interrupted-status-${label}.png`),
          });
        }
      });
    },
  );

  it.each([
    [1200, 800, "desktop", "overlay", false],
    [900, 500, "mobile-landscape-900", "inline", false],
    [640, 900, "mobile-responsive-640", "overlay", false],
    [320, 568, "mobile-320", "overlay", false],
    [375, 812, "mobile-375", "overlay", false],
    [430, 932, "mobile-430", "overlay", false],
    [1200, 800, "desktop-with-pull-request", "overlay", true],
    [375, 812, "mobile-with-pull-request", "overlay", true],
  ] as const)(
    "reserves footer notice space and keeps menus actionable at %sx%s (%s)",
    async (width, height, label, menuPlacement, withPullRequest) => {
      await withBrowserPage(openBrowserPage(width, height), async (page) => {
        await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head><body style="margin:0;height:100vh;overflow:hidden">
          <div class="shell shell--chat ${label.startsWith("mobile") ? "shell--mobile-nav shell--merged-chat-chrome" : ""}">
            <main class="content content--chat" style="padding:0">
              <div class="sidebar-region">
                <div class="sidebar-region__header">
                  <header class="chat-pane__header">Session</header>
                </div>
                  <div class="sidebar-region__primary" data-region="main">
                    <section class="chat">
                      <div class="chat-main">
                        <div class="chat-main__conversation-column">
                          <div class="chat-topbar-notices"></div>
                          <div class="chat-main__conversation-frame"><div class="chat-main__conversation">
                            <div class="chat-thread" role="log"><div class="chat-thread-inner">Transcript</div></div>
                            <div class="chat-gutter-stack"><div class="task-suggestions">Task suggestion</div></div>
                            <div class="chat-footer">
                            <div class="agent-chat__composer-shell">
                              <div class="chat-footer__context">
                            ${withPullRequest ? '<div class="chat-prs"><article class="chat-pr" data-state="open"><a class="chat-pr__link" href="https://github.com/example/repo/pull/42">PR #42</a></article></div>' : ""}
                              <openclaw-plugin-contributions></openclaw-plugin-contributions>
                              <div class="agent-chat__composer-notices"></div>
                              </div>
                              <div class="agent-chat__input">Composer</div>
                            </div>
                            </div>
                          </div></div>
                        </div>
                      </div>
                    </section>
                  </div>
              </div>
            </main>
            <openclaw-toast-host data-toast-placement="shell">
              <div class="app-toast">Connection notice</div>
            </openclaw-toast-host>
          </div>
        </body></html>`);
        await waitForLayoutSettled(page, ".chat-main__conversation, .agent-chat__composer-shell");

        const geometry = async () =>
          await page.evaluate(() => {
            const rect = (selector: string) => {
              const bounds = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
              return {
                bottom: bounds.bottom,
                height: bounds.height,
                top: bounds.top,
                width: bounds.width,
              };
            };
            const footer = document
              .querySelector<HTMLElement>(".chat-footer")!
              .getBoundingClientRect();
            const threadElement = document.querySelector<HTMLElement>(".chat-thread")!;
            const thread = threadElement.getBoundingClientRect();
            const fade = getComputedStyle(
              document.querySelector<HTMLElement>(".chat-footer")!,
              "::before",
            );
            return {
              composer: rect(".agent-chat__composer-shell"),
              conversation: rect(".chat-main__conversation"),
              footer: rect(".chat-footer"),
              input: rect(".agent-chat__input"),
              fadeInsetLeft: footer.left + Number.parseFloat(fade.left) - thread.left,
              fadeInsetRight: thread.right - (footer.right - Number.parseFloat(fade.right)),
              scrollbarSize: (thread.width - threadElement.clientWidth) / 2,
              thread: rect(".chat-thread"),
            };
          });
        expect(await page.locator(".chat-topbar-notices").isVisible()).toBe(false);
        expect(await page.locator(".agent-chat__composer-notices").isVisible()).toBe(false);
        expect(await page.locator(".chat-footer__context").isVisible()).toBe(withPullRequest);
        const before = await geometry();
        expect(before.fadeInsetLeft).toBeGreaterThanOrEqual(before.scrollbarSize);
        expect(before.fadeInsetRight).toBeGreaterThanOrEqual(before.scrollbarSize);
        expect(before.thread.bottom).toBeLessThanOrEqual(before.footer.top);
        await page.locator(".chat-topbar-notices").evaluate((node) => {
          node.innerHTML =
            '<div class="chat-composer-neighbor-card chat-cloud-disk-space-notice">Disk space low</div>';
        });
        await page.locator(".agent-chat__composer-notices").evaluate((node) => {
          node.innerHTML =
            '<div class="chat-composer-neighbor-card chat-error">Model unavailable</div>';
        });
        await waitForLayoutSettled(page, ".chat-main__conversation, .agent-chat__composer-shell");
        expect(await page.getByText("Disk space low").isVisible()).toBe(true);
        expect(await page.getByText("Model unavailable").isVisible()).toBe(true);
        const after = await geometry();

        for (const key of ["composer", "conversation", "thread", "footer", "input"] as const) {
          expect(after[key].width).toBe(before[key].width);
        }
        expect(after.conversation).toEqual(before.conversation);
        expect(after.input).toEqual(before.input);
        expect(after.footer.height).toBeGreaterThan(before.footer.height);
        expect(after.thread.height).toBeLessThan(before.thread.height);
        expect(after.thread.bottom).toBeLessThanOrEqual(after.footer.top);
        const notices = await getRect(page, ".agent-chat__composer-notices");
        expect(notices.top).toBeGreaterThanOrEqual(after.footer.top);
        expect(notices.bottom).toBeLessThanOrEqual(after.input.top);
        const context = await getRect(page, ".chat-footer__context");
        expect(context.bottom).toBeLessThanOrEqual(after.input.top);
        expect(
          await page
            .locator(".agent-chat__input")
            .evaluate((node) => Boolean(node.closest(".chat-footer__context"))),
        ).toBe(false);
        if (withPullRequest) {
          const pullRequest = await getRect(page, ".chat-pr");
          expect(pullRequest.top).toBeGreaterThanOrEqual(after.thread.bottom);
          expect(pullRequest.bottom).toBeLessThanOrEqual(notices.top);
          await page.getByRole("link", { name: "PR #42" }).click({ trial: true });
        }
        expect(
          await page
            .locator(".chat-topbar-notices")
            .evaluate((node) => getComputedStyle(node).position),
        ).toBe("absolute");
        const header = await getBoundingBox(page, ".chat-pane__header");
        const overlayTops = await Promise.all(
          [".chat-topbar-notices", ".chat-gutter-stack", ".app-toast"].map(async (selector) => ({
            selector,
            top: (await getBoundingBox(page, selector)).y,
          })),
        );
        if (label.startsWith("mobile")) {
          for (const overlay of overlayTops) {
            expect(overlay.top, overlay.selector).toBeGreaterThanOrEqual(header.y + header.height);
          }
        } else {
          expect(
            overlayTops.find((overlay) => overlay.selector === ".chat-topbar-notices")?.top,
          ).toBeCloseTo(header.y + header.height + 8, 0);
          expect(
            overlayTops.find((overlay) => overlay.selector === ".app-toast")?.top,
          ).toBeGreaterThanOrEqual(header.y + header.height);
        }

        await page.locator(".agent-chat__input").evaluate((node) => {
          node.insertAdjacentHTML(
            "afterbegin",
            `<div class="slash-menu mention-menu" role="listbox" aria-label="Mention a person">
              <div class="slash-menu__scroll">
                <div class="slash-menu-group">
                  <div class="slash-menu-group__label">Mention a person</div>
                  <div class="slash-menu-item slash-menu-item--active" role="option" aria-selected="true">
                    <span class="slash-menu-icon" aria-hidden="true">B</span>
                    <span class="slash-menu-copy">
                      <span class="slash-menu-name">Bob</span>
                      <span class="slash-menu-desc">Online</span>
                    </span>
                  </div>
                </div>
              </div>
            </div>`,
          );
          const option = node.querySelector<HTMLElement>('[role="option"]')!;
          option.addEventListener("click", () => {
            option.dataset.selected = "true";
          });
        });
        await waitForLayoutSettled(page, ".slash-menu, .chat-error");
        expect(await geometry()).toEqual(after);
        const option = page.getByRole("option");
        const optionBounds = await getBoundingBox(page, ".slash-menu-item");
        const noticeBounds = await getBoundingBox(page, ".chat-error");
        expect(
          await page.locator(".slash-menu").evaluate((node) => getComputedStyle(node).position),
        ).toBe(menuPlacement === "inline" ? "sticky" : "absolute");
        let optionPoint: { x: number; y: number };
        if (menuPlacement === "inline") {
          // Short landscape keeps the menu inside the input; notices remain above it.
          const inputBounds = await getBoundingBox(page, ".agent-chat__input");
          expect(rectsOverlap(optionBounds, noticeBounds)).toBe(false);
          expect(noticeBounds.y + noticeBounds.height).toBeLessThanOrEqual(optionBounds.y);
          expect(optionBounds.y).toBeGreaterThanOrEqual(inputBounds.y);
          expect(optionBounds.y + optionBounds.height).toBeLessThanOrEqual(
            inputBounds.y + inputBounds.height,
          );
          optionPoint = {
            x: optionBounds.x + optionBounds.width / 2,
            y: optionBounds.y + optionBounds.height / 2,
          };
        } else if (rectsOverlap(optionBounds, noticeBounds)) {
          optionPoint = {
            x:
              (Math.max(optionBounds.x, noticeBounds.x) +
                Math.min(
                  optionBounds.x + optionBounds.width,
                  noticeBounds.x + noticeBounds.width,
                )) /
              2,
            y:
              (Math.max(optionBounds.y, noticeBounds.y) +
                Math.min(
                  optionBounds.y + optionBounds.height,
                  noticeBounds.y + noticeBounds.height,
                )) /
              2,
          };
        } else {
          optionPoint = {
            x: optionBounds.x + optionBounds.width / 2,
            y: optionBounds.y + optionBounds.height / 2,
          };
        }
        expect(
          await option.evaluate((node, point) => {
            const hit = document.elementFromPoint(point.x, point.y);
            return node.contains(hit) ? "option" : hit?.className;
          }, optionPoint),
        ).toBe("option");
        await page.mouse.click(optionPoint.x, optionPoint.y);
        expect(await option.getAttribute("data-selected")).toBe("true");
        await page.locator(".slash-menu").evaluate((node) => node.remove());
        const noticePoint = {
          x: noticeBounds.x + noticeBounds.width / 2,
          y: noticeBounds.y + noticeBounds.height / 2,
        };
        expect(
          await page
            .locator(".chat-error")
            .evaluate(
              (node, point) => node.contains(document.elementFromPoint(point.x, point.y)),
              noticePoint,
            ),
        ).toBe(true);
        const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
        if (artifactDir) {
          await mkdir(artifactDir, { recursive: true });
          await page.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, `notice-overlays-${label}.png`),
          });
        }
      });
    },
  );
});
