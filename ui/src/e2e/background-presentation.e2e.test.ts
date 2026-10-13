import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { configResponse } from "./appearance-prefs.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Background presentation and live preview" });
suite.define(() => {
  it.each(["light", "dark"] as const)(
    "renders both %s treatments without gutters or transparent writing surfaces",
    async (mode) => {
      await suite.withPage(
        { viewport: { width: 1440, height: 1000 }, colorScheme: mode },
        async ({ page }) => {
          const encodedImage = await page.evaluate((colorMode) => {
            const canvas = document.createElement("canvas");
            canvas.width = 960;
            canvas.height = 540;
            const context = canvas.getContext("2d")!;
            context.fillStyle = colorMode === "dark" ? "#ffffff" : "#000000";
            context.fillRect(0, 0, 960, 540);
            return canvas.toDataURL("image/jpeg").split(",")[1]!;
          }, mode);
          const bytes = Buffer.from(encodedImage, "base64");
          let preference = {
            source: { kind: "custom" as const, assetId: "presentation-demo" },
            showOnNewSession: true,
            showInSessions: true,
            visibility: 1,
            presentation: "faded" as "faded" | "full-bleed",
          };
          const asset = {
            assetId: "presentation-demo",
            width: 960,
            height: 540,
            byteLength: bytes.length,
            mime: "image/jpeg",
          };
          const gateway = await installMockGateway(page, {
            assistantName: "Assistant",
            agentModel: "demo/example",
            models: [{ id: "example", provider: "demo", name: "Example model" }],
            presenceUsers: [{ id: "background-demo", name: "Background demo", self: true }],
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "users.prefs.get",
              "users.prefs.set",
              "users.background.get",
            ],
            historyMessages: [
              {
                role: "user",
                content: [{ type: "text", text: "Keep the writing surface solid." }],
              },
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: Array.from(
                      { length: 18 },
                      (_, index) =>
                        `A clear response on the chosen backdrop. Paragraph ${index + 1} keeps the transcript long enough to exercise scrolling.`,
                    ).join("\n\n"),
                  },
                ],
              },
            ],
            methodResponses: {
              "config.get": configResponse({ themeMode: mode }, "presentation"),
              "users.prefs.get": {
                status: "ok",
                entries: { "ui.theme": "claw", "ui.themeMode": mode, "ui.background": preference },
              },
              "users.prefs.set": { status: "ok" },
              "users.background.get": { status: "ok", asset, preference },
            },
          });
          await page.route("**/__openclaw__/users/background/*", (route) =>
            route.fulfill({ status: 200, contentType: "image/jpeg", body: bytes }),
          );
          const sync = async () => {
            await gateway.setMethodResponse("users.prefs.get", {
              status: "ok",
              entries: { "ui.theme": "claw", "ui.themeMode": mode, "ui.background": preference },
            });
            await gateway.setMethodResponse("users.background.get", {
              status: "ok",
              asset,
              preference,
            });
          };
          const newPageGeometry = async () => {
            await page
              .locator(".new-session-page openclaw-session-background img")
              .waitFor({ state: "visible" });
            return await page.evaluate(() => {
              const background = document.querySelector<HTMLElement>(
                ".new-session-page openclaw-session-background",
              )!;
              const canvas = document.querySelector<HTMLElement>(".content--new-session")!;
              const composer = document.querySelector<HTMLElement>(
                ".new-session-page .agent-chat__input",
              )!;
              const b = background.getBoundingClientRect(),
                c = canvas.getBoundingClientRect(),
                input = composer.getBoundingClientRect();
              return {
                left: b.left,
                right: b.right,
                canvasLeft: c.left,
                canvasRight: c.right,
                fade:
                  Number.parseFloat(
                    background.style.getPropertyValue("--session-background-fade-end"),
                  ) + b.top,
                composerMiddle: input.top + input.height / 2,
                composerLeft: input.left,
                composerRight: input.right,
                mask: getComputedStyle(background.querySelector("img")!).maskImage,
                opacity: Number(getComputedStyle(background.querySelector("img")!).opacity),
                underpaint: getComputedStyle(background).backgroundColor,
                composerBackground: getComputedStyle(composer).backgroundColor,
                width: innerWidth,
                bodyWidth: document.body.scrollWidth,
              };
            });
          };
          await page.goto(suite.server.baseUrl + "new");
          await expect.poll(async () => (await newPageGeometry()).fade).toBeGreaterThan(0);
          for (const viewport of [
            { width: 1440, height: 1000 },
            { width: 390, height: 844 },
          ]) {
            await page.setViewportSize(viewport);
            await expect
              .poll(async () => {
                const g = await newPageGeometry();
                return Math.abs(g.fade - g.composerMiddle);
              })
              .toBeLessThan(2);
            const g = await newPageGeometry();
            expect(Math.abs(g.left - g.canvasLeft)).toBeLessThan(1);
            expect(Math.abs(g.right - g.canvasRight)).toBeLessThan(1);
            expect(g.mask).not.toBe("none");
            expect(g.composerBackground).toMatch(/^rgb\(/);
            if (viewport.width === 390) {
              expect(g.composerLeft - g.canvasLeft).toBeCloseTo(20, 0);
              expect(g.canvasRight - g.composerRight).toBeCloseTo(20, 0);
            }
            expect(g.bodyWidth).toBeLessThanOrEqual(g.width);
          }
          await page.setViewportSize({ width: 1440, height: 1000 });
          const editor = page.locator(".new-session-page .agent-chat__input textarea");
          await editor.fill("One\nTwo\nThree\nFour\nFive\nSix");
          await expect
            .poll(async () => {
              const g = await newPageGeometry();
              return Math.abs(g.fade - g.composerMiddle);
            })
            .toBeLessThan(2);
          await editor.fill("");
          await page.goto(suite.server.baseUrl + "settings/appearance");
          const section = page.locator("#settings-appearance-background");
          await section.scrollIntoViewIfNeeded();
          const writes = (await gateway.getRequests("users.prefs.set")).length;
          await section.locator('[data-test-id="background-presentation-full-bleed"]').click();
          const change = await gateway.waitForRequest("users.prefs.set", { after: writes });
          expect(change.params).toEqual({
            entries: { "ui.background": { ...preference, presentation: "full-bleed" } },
            expectedEntries: { "ui.background": preference },
          });
          preference = { ...preference, presentation: "full-bleed" };
          await sync();
          const slider = section.getByRole("slider", { name: "Image visibility" });
          await slider.focus();
          await slider.press("ArrowLeft");
          const peek = page.locator("openclaw-appearance-background[data-background-preview]");
          await peek.waitFor();
          await page.locator("[data-background-preview-canvas] img").waitFor({ state: "visible" });
          const preview = await page.locator("[data-background-preview-canvas]").boundingBox();
          const canvasBounds = await page.locator(".content").boundingBox();
          expect(preview).not.toBeNull();
          expect(canvasBounds).not.toBeNull();
          expect(Math.abs(preview!.x - canvasBounds!.x)).toBeLessThan(1);
          expect(Math.abs(preview!.y - canvasBounds!.y)).toBeLessThan(1);
          expect(await slider.evaluate((element) => element === document.activeElement)).toBe(true);
          await slider.press("Escape");
          await expect.poll(() => peek.count()).toBe(0);
          preference = { ...preference, visibility: 0.95 };
          await sync();
          await page.goto(suite.server.baseUrl + "new");
          const full = await newPageGeometry();
          expect(full.mask).toBe("none");
          expect(full.opacity).toBeGreaterThan(0);
          expect(full.opacity).toBeLessThanOrEqual(0.32);
          expect(full.underpaint).toMatch(/^rgb\(/);
          for (const presentation of ["faded", "full-bleed"] as const) {
            preference = { ...preference, presentation };
            await sync();
            await page.goto(suite.server.baseUrl + "chat");
            await page
              .locator(".sidebar-region__background openclaw-session-background img")
              .waitFor({ state: "visible" });
            await page.getByText("Keep the writing surface solid.", { exact: true }).waitFor();
            const surfaces = await page.evaluate(() => {
              const bg = document
                .querySelector(".sidebar-region__background")!
                .getBoundingClientRect();
              const header = document
                .querySelector(".sidebar-region__header")!
                .getBoundingClientRect();
              return {
                headerFadeBottom: getComputedStyle(
                  document.querySelector(".sidebar-region__header")!,
                  "::before",
                ).bottom,
                transcriptFade: getComputedStyle(
                  document.querySelector(".chat-main__conversation")!,
                  "::before",
                ).content,
                backgroundTop: bg.top,
                headerTop: header.top,
                bubble: getComputedStyle(document.querySelector(".chat-group.user .chat-bubble")!)
                  .backgroundColor,
                composer: getComputedStyle(document.querySelector(".chat .agent-chat__input")!)
                  .backgroundColor,
                header: getComputedStyle(document.querySelector(".chat-pane__header")!)
                  .backgroundColor,
                fade: getComputedStyle(
                  document.querySelector(".sidebar-region__header")!,
                  "::before",
                ).backgroundImage,
              };
            });
            expect(Math.abs(surfaces.backgroundTop - surfaces.headerTop)).toBeLessThan(1);
            expect(surfaces.bubble).toMatch(/^rgb\(/);
            expect(surfaces.composer).toMatch(/^rgb\(/);
            expect(surfaces.header).toBe("rgba(0, 0, 0, 0)");
            expect(surfaces.fade).toContain("linear-gradient");
            expect(surfaces.headerFadeBottom).toBe("0px");
            expect(surfaces.transcriptFade).toBe("none");
            for (const edge of ["top", "bottom"] as const) {
              await page.locator(".chat-thread").evaluate((thread, position) => {
                thread.scrollTop = position === "top" ? 0 : thread.scrollHeight;
              }, edge);
              expect(
                await page
                  .locator(".chat-main__conversation")
                  .evaluate((element) => getComputedStyle(element, "::before").content),
              ).toBe("none");
            }
            const contrast = await page.evaluate((colorMode) => {
              const image = document.querySelector<HTMLImageElement>(
                ".sidebar-region__background img",
              )!;
              const opacity = Number(getComputedStyle(image).opacity);
              const probe = document.createElement("span");
              image.parentElement!.append(probe);
              probe.style.backgroundColor = "var(--bg-content, var(--bg))";
              const canvas = document.createElement("canvas");
              canvas.width = canvas.height = 1;
              const pixels = canvas.getContext("2d")!;
              type RGB = readonly [red: number, green: number, blue: number];
              const color = (css: string): readonly [number, number, number, number] => {
                pixels.clearRect(0, 0, 1, 1);
                pixels.fillStyle = css;
                pixels.fillRect(0, 0, 1, 1);
                const [red, green, blue, alpha] = pixels.getImageData(0, 0, 1, 1).data;
                if (
                  red === undefined ||
                  green === undefined ||
                  blue === undefined ||
                  alpha === undefined
                ) {
                  throw new Error("The contrast probe did not return a complete RGBA pixel");
                }
                return [red, green, blue, alpha];
              };
              const surface = color(getComputedStyle(probe).backgroundColor);
              const extreme = colorMode === "dark" ? 255 : 0;
              const blendSurface = (channel: 0 | 1 | 2) =>
                surface[channel] * (1 - opacity) + extreme * opacity;
              const background: RGB = [blendSurface(0), blendSurface(1), blendSurface(2)];
              const luma = (rgb: RGB) => {
                const linear = (value: number) => {
                  const n = value / 255;
                  return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
                };
                return linear(rgb[0]) * 0.2126 + linear(rgb[1]) * 0.7152 + linear(rgb[2]) * 0.0722;
              };
              const ratios = ["--text", "--text-strong", "--muted", "--chat-text"].map((token) => {
                probe.style.color = "var(" + token + ")";
                const foreground = color(getComputedStyle(probe).color);
                const alpha = foreground[3] / 255;
                const blendText = (channel: 0 | 1 | 2) =>
                  foreground[channel] * alpha + background[channel] * (1 - alpha);
                const text: RGB = [blendText(0), blendText(1), blendText(2)];
                return (
                  (Math.max(luma(text), luma(background)) + 0.05) /
                  (Math.min(luma(text), luma(background)) + 0.05)
                );
              });
              probe.remove();
              return Math.min(...ratios);
            }, mode);
            expect(contrast).toBeGreaterThanOrEqual(4.5);
          }
          preference = { ...preference, showInSessions: false };
          await sync();
          await page.goto(suite.server.baseUrl + "chat");
          await page.getByText("Keep the writing surface solid.", { exact: true }).waitFor();
          expect(await page.locator(".sidebar-region__background img").count()).toBe(0);
          expect(
            await page
              .locator(".chat-main__conversation")
              .evaluate((element) => getComputedStyle(element, "::before").content),
          ).toBe('""');
        },
      );
    },
  );
});
