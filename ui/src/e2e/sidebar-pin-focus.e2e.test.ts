import { expect, it } from "vitest";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  collapsedSessionSectionsStorageKey,
  createSessionManagementE2eSuite,
  installMockGateway,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const sessionKey = "agent:main:research";

suite.define(() => {
  it.each([1440, 390])(
    "keeps the session control focused after Pin and Unpin at %s px",
    async (width) => {
      const context = await suite.browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        sessions: [
          sessionRow("agent:main:main", "Main", 1_800_000_000_000),
          sessionRow(sessionKey, "Research notes", 1_800_000_000_000),
          sessionRow("agent:main:follow-up", "Follow-up work", 1_799_999_999_000),
        ],
      });
      try {
        await page.goto(`${suite.server.baseUrl}new`);
        if (width === 390) {
          await page
            .locator(
              ".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible, .shell-chrome-controls__nav-toggle:visible",
            )
            .first()
            .click();
        }
        const row = page.locator(`[data-session-key="${sessionKey}"]`);
        const trigger = row.locator("[data-session-menu]");
        await row.waitFor();
        for (const inline of [false, true]) {
          for (const pinned of [true, false]) {
            const control = inline ? row.locator("[data-sidebar-session-pin]") : trigger;
            await row.hover();
            if (inline) {
              await control.focus();
            } else {
              await trigger.click();
              await page
                .locator("openclaw-session-menu")
                .getByRole("menuitem", {
                  name: pinned ? "Pin session" : "Unpin session",
                  exact: true,
                })
                .focus();
            }
            const patches = (await gateway.getRequests("sessions.patch")).length;
            await page.keyboard.press("Enter");
            const patch = await gateway.waitForRequest("sessions.patch", { after: patches });
            expect(patch.params).toMatchObject({ key: sessionKey, pinned });
            await expect
              .poll(async () =>
                (await row.getAttribute("class"))?.includes("session-row-host--pinned"),
              )
              .toBe(pinned);
            await expect
              .poll(() => control.evaluate((element) => element === document.activeElement))
              .toBe(true);
            expect(await row.count()).toBe(1);
            expect(new URL(page.url()).pathname).toBe("/new");
            expect((await gateway.getRequests("sessions.patch")).length).toBe(patches + 1);
            await page.keyboard.press("Tab");
            expect(
              await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
            ).not.toBe("Resize sidebar");
          }
        }
      } finally {
        await context.close();
      }
    },
  );

  it("preserves newer focus during a delayed patch and keeps the trigger on failure", async () => {
    const context = await suite.browser.newContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessions: [sessionRow(sessionKey, "Research notes", 1_800_000_000_000)],
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const row = page.locator(`[data-session-key="${sessionKey}"]`);
      const trigger = row.locator("[data-session-menu]");
      for (const outcome of ["reject", "resolve"]) {
        await gateway.deferNext("sessions.patch");
        await row.hover();
        await trigger.click();
        await page.getByRole("menuitem", { name: "Pin session", exact: true }).focus();
        const patches = (await gateway.getRequests("sessions.patch")).length;
        await page.keyboard.press("Enter");
        await gateway.waitForRequest("sessions.patch", { after: patches });
        await expect
          .poll(() => trigger.evaluate((element) => element === document.activeElement))
          .toBe(true);
        if (outcome === "reject") {
          await gateway.rejectDeferred("sessions.patch", {
            code: "INVALID_REQUEST",
            message: "Pin denied",
          });
          await page.getByText("Pin denied", { exact: false }).first().waitFor();
          expect((await row.getAttribute("class"))?.includes("session-row-host--pinned")).toBe(
            false,
          );
          expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(
            true,
          );
        } else {
          const next = page.getByRole("button", { name: "Filter & sort", exact: true });
          await next.focus();
          await gateway.resolveDeferred("sessions.patch");
          await expect
            .poll(async () =>
              (await row.getAttribute("class"))?.includes("session-row-host--pinned"),
            )
            .toBe(true);
          expect(await next.evaluate((element) => element === document.activeElement)).toBe(true);
        }
      }
    } finally {
      await context.close();
    }
  });

  it("keeps a collapsed destination closed after Unpin", async () => {
    const context = await suite.browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(
      ({ collapsedKey, settingsKey }) => {
        localStorage.setItem(collapsedKey, JSON.stringify(["category:Research"]));
        localStorage.setItem(settingsKey, JSON.stringify({ sidebarAgentsMode: "chip" }));
      },
      {
        collapsedKey: collapsedSessionSectionsStorageKey,
        settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
      },
    );
    const gateway = await installMockGateway(page, {
      sessions: [
        sessionRow(sessionKey, "Research notes", 1_800_000_000_000, {
          pinned: true,
          category: "Research",
        }),
      ],
      sessionGroups: ["Research"],
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const row = page.locator(`[data-session-key="${sessionKey}"]`);
      await row.hover();
      await row.locator("[data-session-menu]").click();
      await page.getByRole("menuitem", { name: "Unpin session", exact: true }).focus();
      await page.keyboard.press("Enter");
      await gateway.waitForRequest("sessions.patch", {
        match: { key: sessionKey, pinned: false },
      });
      await row.waitFor({ state: "detached" });
      const toggle = page.locator(
        '[data-session-section="category:Research"] .sidebar-session-group-toggle',
      );
      expect(await toggle.getAttribute("aria-expanded")).toBe("false");
      await expect
        .poll(() => toggle.evaluate((element) => element === document.activeElement))
        .toBe(true);
      expect(
        await page.evaluate((key) => localStorage.getItem(key), collapsedSessionSectionsStorageKey),
      ).toBe(JSON.stringify(["category:Research"]));
    } finally {
      await context.close();
    }
  });

  it("returns to visible navigation when Unpin moves a row into a contextual sidebar", async () => {
    const context = await suite.browser.newContext();
    const page = await context.newPage();
    await page.addInitScript((settingsKey) => {
      localStorage.setItem(settingsKey, JSON.stringify({ sidebarAgentsMode: "chip" }));
    }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
    const gateway = await installMockGateway(page, {
      sessions: [sessionRow(sessionKey, "Research notes", 1_800_000_000_000, { pinned: true })],
      methodResponses: {
        "environments.list": { environments: [] },
        "node.list": { nodes: [] },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}systems`);
      const row = page.locator(`[data-session-key="${sessionKey}"]`);
      await row.hover();
      await row.locator("[data-session-menu]").click();
      await page.getByRole("menuitem", { name: "Unpin session", exact: true }).focus();
      await page.keyboard.press("Enter");
      await gateway.waitForRequest("sessions.patch", { match: { key: sessionKey, pinned: false } });
      await row.waitFor({ state: "hidden" });
      const navigation = page.locator(".sidebar-nav__head-action");
      await expect
        .poll(() => navigation.evaluate((element) => element === document.activeElement))
        .toBe(true);
      expect(await navigation.isVisible()).toBe(true);
      expect(new URL(page.url()).pathname).toBe("/systems");
    } finally {
      await context.close();
    }
  });

  it("preserves roster focus through Pin/Unpin and a collapse during a delayed reply", async () => {
    const context = await suite.browser.newContext();
    const page = await context.newPage();
    await page.addInitScript((settingsKey) => {
      localStorage.setItem(settingsKey, JSON.stringify({ sidebarAgentsMode: "roster" }));
    }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
    const gateway = await installMockGateway(page, {
      sessions: [sessionRow(sessionKey, "Research notes", 1_800_000_000_000)],
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const group = page.locator('openclaw-sidebar-agent-roster [data-agent-group="main"]');
      const row = group.locator(`[data-session-key="${sessionKey}"]`);
      const trigger = row.locator("[data-session-menu]");
      const collapse = group.locator('[data-agent-collapse="main"]');
      await row.waitFor();
      for (const pinned of [true, false]) {
        await row.hover();
        await trigger.click();
        await page
          .getByRole("menuitem", { name: pinned ? "Pin session" : "Unpin session", exact: true })
          .focus();
        const patches = (await gateway.getRequests("sessions.patch")).length;
        await page.keyboard.press("Enter");
        const patch = await gateway.waitForRequest("sessions.patch", { after: patches });
        expect(patch.params).toMatchObject({ key: sessionKey, pinned });
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey,
          pinned,
          pinnedAt: pinned ? 1_800_000_000_000 : null,
        });
        await expect
          .poll(async () => (await row.getAttribute("class"))?.includes("session-row-host--pinned"))
          .toBe(pinned);
        await expect
          .poll(() => trigger.evaluate((element) => element === document.activeElement))
          .toBe(true);
      }
      await gateway.deferNext("sessions.patch");
      await row.hover();
      await trigger.click();
      await page.getByRole("menuitem", { name: "Pin session", exact: true }).focus();
      const patches = (await gateway.getRequests("sessions.patch")).length;
      await page.keyboard.press("Enter");
      await gateway.waitForRequest("sessions.patch", { after: patches });
      await collapse.click();
      await row.waitFor({ state: "detached" });
      await gateway.resolveDeferred("sessions.patch");
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey,
        pinned: true,
        pinnedAt: 1_800_000_000_000,
      });
      await expect
        .poll(() => collapse.evaluate((element) => element === document.activeElement))
        .toBe(true);
      expect(await collapse.getAttribute("aria-expanded")).toBe("false");
      expect(await row.count()).toBe(0);
      await collapse.click();
      await expect
        .poll(async () => (await row.getAttribute("class"))?.includes("session-row-host--pinned"))
        .toBe(true);
    } finally {
      await context.close();
    }
  });
});
