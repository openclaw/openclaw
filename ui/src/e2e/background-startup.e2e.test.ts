import { expect, it } from "vitest";
import { selectBackgroundSource } from "../../../packages/gateway-protocol/src/schema/background-preferences.ts";
import type { SessionBackground } from "../components/session-background.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { configResponse } from "./appearance-prefs.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Personal background first-paint readiness" });

suite.define(() => {
  it.each(["none", "custom"] as const)(
    "keeps an old custom mirror hidden until the saved %s choice loads",
    async (choice) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const custom = selectBackgroundSource({
          kind: "custom",
          assetId: "previous-private-image",
        });
        const profileId = "stale-background-viewer";
        const gateway = await installMockGateway(page, {
          presenceUsers: [{ id: profileId, name: "Background demo", self: true }],
          deferredMethods: ["users.prefs.get"],
          methodResponses: { "config.get": configResponse({}, "stale-background") },
        });
        const reads: string[] = [];
        await page.route("**/__openclaw__/users/background/*", async (route) => {
          reads.push(route.request().url());
          await route.fulfill({ status: 404 });
        });
        await page.goto(suite.server.baseUrl + "new");
        await gateway.waitForRequest("users.prefs.get");
        await gateway.resolveDeferred("users.prefs.get", {
          status: "ok",
          entries: { "ui.background": custom },
        });
        await expect.poll(() => reads.length).toBe(1);
        reads.length = 0;
        await page.reload();
        await gateway.waitForRequest("users.prefs.get");
        const background = page.locator("openclaw-session-background").first();
        await expect
          .poll(() =>
            background.evaluate(
              (element) =>
                (element as SessionBackground).context?.theme.settings.background?.source.kind,
            ),
          )
          .toBe("custom");
        await background.evaluate(async (element) => {
          await (element as SessionBackground).updateComplete;
        });
        expect(await background.getAttribute("data-custom")).toBeNull();
        expect(reads).toEqual([]);
        const saved = choice === "none" ? selectBackgroundSource({ kind: "none" }) : custom;
        await gateway.resolveDeferred("users.prefs.get", {
          status: "ok",
          entries: { "ui.background": saved },
        });
        if (choice === "none") {
          await expect
            .poll(() =>
              background.evaluate(
                (element) =>
                  (element as SessionBackground).context?.theme.settings.background?.source.kind,
              ),
            )
            .toBe("none");
          expect(await background.getAttribute("data-custom")).toBeNull();
          expect(reads).toEqual([]);
        } else {
          // Identical preference values still publish readiness and release the private read.
          await expect.poll(() => reads.length).toBe(1);
          expect(await background.getAttribute("data-custom")).not.toBeNull();
        }
      });
    },
  );

  it.each(["none", "absent"] as const)(
    "waits for the saved %s choice before any initial shell image request",
    async (choice) => {
      await suite.withPage(
        { colorScheme: "dark", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          const entries =
            choice === "none" ? { "ui.background": selectBackgroundSource({ kind: "none" }) } : {};
          const gateway = await installMockGateway(page, {
            presenceUsers: [
              { id: "background-startup-viewer", name: "Background startup", self: true },
            ],
            featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get"],
            deferredMethods: ["users.prefs.get"],
            methodResponses: {
              "config.get": configResponse({ themeMode: "dark" }, "background-startup"),
              "users.prefs.get": { status: "ok", entries },
            },
          });
          const imageRequests: string[] = [];
          page.on("request", (request) => {
            const pathname = new URL(request.url()).pathname;
            if (
              pathname.includes("/__openclaw__/users/background/") ||
              /(?:claw|knot|dash|absolutely|tide|beacon|phosphor|crt|manuscript|rose|miami|custom)-(?:dark|light).*\.webp$/u.test(
                pathname,
              )
            ) {
              imageRequests.push(request.url());
            }
          });
          // Both a cold document and a reload of the newly saved profile mirror must
          // preserve the startup ordering. Never seed synthetic root attributes.
          for (const reload of [false, true]) {
            imageRequests.length = 0;
            if (reload) {
              await page.reload();
            } else {
              await page.goto(suite.server.baseUrl + "new");
            }
            await gateway.waitForRequest("users.prefs.get");
            const shell = page.locator(".shell");
            await shell.waitFor({ state: "visible" });
            const shellImage = () =>
              shell.evaluate((element) => getComputedStyle(element).backgroundImage);
            expect(await shellImage()).toBe("none");
            expect(imageRequests).toEqual([]);
            await gateway.resolveDeferred("users.prefs.get", { status: "ok", entries });
            if (choice === "none") {
              await expect
                .poll(() =>
                  page
                    .locator("openclaw-session-background")
                    .first()
                    .evaluate(
                      (element) =>
                        (element as SessionBackground).context?.theme.settings.background?.source
                          .kind,
                    ),
                )
                .toBe("none");
              expect(await shellImage()).toBe("none");
              expect(await page.locator(".session-background__image").count()).toBe(0);
              expect(imageRequests).toEqual([]);
            } else {
              await expect.poll(shellImage).toMatch(/^url\(/u);
              // A no-change empty profile still completes readiness and reveals the
              // existing palette artwork; it is not treated as indefinitely pending.
              expect(await shell.getAttribute("data-background-managed")).toBeNull();
            }
          }
        },
      );
    },
  );
});
