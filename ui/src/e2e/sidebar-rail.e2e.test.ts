import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import type { MockGatewayWindow } from "../test-helpers/control-ui-e2e-contract.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  defaultControlUiFeatureMethods,
  controlUiBundledSettingsStorageKey,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Personal rail pins" });
const unloaded = [
  { key: "agent:research:plan", kind: "direct" as const, label: "Research plan", icon: "🔬" },
  { key: "agent:main:notes", kind: "direct" as const, label: "Release notes" },
];
const entries = [
  "session:agent:main:current",
  "session:agent:main:design",
  ...unloaded.map((row) => `session:${row.key}`),
];

suite.define(() => {
  it("opens a touch-held pin without navigating or collapsing, while taps still navigate", async () => {
    await suite.withPage(
      { hasTouch: true, viewport: { width: 1280, height: 800 } },
      async ({ page }) => {
        await installMockGateway(page, {
          sessionKey: "agent:main:current",
          sessions: [
            { key: "agent:main:current", kind: "direct", label: "Current work" },
            { key: "agent:main:design", kind: "direct", label: "Design ideas" },
          ],
        });
        await page.addInitScript(
          ({ key }) =>
            localStorage.setItem(
              key,
              JSON.stringify({ sidebarEntries: ["session:agent:main:design"] }),
            ),
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
        );
        await page.goto(suite.server.baseUrl + "chat");
        const pin = page
          .locator(".sidebar-rail")
          .getByRole("link", { name: "Design ideas", exact: true });
        await pin.waitFor();
        const initialUrl = page.url();
        const menu = page.locator(".sidebar-rail-pin-menu");
        const box = await pin.boundingBox();
        if (!box) {
          throw new Error("Missing touch pin bounds");
        }
        const touch = {
          pointerId: 1,
          pointerType: "touch",
          isPrimary: true,
          clientX: box.x + box.width / 2,
          clientY: box.y + box.height / 2,
        };
        await page.clock.install();
        await pin.dispatchEvent("pointerdown", touch);
        await page.clock.fastForward(500);
        await menu.getByRole("menuitem", { name: "Unpin", exact: true }).waitFor();
        await pin.dispatchEvent("pointerup", touch);
        // PointerEvent dispatch does not synthesize the compatibility click.
        await pin.dispatchEvent("click", { ...touch, detail: 1 });
        expect(page.url()).toBe(initialUrl);
        expect(await page.locator(".shell--nav-collapsed").count()).toBe(0);
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "hidden" });

        for (const cancelled of [
          "move",
          "pointerup",
          "pointercancel",
          "dragstart",
          "secondary",
        ] as const) {
          await pin.dispatchEvent("pointerdown", {
            ...touch,
            isPrimary: cancelled !== "secondary",
          });
          if (cancelled === "move") {
            await pin.dispatchEvent("pointermove", { ...touch, clientX: touch.clientX + 9 });
          } else if (cancelled !== "secondary") {
            await pin.dispatchEvent(cancelled, touch);
          }
          await page.clock.fastForward(600);
          expect(await menu.count(), cancelled).toBe(0);
          await pin.dispatchEvent("pointerup", touch);
          if (cancelled === "dragstart") {
            await pin.dispatchEvent("dragend");
          }
        }
        expect(page.url()).toBe(initialUrl);
        await pin.tap();
        await expect.poll(() => page.url()).toContain("design");
        await page.locator(".shell--nav-collapsed").waitFor();
        expect(await menu.count()).toBe(0);
      },
    );
  });

  it("resolves unloaded pins, drags their links, and offers keyboard and pointer menus", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 800 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: "agent:main:current",
        sessions: [
          { key: "agent:main:current", kind: "direct", label: "Current work", icon: "🚀" },
          { key: "agent:main:design", kind: "direct", label: "Design ideas" },
        ],
        featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get", "users.prefs.set"],
        presenceUsers: [{ id: "alex", name: "Alex", self: true }],
        methodResponses: {
          "config.get": {
            config: { ui: { prefs: { sidebarEntries: entries, themeMode: "dark" } } },
            hash: "rail-fixture",
          },
          "users.prefs.get": {
            status: "ok",
            entries: { "ui.sidebarEntries": entries, "ui.themeMode": "dark" },
          },
          "users.prefs.set": { status: "ok" },
          "sessions.describe": {
            cases: unloaded.map((row) => ({ match: { key: row.key }, response: { session: row } })),
          },
        },
      });
      await page.addInitScript(
        ({ key, entries: savedEntries }) =>
          localStorage.setItem(
            key,
            JSON.stringify({ sidebarEntries: savedEntries, themeMode: "dark" }),
          ),
        { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), entries },
      );
      await page.goto(suite.server.baseUrl + "chat");
      await page.locator(".agent-chat__composer-combobox textarea").waitFor();
      const rail = page.locator("openclaw-app-sidebar .sidebar-rail");
      const pins = rail.locator(".sidebar-rail__pin");
      const pinOrder = () =>
        pins.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-sidebar-entry")));
      await expect.poll(pinOrder).toEqual(entries);
      for (const row of unloaded) {
        const link = rail.getByRole("link", { name: row.label, exact: true });
        await link.waitFor();
        if (row.icon) {
          expect(await link.locator(".session-glyph__emoji").textContent()).toBe(row.icon);
        } else {
          expect(await link.locator(".sidebar-rail__monogram").textContent()).toBe("RN");
        }
        expect(await gateway.getRequests("sessions.describe", { key: row.key })).toHaveLength(1);
      }
      expect(await pins.locator(".sidebar-reorder-trigger").count()).toBe(0);
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const dir = createControlUiE2eArtifactDir("rail", process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR);
        const frame = await takeControlUiScreenshotFrame(
          page,
          page.locator(".shell"),
          [rail, pins.first()],
          { animations: "disabled" },
        );
        await writeFile(path.join(dir, "after-desktop.png"), frame.png);
        await page.setViewportSize({ width: 390, height: 844 });
        await page
          .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
          .first()
          .click();
        await page.locator(".shell--nav-drawer-open").waitFor();
        const mobile = await takeControlUiScreenshotFrame(page, page.locator(".shell"), [rail], {
          animations: "disabled",
        });
        await writeFile(path.join(dir, "after-mobile.png"), mobile.png);
        await page.setViewportSize({ width: 1280, height: 800 });
      }
      const source = rail.getByRole("link", { name: "Research plan", exact: true });
      const target = rail.getByRole("link", { name: "Current work", exact: true });
      const box = await target.boundingBox();
      if (!box) {
        throw new Error("Missing target pin bounds");
      }
      // Playwright drives native mouse drag/drop, beginning on the anchor itself.
      await source.dragTo(target, { targetPosition: { x: box.width / 2, y: 2 } });
      const reordered = [entries[2]!, entries[0]!, entries[1]!, ...entries.slice(3)];
      await expect.poll(pinOrder).toEqual(reordered);

      const menu = page.locator(".sidebar-rail-pin-menu");
      for (const key of ["Shift+F10", "ContextMenu"]) {
        await source.focus();
        await page.keyboard.press(key);
        await menu.getByRole("menuitem", { name: "Move down", exact: true }).waitFor();
        await expect
          .poll(() =>
            menu
              .getByRole("menuitem", { name: "Move down", exact: true })
              .evaluate((el) => el.matches(":focus-within")),
          )
          .toBe(true);
        await page.keyboard.press("Escape");
        await expect.poll(() => source.evaluate((el) => el === document.activeElement)).toBe(true);
      }
      await source.click({ button: "right" });
      await menu.getByRole("menuitem", { name: "Move down", exact: true }).click();
      await expect.poll(pinOrder).toEqual([entries[0], entries[2], entries[1], entries[3]]);
      await source.click({ button: "right" });
      await menu.getByRole("menuitem", { name: "Unpin", exact: true }).click();
      await expect.poll(pinOrder).toEqual(entries.filter((entry) => entry !== entries[2]));
      expect(await gateway.getRequests("sessions.patch")).toEqual([]);
    });
  });

  it("starts clean and adds distinct session glyphs through native drags", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
      async ({ page }) => {
        const rows = [
          {
            key: "agent:main:launch",
            kind: "direct" as const,
            label: "Launch planning",
            icon: "🚀",
          },
          { key: "agent:main:design", kind: "direct" as const, label: "Design review" },
        ];
        const gateway = await installMockGateway(page, {
          assistantName: "Atlas",
          heldMethods: ["connect"],
          sessions: rows,
          presenceUsers: [{ id: "alex", name: "Alex", self: true }],
          featureMethods: [...defaultControlUiFeatureMethods, "users.prefs.get", "users.prefs.set"],
        });
        await page.goto(suite.server.baseUrl + "chat");
        await gateway.waitForRequest("connect");
        const installProfilePreferences = () =>
          page.evaluate(() => {
            const mock = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
            const storageKey = "openclaw-test:clean-rail:profile-prefs";
            const saved = sessionStorage.getItem(storageKey);
            const values: Record<string, unknown> = saved
              ? JSON.parse(saved)
              : { "ui.themeMode": "dark" };
            mock.setRequestHandler("users.prefs.get", ({ respond }) =>
              respond({ status: "ok", entries: values }),
            );
            mock.setRequestHandler("users.prefs.set", ({ params, respond }) => {
              const request = params as {
                entries: Record<string, unknown>;
                expectedEntries?: Record<string, unknown>;
              };
              if (
                Object.entries(request.expectedEntries ?? {}).some(
                  ([key, value]) => JSON.stringify(values[key] ?? null) !== JSON.stringify(value),
                )
              ) {
                respond({ status: "conflict" });
                return;
              }
              Object.assign(values, request.entries);
              sessionStorage.setItem(storageKey, JSON.stringify(values));
              respond({ status: "ok" });
            });
          });
        await installProfilePreferences();
        await gateway.resolveDeferred("connect");
        const sidebar = page.locator("openclaw-app-sidebar");
        const rail = sidebar.locator(".sidebar-rail__pins");
        const source = sidebar.locator(`[data-session-key="${rows[0]!.key}"]`).first();
        await source.waitFor();
        expect(await rail.locator(".sidebar-rail__pin").count()).toBe(0);
        expect(await rail.getAttribute("class")).not.toContain("--drag-active");
        expect(await gateway.getRequests("sessions.list", { pinned: true })).toEqual([]);
        expect(await gateway.getRequests("users.prefs.set")).toEqual([]);
        const dir =
          process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
            ? createControlUiE2eArtifactDir("clean-rail", process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR)
            : null;
        const capture = async (name: string) => {
          if (!dir) {
            return;
          }
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".shell"),
            [rail, source],
            { animations: "disabled" },
          );
          await writeFile(path.join(dir, name), frame.png);
        };
        await capture("rail-empty.png");
        const sourceBox = await source.boundingBox();
        const railBox = await rail.boundingBox();
        if (!sourceBox || !railBox) {
          throw new Error("Missing drag source or empty rail bounds");
        }
        expect(railBox.height).toBeGreaterThan(200);
        await page.mouse.move(
          sourceBox.x + sourceBox.width / 2,
          sourceBox.y + sourceBox.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(
          sourceBox.x + sourceBox.width / 2 + 12,
          sourceBox.y + sourceBox.height / 2,
          { steps: 3 },
        );
        await page.mouse.move(railBox.x + railBox.width / 2, railBox.y + 80, { steps: 12 });
        await expect.poll(() => rail.getAttribute("class")).toContain("--drag-active");
        await capture("rail-drag-over.png");
        await page.mouse.up();
        const first = rail.getByRole("link", { name: rows[0]!.label, exact: true });
        await first.waitFor();
        expect(await first.locator(".session-glyph__emoji").textContent()).toBe("🚀");
        const secondSource = sidebar.locator(`[data-session-key="${rows[1]!.key}"]`).first();
        await secondSource.dragTo(rail, { targetPosition: { x: railBox.width / 2, y: 120 } });
        const second = rail.getByRole("link", { name: rows[1]!.label, exact: true });
        await second.waitFor();
        expect(await second.locator(".sidebar-rail__monogram").textContent()).toBe("DR");
        expect(await rail.getAttribute("class")).not.toContain("--drag-active");
        await expect
          .poll(() =>
            rail
              .locator(".sidebar-rail__pin")
              .evaluateAll((pins) => pins.map((pin) => pin.getAttribute("data-sidebar-entry"))),
          )
          .toEqual(rows.map((row) => `session:${row.key}`));
        await capture("rail-two-added.png");
        await expect
          .poll(async () => (await gateway.getRequests("users.prefs.set")).length)
          .toBeGreaterThan(0);
        await page.reload();
        await gateway.waitForRequest("connect");
        await installProfilePreferences();
        await gateway.resolveDeferred("connect");
        await first.waitFor();
        await second.waitFor();
      },
    );
  });
});
