import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { resolveRenderedColors, type RenderedColor } from "../test-helpers/rendered-colors.ts";
import { configResponse } from "./appearance-prefs.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Composer control ink" });
const families = [
  "claw",
  "knot",
  "dash",
  "absolutely",
  "tide",
  "beacon",
  "phosphor",
  "crt",
  "manuscript",
  "rose",
  "miami",
] as const;
const appearances = families.flatMap((theme) =>
  (["dark", "light"] as const).map((mode) => ({ theme, mode })),
);

function contrast(front: RenderedColor, back: RenderedColor) {
  const channel = (a: number, b: number) => a * front.alpha + b * (1 - front.alpha);
  const ink = {
    red: channel(front.red, back.red),
    green: channel(front.green, back.green),
    blue: channel(front.blue, back.blue),
  };
  const luminance = ({ red, green, blue }: Omit<RenderedColor, "alpha">) => {
    const linear = (value: number) => {
      const unit = value / 255;
      return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  };
  const a = luminance(ink);
  const b = luminance(back);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function inkContrast(composer: Locator, targets: Record<string, Locator>) {
  const raw: Record<string, string> = {
    surface: await composer.evaluate((element) => {
      // The action row sits on the composer surface token, not the host's box.
      const probe = document.createElement("span");
      probe.style.color = "var(--chat-composer-surface)";
      element.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    }),
  };
  for (const [name, target] of Object.entries(targets)) {
    raw[name] = await target.evaluate((element, text) => {
      // Labels are measured as text; icon buttons by the glyph they draw.
      const glyph = text || element instanceof SVGElement ? element : element.querySelector("svg");
      return getComputedStyle(glyph ?? element).color;
    }, name.startsWith("label"));
  }
  const colors = await composer.page().evaluate(resolveRenderedColors, raw);
  const surface = colors.surface!;
  expect(surface.alpha, "opaque composer surface").toBe(1);
  return Object.fromEntries(
    Object.keys(targets).map((name) => [name, contrast(colors[name]!, surface)]),
  );
}

suite.define(() => {
  it("keeps resting composer controls above their disabled step in every theme", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          agentModel: "example/demo-model",
          models: [{ id: "demo-model", name: "Demo model", provider: "example" }],
          historyMessages: [
            { role: "assistant", content: "The draft is ready for review.", timestamp: 1 },
          ],
          methodResponses: {
            "config.get": configResponse({ theme: "claw", themeMode: "dark" }, "claw-dark"),
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("sessions.messages.subscribe", {
          match: { key: "agent:main:main" },
        });
        for (const [index, { theme, mode }] of appearances.entries()) {
          const id = `${theme}-${mode}`;
          await page.emulateMedia({ colorScheme: mode });
          if (index > 0) {
            await gateway.setMethodResponse(
              "config.get",
              configResponse({ theme, themeMode: mode }, id),
            );
            await gateway.emitGatewayEvent("config.changed", {});
            await evaluateControlUiContext(page, (app) => app.navigate("chat"));
            await waitForControlUiRoute(page, { routeId: "chat" });
          }
          const resolved =
            theme === "claw"
              ? mode
              : `${theme === "knot" ? "openknot" : theme}${mode === "light" ? "-light" : ""}`;
          await expect
            .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
            .toBe(resolved);
          if (theme !== "claw") {
            await expect
              .poll(() =>
                page
                  .locator(`#openclaw-theme-palette-${theme}`)
                  .evaluate((link) => Boolean((link as HTMLLinkElement).sheet)),
              )
              .toBe(true);
          }
          await page.mouse.move(0, 0);
          const composer = page.locator(".chat-pane-cache__pane--active .agent-chat__input");
          const send = composer.locator(".chat-send-btn--send");
          await send.waitFor({ state: "visible" });
          expect(await send.isDisabled(), `${id}: empty draft disables Send`).toBe(true);
          const ink = await inkContrast(composer, {
            label: composer
              .locator(".chat-controls__model-settings .chat-controls__inline-select-trigger")
              .first(),
            labelEffort: composer.locator(".chat-controls__effort-trigger"),
            attach: composer.locator(".agent-chat__input-btn--attach"),
            permission: composer.locator(".chat-controls__permission-icon"),
            microphone: composer.getByRole("button", { name: "Start voice input", exact: true }),
            disabled: send,
          });
          // Labels are text; glyphs are non-text controls. Every resting control must
          // read clearly above the disabled Send beside it, in light and dark alike.
          for (const label of ["label", "labelEffort"] as const) {
            expect(ink[label], `${id}: ${label}`).toBeGreaterThanOrEqual(4.5);
          }
          for (const glyph of ["attach", "permission", "microphone"] as const) {
            expect(ink[glyph], `${id}: ${glyph} glyph`).toBeGreaterThanOrEqual(3);
            expect(
              ink[glyph]! - ink.disabled!,
              `${id}: ${glyph} above disabled`,
            ).toBeGreaterThanOrEqual(0.5);
          }
        }
      },
    );
  });
});
