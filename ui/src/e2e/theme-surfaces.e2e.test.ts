import type { Page } from "playwright";
import { expect, it } from "vitest";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import { openChatPanels } from "../test-helpers/chat-layout-menu.ts";
import { resolveRenderedColors, type RenderedColor } from "../test-helpers/rendered-colors.ts";
import { configResponse } from "./appearance-prefs.test-support.ts";
import { twoFrames } from "./chat-presentation.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { createThemedChatOpener } from "./theme-typography.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat theme surfaces", trackBrowserContexts: true });
const openThemedChat = createThemedChatOpener(suite);
const mediaUrl = "media://inbound/theme-surface.png";
const userText = "Help me organize a focused afternoon.";
const assistantText = "Start with the open questions, then review the next steps.";

function luminance({ red, green, blue }: RenderedColor): number {
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
}

async function inspectSurfaces(page: Page) {
  await page.locator(".shell").evaluate(finishElementAnimations);
  await twoFrames(page);
  return page.evaluate(() => {
    const root = document.documentElement;
    const composer = document.querySelector<HTMLElement>(".agent-chat__input")!;
    const bubble = document.querySelector<HTMLElement>(".chat-group.user .chat-bubble")!;
    const conversation = document.querySelector<HTMLElement>(".chat-main__conversation")!;
    const host = conversation.closest<HTMLElement>(".sidebar-region")!;
    const probe = document.createElement("div");
    root.append(probe);
    const composerStyle = getComputedStyle(composer);
    const bubbleStyle = getComputedStyle(bubble);
    const hostStyle = getComputedStyle(host);
    const fade = getComputedStyle(conversation, "::before");
    const dimensions = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    };
    probe.style.backgroundImage =
      "linear-gradient(var(--chat-composer-surface), var(--chat-composer-surface)), none";
    const expectedComposer = getComputedStyle(probe).backgroundImage;
    probe.remove();
    return {
      themeSheets: [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
        .filter((link) => link.href.includes("/themes/"))
        .map((link) => ({ href: new URL(link.href).pathname, loaded: Boolean(link.sheet) })),
      composer: composerStyle.backgroundImage,
      bubble: bubbleStyle.backgroundColor,
      expectedComposer,
      bubbleText: getComputedStyle(bubble.querySelector(".chat-text")!).color,
      host: hostStyle.backgroundColor,
      mobileHost: host.classList.contains("sidebar-region--mobile-host"),
      fade: { display: fade.display, background: fade.backgroundImage },
      dimensions: {
        composer: dimensions(composer),
        bubble: dimensions(bubble),
        host: dimensions(host),
      },
    };
  });
}

suite.define(() => {
  it.each(["light", "dark"] as const)(
    "shows the shared theme canvas through both desktop headers in %s mode",
    async (mode) => {
      const { page } = await openThemedChat("absolutely", mode, {
        historyMessages: [{ role: "assistant", content: assistantText }],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText(assistantText, { exact: true }).waitFor();
      await openChatPanels(page, "desktop");
      await page.locator(".chat-pane__header").waitFor();
      await page.locator(".side-panel__header").waitFor();
      for (const occupied of [false, true]) {
        if (occupied) {
          await page.locator(".side-panel-launcher__card").filter({ hasText: "Files" }).click();
          await page.locator(".side-panel__header--occupied").waitFor();
        }
        const headers = page.locator(".chat-pane__header, .side-panel__header");
        expect(
          await headers.evaluateAll((elements) =>
            elements.map((element) => getComputedStyle(element).backgroundColor),
          ),
        ).toEqual(["rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0)"]);
        const covered = await headers.evaluateAll((elements) => {
          const painted: string[] = [];
          for (const header of elements) {
            for (
              let element: Element | null = header;
              element && !element.matches(".shell");
              element = element.parentElement
            ) {
              if (getComputedStyle(element).backgroundColor !== "rgba(0, 0, 0, 0)") {
                painted.push(element.className);
              }
            }
          }
          return painted;
        });
        expect(covered, "Both headers must expose the same uninterrupted shell canvas").toEqual([]);
      }
    },
  );

  it.each([
    ["claw", "light"],
    ["claw", "dark"],
    ["absolutely", "light"],
    ["absolutely", "dark"],
  ] as const)(
    "keeps composer overrides separate from participant bubbles in %s %s without changing geometry",
    async (theme, mode) => {
      const { page, gateway } = await openThemedChat(theme, mode, {
        historyMessages: [
          { role: "user", content: userText },
          {
            role: "user",
            content: "",
            __openclaw: {
              id: "surface-image",
              seq: 2,
              media: [
                {
                  url: mediaUrl,
                  kind: "image",
                  contentType: "image/png",
                  fileName: "Surface example",
                  width: 160,
                  height: 80,
                },
              ],
              mediaImageLayout: { slots: [{ kind: "inline", factIndex: 0 }] },
            },
          },
          { role: "assistant", content: assistantText },
        ],
      });
      const imageData = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 160;
        canvas.height = 80;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#819496";
        context.fillRect(0, 0, 160, 80);
        context.fillStyle = "#d6dbce";
        context.fillRect(20, 20, 120, 40);
        return canvas.toDataURL("image/png").split(",")[1]!;
      });
      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        if (new URL(route.request().url()).searchParams.get("meta") === "1") {
          await route.fulfill({
            json: {
              available: true,
              mediaTicket: "surface-image",
              mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
            },
          });
        } else {
          await route.fulfill({ contentType: "image/png", body: Buffer.from(imageData, "base64") });
        }
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText(assistantText, { exact: true }).waitFor();
      const resolved = theme === "claw" ? mode : `${theme}${mode === "light" ? "-light" : ""}`;
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe(resolved);
      await page
        .locator(".agent-chat__input textarea")
        .fill("Keep this draft while the theme changes.");
      for (const accent of [undefined, "#5577cc"]) {
        await gateway.setMethodResponse(
          "config.get",
          configResponse(
            { theme, themeMode: mode, accent },
            `${theme}-${mode}-${accent ?? "default"}`,
          ),
        );
        await gateway.emitGatewayEvent("config.changed", {});
        if (accent) {
          await expect
            .poll(() =>
              page.evaluate(() =>
                getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
              ),
            )
            .toBe(accent);
        }
        for (const width of [900, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await page.locator(".sidebar-region--mobile-host").waitFor();
          await page.evaluate(() => document.fonts.ready);
          const original = await inspectSurfaces(page);
          expect(original.composer).toBe(original.expectedComposer);
          const colors = await page.evaluate(resolveRenderedColors, {
            bubble: original.bubble,
            text: original.bubbleText,
          });
          const fill = colors.bubble!;
          const text = colors.text!;
          expect(fill.alpha).toBe(1);
          const composite = (front: number, back: number) =>
            front * text.alpha + back * (1 - text.alpha);
          const ink = luminance({
            ...text,
            alpha: 1,
            red: composite(text.red, fill.red),
            green: composite(text.green, fill.green),
            blue: composite(text.blue, fill.blue),
          });
          const background = luminance(fill);
          expect(
            (Math.max(ink, background) + 0.05) / (Math.min(ink, background) + 0.05),
          ).toBeGreaterThanOrEqual(4.5);
          if (theme === "absolutely") {
            expect(original.themeSheets).toContainEqual({
              href: expect.stringContaining("/themes/absolutely.css"),
              loaded: true,
            });
          }
          expect(original.mobileHost).toBe(true);
          expect(original.fade.display).toBe(width === 390 ? "none" : "block");
          if (width > 768) {
            expect
              .soft(
                original.fade.background,
                "the visible fade starts on the host's painted surface",
              )
              .toContain(`${original.host} 2px`);
          }

          // Composer surface overrides must not replace the participant palette.
          const surface = mode === "light" ? "rgb(228, 223, 213)" : "rgb(52, 48, 42)";
          const fixture = await page.addStyleTag({
            content: `:root[data-theme] { --chat-composer-surface: ${surface}; }`,
          });
          const inherited = await inspectSurfaces(page);
          expect
            .soft(inherited.composer, "composer inherits the theme surface")
            .toBe(`linear-gradient(${surface}, ${surface}), none`);
          expect
            .soft(inherited.bubble, "composer overrides retain participant colors")
            .toBe(original.bubble);
          expect(inherited.dimensions).toEqual(original.dimensions);
          const media = page.locator(".chat-group.user .chat-bubble--with-images");
          await media.getByRole("img", { name: "Surface example" }).waitFor();
          expect(
            await media.evaluate((element) => ({
              background: getComputedStyle(element).backgroundColor,
              image: getComputedStyle(element).backgroundImage,
              border: getComputedStyle(element).borderWidth,
              shadow: getComputedStyle(element).boxShadow,
            })),
          ).toEqual({
            background: "rgba(0, 0, 0, 0)",
            image: "none",
            border: "0px",
            shadow: "none",
          });
          await fixture.evaluate((element) => element.parentNode?.removeChild(element));
        }
      }
      expect(await page.locator(".agent-chat__input textarea").inputValue()).toBe(
        "Keep this draft while the theme changes.",
      );
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    },
  );
});
