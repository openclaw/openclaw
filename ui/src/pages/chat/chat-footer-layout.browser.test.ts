// @vitest-environment node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readStyleSheet } from "../../../../test/helpers/ui-style-fixtures.js";
import { withBrowserPage } from "../../test-helpers/browser-page.ts";
import {
  canRunChatLayoutBrowser,
  createChatLayoutBrowser,
  getBoundingBox,
  getRect,
  readUiCss,
  rectsOverlap,
  waitForLayoutSettled,
} from "./chat-layout.browser.test-support.ts";

const describeBrowserLayout = canRunChatLayoutBrowser ? describe : describe.skip;
const layoutBrowser = createChatLayoutBrowser();
const { openBrowserPage } = layoutBrowser;
type Box = Awaited<ReturnType<typeof getBoundingBox>>;
const center = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
function overlapCenter(first: Box, second: Box) {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}
function nest(classes: string, content: string) {
  return classes
    .split(" > ")
    .reduceRight((child, className) => `<div class="${className}">${child}</div>`, content);
}
const conversation = (content: string) =>
  nest("chat-main__conversation-frame > chat-main__conversation", content);
const composerFooter = (input: string, context = "") =>
  nest(
    "chat-footer > agent-chat__composer-shell",
    `${context}<div class="agent-chat__input">${input}</div>`,
  );
const style = (page: Page, selector: string, property: string, pseudo: string | null = null) =>
  page
    .locator(selector)
    .evaluate((node, css) => getComputedStyle(node, css.pseudo).getPropertyValue(css.property), {
      property,
      pseudo,
    });
const setHtml = (page: Page, selector: string, content: string) =>
  page.locator(selector).evaluate((node, html) => {
    node.innerHTML = html;
  }, content);
const hitTest = (page: Page, selector: string, point: { x: number; y: number }) =>
  page
    .locator(selector)
    .evaluate(
      (node, coordinates) => node.contains(document.elementFromPoint(coordinates.x, coordinates.y)),
      point,
    );

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

  it.each(["user", "assistant", "tool"])(
    "keeps %s group bounds stable when shared identity arrives",
    async (role) => {
      await withBrowserPage(openBrowserPage(1200, 800), async (page) => {
        await page.setContent(`<style>${readUiCss()}</style>
          <div class="chat-thread chat-thread--direct" style="width:760px;height:300px">
            <div class="chat-group ${role}">
              <div class="chat-group-messages"><div class="chat-bubble">Saved answer</div></div>
            </div>
          </div>`);
        const before = await getRect(page, ".chat-group");
        await page.locator(".chat-thread").evaluate((thread) => {
          thread.classList.remove("chat-thread--direct");
        });
        const shared = await getRect(page, ".chat-group");
        expect(shared.left).toBeCloseTo(before.left, 1);
        expect(shared.right).toBeCloseTo(before.right, 1);
        await page.setViewportSize({ width: 390, height: 844 });
        const mobile = await getRect(page, ".chat-group");
        await page.locator(".chat-thread").evaluate((thread) => {
          thread.classList.add("chat-thread--direct");
        });
        const mobileDirect = await getRect(page, ".chat-group");
        expect(mobileDirect.left).toBeCloseTo(mobile.left, 1);
        expect(mobileDirect.right).toBeCloseTo(mobile.right, 1);
      });
    },
  );

  it("does not rebuild the footer layout tree while autosizing the editor", async () => {
    await withBrowserPage(openBrowserPage(1200, 800), async (page) => {
      // Keep the grid/flex chain: a directly sized conversation cannot reproduce
      // the intermediate height-query changes during flex measurement.
      await page.setContent(`<style>${readUiCss()}</style>
        <section class="chat">${nest(
          "chat-workbench > chat-workbench__main > chat-split-container > chat-main > chat-main__conversation-column",
          conversation(
            `<div class="chat-thread">${"<p>Earlier message</p>".repeat(20)}</div>${nest(
              "chat-footer > agent-chat__composer-shell > agent-chat__input agent-chat__input--chat > agent-chat__composer-combobox",
              "<textarea></textarea>",
            )}`,
          ),
        )}</section>`);
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
      const fadeContent = () => style(page, ".chat-footer", "content", "::before");
      const editorCap = () => style(page, "textarea", "max-height").then(Number.parseFloat);
      expect(await fadeContent()).toBe("none");
      const tallEditorCap = await editorCap();
      await page.setViewportSize({ width: 1200, height: 260 });
      const shortConversation = await getRect(page, ".chat-main__conversation");
      const thread = await getRect(page, ".chat-thread");
      const footer = await getRect(page, ".chat-footer");
      expect(shortConversation.height).toBe(260);
      expect(await fadeContent()).toBe("none");
      expect(await editorCap()).toBeLessThan(tallEditorCap);
      expect(thread.height).toBeGreaterThan(0);
      expect(thread.bottom).toBeLessThanOrEqual(footer.top);
      expect(footer.bottom).toBeLessThanOrEqual(shortConversation.bottom);
    });
  });

  it.each([390, 1200])(
    "keeps the editor inset when a %spx-wide pane crosses the short-pane height",
    async (width) => {
      // A phone keyboard leaves a conversation pane of roughly 300-340px; the
      // draft must not jump against the composer frame as that pane crosses 320px.
      // The keyboard shrinks the app shell, not the layout viewport, so device
      // media queries stay those of the full screen.
      await withBrowserPage(openBrowserPage(width, 844), async (page) => {
        await page.setContent(`<style>${readUiCss()}</style>
          <section class="chat" style="height:340px">${nest(
            "chat-workbench > chat-workbench__main > chat-split-container > chat-main > chat-main__conversation-column",
            conversation(
              `<div class="chat-thread">${"<p>Earlier message</p>".repeat(20)}</div>${nest(
                "chat-footer > agent-chat__composer-shell > agent-chat__input agent-chat__input--chat agent-chat__input--mobile-toolbar",
                `${nest(
                  "agent-chat__composer-input-row > agent-chat__composer-combobox",
                  '<textarea placeholder="Message"></textarea>',
                )}<div class="agent-chat__composer-footer"><button>Send</button></div>`,
              )}`,
            ),
          )}</section>`);
        const editor = async () => {
          await waitForLayoutSettled(page, ".chat-main__conversation, .chat-footer");
          return page.locator("textarea").evaluate((textarea) => {
            const box = textarea.getBoundingClientRect();
            const computed = getComputedStyle(textarea);
            const paddingTop = Number.parseFloat(computed.paddingTop);
            const paddingBottom = Number.parseFloat(computed.paddingBottom);
            const surface = textarea.closest(".agent-chat__input")!.getBoundingClientRect();
            return {
              pane: textarea.closest(".chat-main__conversation")!.getBoundingClientRect().height,
              textInset: box.top + paddingTop - surface.top,
              paddingBottom,
              lineRoom: textarea.clientHeight - paddingTop - paddingBottom,
              line: Number.parseFloat(computed.lineHeight),
              cap: Number.parseFloat(computed.maxHeight),
            };
          });
        };
        const tall = await editor();
        expect(tall.pane).toBe(340);
        await page.locator(".chat").evaluate((chat) => {
          chat.style.height = "300px";
        });
        const short = await editor();
        expect(short.pane).toBe(300);
        expect(short.textInset).toBe(tall.textInset);
        expect(short.paddingBottom).toBe(tall.paddingBottom);
        expect(short.lineRoom).toBeGreaterThanOrEqual(short.line);
        // The short pane still caps the editor at one complete line.
        expect(short.cap).toBeLessThan(tall.cap);
        expect(short.cap).toBe(short.line + 2 * short.paddingBottom);
      });
    },
  );

  it("aligns and separates mobile cards above the composer after Chat styles load", async () => {
    await withBrowserPage(openBrowserPage(390, 844), async (page) => {
      // New Session can load composer styles before Chat's lazy layout stylesheet.
      await page.setContent(`<style>${readUiCss()}${readStyleSheet("ui/src/styles/chat/layout.css")}</style>
        <section class="chat">${conversation(
          composerFooter(
            "Composer",
            `<div class="chat-footer__context">
                <div class="chat-prs"><article class="chat-pr">Pull request</article></div>
                <div class="session-suggestions">Suggestion</div>
                <div class="chat-inline-approval">Approval context</div>
                <openclaw-plugin-contributions><button data-plugin-action>Plugin action</button></openclaw-plugin-contributions>
              </div>`,
          ),
        )}</section>`);
      const composer = await getRect(page, ".agent-chat__input");
      for (const selector of [".chat-prs", ".session-suggestions", ".chat-inline-approval"]) {
        const card = await getRect(page, selector);
        expect(card.left, selector).toBeCloseTo(composer.left, 0);
        expect(card.right, selector).toBeCloseTo(composer.right, 0);
      }
      for (const selector of [
        ".session-suggestions",
        ".chat-inline-approval",
        "[data-plugin-action]",
      ]) {
        const pullRequest = await getRect(page, ".chat-pr");
        const neighbor = await getRect(page, selector);
        expect(neighbor.top, selector).toBeGreaterThan(pullRequest.bottom);
        await page.locator(selector).evaluate((element) => element.remove());
      }
    });
  });

  it("reserves the mobile activity strip before its metadata arrives", async () => {
    await withBrowserPage(openBrowserPage(390, 844), async (page) => {
      await page.setContent(`<style>${readUiCss()}${readStyleSheet("ui/src/styles/chat/composer-mobile.css")}${readStyleSheet("ui/src/pages/chat/components/chat-activity-pills.css")}</style>
        <div class="agent-chat__composer-shell" data-mobile-composer="true" style="position:relative;margin-top:200px">
          <div class="agent-chat__composer-float"><div class="chat-footer__context"></div></div>
          <div class="agent-chat__input">Composer</div>
        </div>`);
      const before = await getRect(page, ".agent-chat__composer-float");
      await page.locator(".agent-chat__composer-float").evaluate((element) => {
        element.insertAdjacentHTML(
          "beforeend",
          '<div class="chat-activity-pills"><div class="chat-activity-pills__row"><button class="activity-pill">18 working</button><button class="activity-pill">Task progress</button></div></div>',
        );
      });
      const after = await getRect(page, ".agent-chat__composer-float");
      expect(after.height).toBeGreaterThan(0);
      expect(after).toEqual(before);
    });
  });

  it("paints message footer focus outlines past virtual row boundaries", async () => {
    await withBrowserPage(openBrowserPage(600, 300), async (page) => {
      await page.setContent(
        `<!doctype html><html><head><style>${readUiCss()}</style></head><body>
          <div class="chat-thread" style="width: 500px; height: 200px; --accent: rgb(255, 0, 0);">
            ${nest(
              "chat-thread-inner chat-thread-inner--virtual > chat-virtual-sizer > chat-virtual-block",
              `<div class="chat-virtual-row" data-focused-row>${nest(
                "chat-group assistant chat-group--with-footer",
                `${nest("chat-group-messages > chat-bubble", "Message")}${nest(
                  "chat-group-footer > chat-group-footer__meta",
                  '<button class="msg-meta__summary" type="button"><span class="chat-group-timestamp" style="width:18px">6m ago</span></button>',
                )}`,
              )}</div><div class="chat-virtual-row" style="height:40px"><div>Next message</div></div>`,
            )}
          </div>
        </body></html>`,
      );
      const summary = page.locator(".msg-meta__summary");
      await summary.focus();
      await page
        .locator(".chat-group-footer")
        .evaluate((node) => node.getAnimations().forEach((animation) => animation.finish()));
      const bounds = await page.evaluate(() => {
        const row = document.querySelector<HTMLElement>("[data-focused-row]")!;
        const control = document.querySelector<HTMLElement>(".msg-meta__summary")!;
        // Keep the clipping boundary at the control, independent of turn spacing.
        // Otherwise extra room below the footer makes the below-row pixel oracle vacuous.
        row.style.height = `${control.getBoundingClientRect().bottom - row.getBoundingClientRect().top}px`;
        const rowRect = row.getBoundingClientRect();
        const controlRect = control.getBoundingClientRect();
        return {
          controlBottom: controlRect.bottom,
          clip: {
            x: Math.floor(controlRect.left - 8),
            y: Math.floor(controlRect.top - 8),
            width: Math.ceil(controlRect.width + 16),
            height: Math.ceil(controlRect.height + 16),
          },
          rowBottom: rowRect.bottom,
          deviceScaleFactor: window.devicePixelRatio,
        };
      });
      expect(bounds.controlBottom).toBeCloseTo(bounds.rowBottom, 3);
      const png = await page.screenshot({ clip: bounds.clip });
      const widestAccentRunBelowRow = await page.evaluate(
        async ({ pngBase64, clipTop, rowBottom, deviceScaleFactor }) => {
          const image = new Image();
          image.src = `data:image/png;base64,${pngBase64}`;
          await image.decode();
          const canvas = document.createElement("canvas");
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0);
          const pixels = context.getImageData(0, 0, image.width, image.height).data;
          let widestRun = 0;
          for (
            let y = Math.ceil((rowBottom - clipTop) * deviceScaleFactor);
            y < image.height;
            y++
          ) {
            let currentRun = 0;
            for (let x = 0; x < image.width; x += 1) {
              const offset = (y * image.width + x) * 4;
              currentRun =
                pixels[offset]! > 240 && pixels[offset + 1]! < 20 && pixels[offset + 2]! < 20
                  ? currentRun + 1
                  : 0;
              widestRun = Math.max(widestRun, currentRun);
            }
          }
          return widestRun;
        },
        {
          pngBase64: png.toString("base64"),
          clipTop: bounds.clip.y,
          rowBottom: bounds.rowBottom,
          deviceScaleFactor: bounds.deviceScaleFactor,
        },
      );

      // A clipped ring leaves only a vertical edge (the outline's device-pixel
      // width). A wider run proves the rounded bottom edge was painted too.
      expect(widestAccentRunBelowRow).toBeGreaterThan(bounds.deviceScaleFactor * 2);
    });
  });

  it.each([
    [1200, 800, "desktop", "overlay", false],
    [900, 500, "mobile-landscape-900", "inline", false],
    [640, 900, "mobile-responsive-640", "overlay", false],
    [320, 568, "mobile-320", "overlay", false],
    [1200, 800, "desktop-with-pull-request", "overlay", true],
    [375, 812, "mobile-with-pull-request", "overlay", true],
  ] as const)(
    "reserves footer notice space and keeps menus actionable at %sx%s (%s)",
    async (width, height, label, menuPlacement, withPullRequest) => {
      await withBrowserPage(openBrowserPage(width, height), async (page) => {
        const footerContext = nest(
          "chat-footer__context",
          `
          ${withPullRequest ? '<div class="chat-prs"><article class="chat-pr" data-state="open"><a class="chat-pr__link" href="https://github.com/example/repo/pull/42">PR #42</a></article></div>' : ""}
          <openclaw-plugin-contributions></openclaw-plugin-contributions>
          <div class="agent-chat__composer-notices"></div>`,
        );
        const chat = nest(
          "chat-main > chat-main__conversation-column",
          `<div class="chat-topbar-notices"></div>${conversation(`
            <div class="chat-thread" role="log">${nest("chat-thread-inner", "Transcript")}</div>
            ${nest("chat-gutter-stack > task-suggestions", "Task suggestion")}
            ${composerFooter("Composer", footerContext)}`)}`,
        );
        await page.setContent(`<!doctype html><html><head><style>${readUiCss()}</style></head>
          <body style="margin:0;height:100vh;overflow:hidden">
            <div class="shell shell--chat ${label.startsWith("mobile") ? "shell--mobile-nav shell--merged-chat-chrome" : ""}">
              <main class="content content--chat" style="padding:0"><div class="sidebar-region">
                ${nest("sidebar-region__header", '<header class="chat-pane__header">Session</header>')}
                <div class="sidebar-region__primary" data-region="main"><section class="chat">${chat}</section></div>
              </div></main>
              <openclaw-toast-host data-toast-placement="shell">${nest("app-toast", "Connection notice")}</openclaw-toast-host>
            </div>
          </body></html>`);
        await waitForLayoutSettled(page, ".chat-main__conversation, .agent-chat__composer-shell");

        const geometry = async () =>
          await page.evaluate(() => {
            const element = (selector: string) => document.querySelector<HTMLElement>(selector)!;
            const rect = (selector: string) => {
              const box = element(selector).getBoundingClientRect();
              return { bottom: box.bottom, top: box.top, height: box.height, width: box.width };
            };
            const fade = getComputedStyle(element(".chat-footer"), "::before");
            return {
              composer: rect(".agent-chat__composer-shell"),
              conversation: rect(".chat-main__conversation"),
              footer: rect(".chat-footer"),
              input: rect(".agent-chat__input"),
              fadeContent: fade.content,
              thread: rect(".chat-thread"),
            };
          });
        expect(await page.locator(".chat-topbar-notices").isVisible()).toBe(false);
        expect(await page.locator(".agent-chat__composer-notices").isVisible()).toBe(false);
        expect(await page.locator(".chat-footer__context").isVisible()).toBe(withPullRequest);
        const before = await geometry();
        await page.locator(".chat-footer__context").evaluate((node) => {
          const notices = node.querySelector(".agent-chat__composer-notices")!;
          const content = document.createElement("span");
          content.className = "chat-composer-lit-content";
          content.style.display = "contents";
          content.append(...Array.from(node.children).filter((child) => child !== notices));
          node.prepend(content);
          content.insertAdjacentHTML(
            "beforeend",
            '<openclaw-chat-outbox-recovery style="display:contents"></openclaw-chat-outbox-recovery>',
          );
          notices.innerHTML =
            '<span class="chat-composer-lit-content" style="display:contents"></span>';
        });
        await waitForLayoutSettled(page, ".chat-main__conversation, .agent-chat__composer-shell");
        expect(await page.locator(".agent-chat__composer-notices").isVisible()).toBe(false);
        expect(await page.locator(".chat-footer__context").isVisible()).toBe(withPullRequest);
        expect(await geometry()).toEqual(before);
        expect(before.fadeContent).toBe("none");
        expect(before.thread.bottom).toBeLessThanOrEqual(before.footer.top);
        await setHtml(
          page,
          ".chat-topbar-notices",
          '<div class="chat-composer-neighbor-card chat-cloud-disk-space-notice">Disk space low</div>',
        );
        await setHtml(
          page,
          ".agent-chat__composer-notices",
          '<span class="chat-composer-lit-content" style="display:contents"><div class="chat-composer-neighbor-card chat-error">Model unavailable</div></span>',
        );
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
        const position = (selector: string) => style(page, selector, "position");
        expect(await position(".chat-topbar-notices")).toBe("absolute");
        const header = await getBoundingBox(page, ".chat-pane__header");
        for (const selector of [".chat-topbar-notices", ".chat-gutter-stack", ".app-toast"]) {
          const top = (await getBoundingBox(page, selector)).y;
          if (label.startsWith("mobile") || selector === ".app-toast") {
            expect(top, selector).toBeGreaterThanOrEqual(header.y + header.height);
          } else if (selector === ".chat-topbar-notices") {
            expect(top).toBeCloseTo(header.y + header.height + 8, 0);
          }
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
        expect(await position(".slash-menu")).toBe(
          menuPlacement === "inline" ? "sticky" : "absolute",
        );
        let optionPoint = center(optionBounds);
        if (menuPlacement === "inline") {
          // Short landscape keeps the menu inside the input; notices remain above it.
          const inputBounds = await getBoundingBox(page, ".agent-chat__input");
          expect(rectsOverlap(optionBounds, noticeBounds)).toBe(false);
          expect(noticeBounds.y + noticeBounds.height).toBeLessThanOrEqual(optionBounds.y);
          expect(optionBounds.y).toBeGreaterThanOrEqual(inputBounds.y);
          expect(optionBounds.y + optionBounds.height).toBeLessThanOrEqual(
            inputBounds.y + inputBounds.height,
          );
        } else if (rectsOverlap(optionBounds, noticeBounds)) {
          optionPoint = overlapCenter(optionBounds, noticeBounds);
        }
        expect(await hitTest(page, ".slash-menu-item", optionPoint)).toBe(true);
        await page.mouse.click(optionPoint.x, optionPoint.y);
        expect(await option.getAttribute("data-selected")).toBe("true");
        await page.locator(".slash-menu").evaluate((node) => node.remove());
        const noticePoint = center(noticeBounds);
        expect(await hitTest(page, ".chat-error", noticePoint)).toBe(true);
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
