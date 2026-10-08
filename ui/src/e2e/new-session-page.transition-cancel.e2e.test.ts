import path from "node:path";
import type { WaSelectEvent } from "@awesome.me/webawesome/dist/events/select.js";
import type { ConsoleMessage } from "playwright";
import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("retires the session entrance animation when Settings takes over", async ({
    onTestFailed,
  }) => {
    const tracePrefix = "[settings-entrance-trace] ";
    const trace: string[] = [];
    const collectTrace = (message: ConsoleMessage) => {
      const text = message.text();
      if (trace.length < 64 && text.startsWith(tracePrefix)) {
        trace.push(text);
      }
    };
    // Retain breadcrumbs outside the page so a closed or stalled renderer cannot lose them.
    onTestFailed(() => console.error(trace.join("\n")));
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), reducedMotion: "no-preference" },
      async ({ page }) => {
        const gateway = await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}new`);
        await page.locator(".new-session-page__message").fill("leave this session entrance");
        await page.evaluate(() => {
          const outlet = document.querySelector("openclaw-router-outlet");
          if (!(outlet instanceof HTMLElement)) {
            throw new Error("Expected the application router outlet");
          }
          let resolve!: (animation: Animation) => void;
          const ready = new Promise<Animation>((next) => {
            resolve = next;
          });
          Reflect.set(globalThis, "__routeEntranceAnimation", ready);
          const animate = outlet.animate.bind(outlet);
          outlet.animate = (keyframes, options) => {
            const animation = animate(keyframes, options);
            // Hold the actual animation at a deterministic point in its 180 ms lifetime.
            animation.pause();
            animation.currentTime = 0;
            resolve(animation);
            return animation;
          };
        });
        await page.getByRole("button", { name: "Start session" }).click();
        await gateway.waitForRequest("sessions.create");
        expect(
          await page.evaluate(async () => {
            const animation = (await Reflect.get(
              globalThis,
              "__routeEntranceAnimation",
            )) as Animation;
            return animation.playState;
          }),
        ).toBe("paused");

        page.on("console", collectTrace);
        await page.evaluate((prefix) => {
          const app = document.querySelector<
            HTMLElement & { runtime: { context: ApplicationContext } }
          >("openclaw-app");
          const router = app?.runtime.context.router;
          const started = performance.now();
          let count = 0;
          const emit = (kind: string, data: unknown) => {
            if (count >= 64) {
              return;
            }
            count++;
            console.debug(
              prefix +
                JSON.stringify(
                  count === 64
                    ? { kind: "trace-limit", limit: 64 }
                    : { ms: Math.round(performance.now() - started), kind, data },
                ),
            );
          };
          const routeId = (value: string) =>
            ["new-session", "chat", "appearance"].includes(value) ? value : "other";
          const recordRoute = () => {
            const state = router?.getState();
            emit(
              "route",
              state
                ? {
                    status: state.status,
                    matches: state.matches.slice(0, 4).map((match) => routeId(match.routeId)),
                    pending: state.pendingMatches
                      .slice(0, 4)
                      .map((match) => routeId(match.routeId)),
                  }
                : null,
            );
          };
          const stop = router?.subscribe(recordRoute);
          window.addEventListener("pagehide", () => stop?.(), { once: true });
          recordRoute();
          const describe = (target: EventTarget) => {
            if (!(target instanceof Element)) {
              return target instanceof ShadowRoot ? "shadow-root" : "other";
            }
            return {
              tag: [
                "span",
                "button",
                "svg",
                "path",
                "wa-dropdown-item",
                "wa-dropdown",
                "wa-popup",
                "openclaw-app-sidebar",
              ].includes(target.localName)
                ? target.localName
                : "other-element",
              trigger: target.matches(".sidebar-identity-card"),
              menu: target.matches("wa-dropdown.sidebar-identity-menu"),
              settings: target.matches('wa-dropdown-item[value="command:settings"]'),
            };
          };
          for (const type of [
            "pointerdown",
            "pointerup",
            "click",
            "wa-select",
            "wa-show",
            "wa-after-show",
            "wa-hide",
            "wa-after-hide",
          ]) {
            document.addEventListener(
              type,
              (event) => {
                if (count >= 64) {
                  return;
                }
                const eventPath = event.composedPath();
                const dropdown =
                  eventPath.find(
                    (target): target is HTMLElement =>
                      target instanceof HTMLElement &&
                      target.matches("wa-dropdown.sidebar-identity-menu"),
                  ) ?? document.querySelector<HTMLElement>("wa-dropdown.sidebar-identity-menu");
                const popup = dropdown?.shadowRoot?.querySelector("wa-popup");
                const nativePopup = popup?.shadowRoot?.querySelector('[part~="popup"]');
                const selected =
                  type === "wa-select"
                    ? (event as WaSelectEvent).detail.item.getAttribute("value")
                    : null;
                emit(type, {
                  trusted: event.isTrusted,
                  path: eventPath.slice(0, 8).map(describe),
                  selected:
                    selected === "command:settings" ? selected : selected === null ? null : "other",
                  dropdown: dropdown
                    ? {
                        connected: dropdown.isConnected,
                        open: Reflect.get(dropdown, "open") === true,
                        nativeOpen: nativePopup?.matches(":popover-open") ?? null,
                      }
                    : null,
                });
              },
              { capture: true, passive: true },
            );
          }
        }, tracePrefix);
        const sidebar = page.locator("openclaw-app-sidebar");
        await sidebar.locator(".sidebar-identity-card").click();
        await sidebar
          .locator("wa-dropdown.sidebar-identity-menu")
          .getByRole("menuitem", { exact: true, name: "Settings" })
          .click();
        await page.waitForURL((url) => url.pathname === "/settings/appearance");
        await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.screenshot({
            path: path.join(suite.artifactDir, "settings-after-session.png"),
          });
        }
        expect(
          await page.evaluate(async () => {
            const animation = (await Reflect.get(
              globalThis,
              "__routeEntranceAnimation",
            )) as Animation;
            return animation.playState;
          }),
        ).toBe("idle");
      },
      async ({ page }) => {
        page.off("console", collectTrace);
      },
    );
  });
});
