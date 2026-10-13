import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { selectAllSidebarSessions } from "./sidebar-navigation.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Sidebar rail alignment" });

suite.define(() => {
  it.each([false, true])(
    "centers rail controls and the owner toolbar (touch: %s)",
    async (hasTouch) => {
      await suite.withPage(
        { hasTouch, viewport: { width: 1280, height: 800 } },
        async ({ page }) => {
          const sessions = [
            {
              key: "agent:main:current",
              kind: "direct",
              label: "Sidebar alignment review",
              updatedAt: Date.now(),
            },
            {
              key: "agent:main:notes",
              kind: "direct",
              label: "Release notes",
              updatedAt: Date.now(),
            },
          ];
          await installMockGateway(page, {
            sessionKey: "agent:main:current",
            presenceUsers: [{ id: "riley", name: "Riley", self: true }],
            sessions,
            methodResponses: {
              "sessions.list": {
                ts: 1,
                path: "",
                count: sessions.length,
                defaults: { model: null, modelProvider: null, contextTokens: null },
                owners: [
                  { type: "human", id: "riley", label: "Riley" },
                  { type: "human", id: "devon", label: "Devon" },
                ],
                sessions,
              },
            },
          });
          await page.emulateMedia({ colorScheme: "dark" });
          await page.goto(suite.server.baseUrl + "chat");
          const rail = page.locator("openclaw-app-sidebar .sidebar-rail");
          const owner = page.locator(".sidebar-session-owner-filter .picker-select__trigger");
          await owner.waitFor();
          await selectAllSidebarSessions(page);
          await page
            .locator(".sidebar-recent-session__name")
            .filter({ hasText: "Release notes" })
            .waitFor();
          await rail.locator(".sidebar-issues-button").waitFor();
          const geometry = await rail.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const center =
              (rect.left +
                Number.parseFloat(style.borderLeftWidth) +
                rect.right -
                Number.parseFloat(style.borderRightWidth)) /
              2;
            return [
              ...element.querySelectorAll<HTMLElement>(
                ".sidebar-agent-card__main, .sidebar-new-session, [data-navigation-view], .sidebar-brand__search, .sidebar-footer-bar__home, .sidebar-issues-button, .sidebar-identity-card",
              ),
            ].map((control) => {
              const box = control.getBoundingClientRect();
              return { control: control.className, offset: box.x + box.width / 2 - center };
            });
          });
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            const dir = createControlUiE2eArtifactDir(
              hasTouch ? "rail-alignment-touch" : "rail-alignment-desktop",
            );
            const capture = async (name: string) => {
              const frame = await takeControlUiScreenshotFrame(
                page,
                page.locator(".shell"),
                [rail, owner],
                {
                  animations: "disabled",
                  elements: [page.locator("openclaw-app-sidebar .sidebar")],
                },
              );
              await writeFile(path.join(dir, name + ".png"), frame.elements[0]!.png);
            };
            // Reproduce the two changed declarations, retaining identical app/data/viewport.
            const baseline = await page.addStyleTag({
              content:
                ".sidebar-rail { align-items: stretch; } .shell:not(.shell--mobile-nav) .sidebar-rail { padding-top: 8px; }",
            });
            try {
              await capture("before");
            } finally {
              await baseline.evaluate((element) => element.parentNode?.removeChild(element));
            }
            await capture("after");
            await writeFile(path.join(dir, "geometry.json"), JSON.stringify(geometry, null, 2));
          }
          for (const measured of geometry) {
            expect(Math.abs(measured.offset), measured.control).toBeLessThanOrEqual(0.5);
          }
          const agentBox = await rail.locator(".sidebar-agent-card__main").boundingBox();
          const ownerBox = await owner.boundingBox();
          expect(agentBox).not.toBeNull();
          expect(ownerBox).not.toBeNull();
          expect(
            Math.abs(agentBox!.y + agentBox!.height / 2 - ownerBox!.y - ownerBox!.height / 2),
          ).toBeLessThanOrEqual(0.5);
        },
      );
    },
  );
});
