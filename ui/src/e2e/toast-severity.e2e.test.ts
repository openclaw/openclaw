import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { configResponse } from "./appearance-prefs.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  activateSelfRemovingControl,
  createSessionManagementE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  openSessionMenuSubmenu,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const stage = process.env.OPENCLAW_TOAST_PROOF_STAGE ?? "after";
const appearances = capture
  ? ([
      { theme: "claw", mode: "light" },
      { theme: "claw", mode: "dark" },
      { theme: "crt", mode: "dark" },
    ] as const)
  : ([{ theme: "claw", mode: "dark" }] as const);
const widths = capture ? [1440, 390] : [1440];

suite.define(() => {
  it("distinguishes failed and successful copies through the session menu", async () => {
    const artifacts = capture ? createControlUiE2eArtifactDir("toast-severity") : undefined;
    const outcomes: Array<{ failed: boolean; error: boolean }> = [];
    for (const { theme, mode } of appearances) {
      for (const width of widths) {
        const context = await suite.browser.newContext({
          ...createControlUiE2eContextOptions(),
          viewport: { width: 1440, height: 900 },
          colorScheme: mode,
        });
        await context.grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: new URL(suite.server.baseUrl).origin,
        });
        const page = await context.newPage();
        const activeKey = "agent:main:toast-current";
        const otherKey = "agent:main:toast-copy";
        await installMockGateway(page, {
          agentModel: "example/demo-model",
          models: [{ id: "demo-model", name: "Demo model", provider: "example" }],
          featureMethods: ["chat.metadata", "chat.startup"],
          methodResponses: {
            "config.get": configResponse({ theme, themeMode: mode }, "toast-proof"),
            "sessions.list": sessionsListResponse([
              sessionRow(activeKey, "Project notes", Date.parse("2026-08-15T06:05:00Z")),
              sessionRow(otherKey, "Copy feedback example", Date.parse("2026-08-15T06:00:00Z"), {
                sessionId: "55555555-5555-5555-5555-555555555555",
              }),
            ]),
          },
          sessionKey: activeKey,
        });
        try {
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, activeKey), {
            waitUntil: "domcontentloaded",
          });
          const row = page.locator('.sidebar-recent-session[data-session-key="' + otherKey + '"]');
          await expect.poll(() => row.count()).toBe(1);
          for (const failed of [false, true]) {
            // Copy transport is the external boundary; the real menu and toast owner stay mounted.
            await page.evaluate((deny) => {
              Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: {
                  writeText: async () => {
                    if (deny) {
                      throw new Error("Clipboard denied");
                    }
                  },
                },
              });
              document.execCommand = () => !deny;
            }, failed);
            await row.click({ button: "right" });
            await openSessionMenuSubmenu(page, "Advanced");
            await openSessionMenuSubmenu(page, "Copy details");
            const copyItem = page.locator("openclaw-session-menu").getByRole("menuitem", {
              name: "Session ID",
              exact: true,
            });
            await activateSelfRemovingControl(copyItem);
            const toast = page.locator(".app-toast");
            await expect.poll(() => toast.count()).toBe(1);
            await expect
              .poll(() => toast.textContent())
              .toContain(failed ? "Couldn’t copy. Try again." : "Copied");
            await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
            await toast.locator("button").last().focus();
            await toast.hover();
            await page.locator("html").evaluate((root) => {
              for (const animation of root.getAnimations({ subtree: true })) {
                if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) {
                  animation.finish();
                }
              }
            });
            if (artifacts) {
              await page.screenshot({
                path: path.join(
                  artifacts,
                  `${stage}-${width}-${theme}-${mode}-${failed ? "error" : "success"}.png`,
                ),
              });
            }
            outcomes.push({
              failed,
              error: await toast.evaluate((el) => el.classList.contains("app-toast--error")),
            });
            await page.setViewportSize({ width: 1440, height: 900 });
          }
        } finally {
          await context.close();
        }
      }
    }
    for (const outcome of outcomes) {
      expect(outcome.error).toBe(outcome.failed);
    }
  });
});
