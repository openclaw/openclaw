import { expect, it } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
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
          const gray = mode === "dark" ? 255 : 0;
          const bytes = createSolidPngBuffer(960, 540, { r: gray, g: gray, b: gray });
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
            mime: "image/png",
          };
          const textMessage = (role: "user" | "assistant", text: string) => ({
            role,
            content: [{ type: "text", text }],
          });
          const responses = () => ({
            "users.prefs.get": {
              status: "ok",
              entries: { "ui.theme": "claw", "ui.themeMode": mode, "ui.background": preference },
            },
            "users.background.get": { status: "ok", asset, preference },
          });
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
              textMessage("user", "Keep the writing surface solid."),
              textMessage(
                "assistant",
                Array.from({ length: 18 }, () =>
                  "A clear response on the chosen backdrop. ".repeat(4),
                ).join("\n\n"),
              ),
            ],
            methodResponses: {
              "config.get": configResponse({ themeMode: mode }, "presentation"),
              "users.prefs.set": { status: "ok" },
              ...responses(),
            },
          });
          await page.route("**/__openclaw__/users/background/*", (route) =>
            route.fulfill({ status: 200, contentType: "image/png", body: bytes }),
          );
          const sync = async () => {
            for (const [method, response] of Object.entries(responses())) {
              await gateway.setMethodResponse(method, response);
            }
          };
          const newPageGeometry = async () => {
            await page
              .locator(".new-session-page openclaw-session-background img")
              .waitFor({ state: "visible" });
            return await page.evaluate(() => {
              const element = (selector: string) => document.querySelector<HTMLElement>(selector)!;
              const background = element(".new-session-page openclaw-session-background");
              const canvas = element(".content--new-session");
              const composer = element(".new-session-page .agent-chat__input");
              const imageStyle = getComputedStyle(background.querySelector("img")!);
              const b = background.getBoundingClientRect(),
                c = canvas.getBoundingClientRect(),
                input = composer.getBoundingClientRect();
              const fade =
                Number.parseFloat(
                  background.style.getPropertyValue("--session-background-fade-end"),
                ) + b.top;
              return {
                edgeError: Math.max(Math.abs(b.left - c.left), Math.abs(b.right - c.right)),
                fade,
                fadeError: Math.abs(fade - (input.top + input.height / 2)),
                composerInsets: [input.left - c.left, c.right - input.right],
                mask: imageStyle.maskImage,
                opacity: Number(imageStyle.opacity),
                underpaint: getComputedStyle(background).backgroundColor,
                composerBackground: getComputedStyle(composer).backgroundColor,
                overflow: document.body.scrollWidth - innerWidth,
              };
            });
          };
          const expectAlignedFade = () =>
            expect.poll(async () => (await newPageGeometry()).fadeError).toBeLessThan(2);
          const transcriptFade = () =>
            page
              .locator(".chat-main__conversation")
              .evaluate((element) => getComputedStyle(element, "::before").content);
          await page.goto(suite.server.baseUrl + "new");
          await expect.poll(async () => (await newPageGeometry()).fade).toBeGreaterThan(0);
          for (const viewport of [
            { width: 1440, height: 1000 },
            { width: 390, height: 844 },
          ]) {
            await page.setViewportSize(viewport);
            await expectAlignedFade();
            const g = await newPageGeometry();
            expect(g.edgeError).toBeLessThan(1);
            expect(g.mask).not.toBe("none");
            expect(g.composerBackground).toMatch(/^rgb\(/);
            if (viewport.width === 390) {
              for (const inset of g.composerInsets) {
                expect(inset).toBeCloseTo(20, 0);
              }
            }
            expect(g.overflow).toBeLessThanOrEqual(0);
          }
          await page.setViewportSize({ width: 1440, height: 1000 });
          const editor = page.locator(".new-session-page .agent-chat__input textarea");
          await editor.fill("One\nTwo\nThree\nFour\nFive\nSix");
          await expectAlignedFade();
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
            const surfaces = await page.evaluate((colorMode) => {
              const element = (selector: string) => document.querySelector(selector)!;
              const style = (selector: string, pseudo?: string) =>
                getComputedStyle(element(selector), pseudo);
              const header = ".sidebar-region__header";
              const headerFade = style(header, "::before");
              const styleFacts = {
                headerFadeBottom: headerFade.bottom,
                transcriptFade: style(".chat-main__conversation", "::before").content,
                backgroundTop: element(".sidebar-region__background").getBoundingClientRect().top,
                headerTop: element(header).getBoundingClientRect().top,
                bubble: style(".chat-group.user .chat-bubble").backgroundColor,
                composer: style(".chat .agent-chat__input").backgroundColor,
                header: style(".chat-pane__header").backgroundColor,
                fade: headerFade.backgroundImage,
              };
              const image = element(".sidebar-region__background img");
              const opacity = Number(getComputedStyle(image).opacity);
              const probe = document.createElement("span");
              image.parentElement!.append(probe);
              probe.style.backgroundColor = "var(--bg-content, var(--bg))";
              const canvas = document.createElement("canvas");
              canvas.width = canvas.height = 1;
              const pixels = canvas.getContext("2d")!;
              type RGB = readonly [red: number, green: number, blue: number];
              type RGBA = readonly [...RGB, alpha: number];
              const blend = (front: RGB | RGBA, back: RGB | RGBA, alpha: number): RGB => {
                const channel = (i: 0 | 1 | 2) => front[i] * alpha + back[i] * (1 - alpha);
                return [channel(0), channel(1), channel(2)];
              };
              const color = (css: string): RGBA => {
                pixels.clearRect(0, 0, 1, 1);
                pixels.fillStyle = css;
                pixels.fillRect(0, 0, 1, 1);
                const [red, green, blue, alpha] = pixels.getImageData(0, 0, 1, 1).data;
                // A native 1×1 ImageData contains exactly one complete RGBA pixel.
                return [red!, green!, blue!, alpha!];
              };
              const surface = color(getComputedStyle(probe).backgroundColor);
              const extreme = colorMode === "dark" ? 255 : 0;
              const background = blend([extreme, extreme, extreme], surface, opacity);
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
                const text = blend(foreground, background, foreground[3] / 255);
                return (
                  (Math.max(luma(text), luma(background)) + 0.05) /
                  (Math.min(luma(text), luma(background)) + 0.05)
                );
              });
              probe.remove();
              return { ...styleFacts, contrast: Math.min(...ratios) };
            }, mode);
            expect(Math.abs(surfaces.backgroundTop - surfaces.headerTop)).toBeLessThan(1);
            expect(surfaces.bubble).toMatch(/^rgb\(/);
            expect(surfaces.composer).toMatch(/^rgb\(/);
            expect(surfaces).toMatchObject({
              header: "rgba(0, 0, 0, 0)",
              headerFadeBottom: "0px",
              transcriptFade: "none",
            });
            expect(surfaces.fade).toContain("linear-gradient");
            expect(surfaces.contrast).toBeGreaterThanOrEqual(4.5);
            for (const edge of ["top", "bottom"] as const) {
              await page.locator(".chat-thread").evaluate((thread, position) => {
                thread.scrollTop = position === "top" ? 0 : thread.scrollHeight;
              }, edge);
              expect(await transcriptFade()).toBe("none");
            }
          }
          preference = { ...preference, showInSessions: false };
          await sync();
          await page.goto(suite.server.baseUrl + "chat");
          await page.getByText("Keep the writing surface solid.", { exact: true }).waitFor();
          expect(await page.locator(".sidebar-region__background img").count()).toBe(0);
          expect(await transcriptFade()).toBe('""');
        },
      );
    },
  );
});
