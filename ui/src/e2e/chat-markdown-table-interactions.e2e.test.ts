import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  auditMarkdownTable,
  expectReadableAuditTable,
  expectResponsiveTableGeometry,
  readResponsiveTableGeometry,
} from "./chat-markdown-table-layout.test-support.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Markdown table interactions",
  trackBrowserContexts: true,
  startServerBeforeBrowser: true,
  unavailableMessage: (executable) => `Playwright Chromium is unavailable at ${executable}`,
});
const wideTable = `| Service | Owner | Region | Status | Version | Deploy | Incidents | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Gateway | Platform | eu-west-1 | Healthy | 2026.8.18 | Complete | 0 | [Long operational note that keeps this column wide](https://example.com/table-reference) |`;

function tableMessage(id: string, text: string, timestamp = Date.now()) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp,
    __openclaw: { id, seq: 1 },
  };
}
function expectFocused(locator: Locator) {
  return expect
    .poll(() => locator.evaluate((element) => element === document.activeElement))
    .toBe(true);
}
function tableContext(width = 1280, height = 900) {
  return suite.newBrowserContext({
    colorScheme: "dark",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { width, height },
  });
}

function readTableGeometry(element: Element) {
  const thread = element.closest<HTMLElement>(".chat-thread")!;
  const pane = thread.getBoundingClientRect();
  const bounds = element.getBoundingClientRect();
  const column = thread.querySelector<HTMLElement>(".chat-thread-inner")!;
  const viewport = element.querySelector<HTMLElement>(".markdown-table__viewport")!;
  return {
    contained: bounds.left >= pane.left && bounds.right <= pane.right,
    currentColumn:
      getComputedStyle(thread).getPropertyValue("--chat-transcript-column-width").trim() ===
      `${column.clientWidth}px`,
    overflow: viewport.scrollWidth - viewport.clientWidth,
    paneOverflow: thread.scrollWidth - thread.clientWidth,
    leadingGap: bounds.left - pane.left,
    trailingGap: pane.right - bounds.right,
  };
}

suite.define(() => {
  it("sizes desktop tables to content while preserving mobile layout and expanded headers", async () => {
    const context = await suite.newBrowserContext({ viewport: { width: 1440, height: 1000 } });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(suite.server.baseUrl).origin,
    });
    const page = await context.newPage();
    const rows = Array.from(
      { length: 24 },
      (_, index) =>
        `| A detailed failure description with enough context to explain the affected workflow, item ${index + 1} | Ready |`,
    ).join("\n");
    await installMockGateway(page, {
      historyMessages: [
        tableMessage(
          "wrapping-table",
          `The surrounding explanation stays at the normal reading width.\n\n| Failure description | Recorded implementation status |\n| --- | --- |\n${rows}

| A | B | C | D |
| --- | --- | --- | --- |
| 1 | 2 | 3 | 4 |

| A | B | C | D | E | F | G | H |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |

| Service | Owner | Region | Status | Version | Deployment | Incidents | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Gateway | Platform operations | eu-west-1 | Healthy | 2026.9.5 | Complete | 0 | Configuration validated and all connected clients recovered successfully after the restart. |

${auditMarkdownTable}`,
        ),
      ],
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    const message = page.locator('[data-entry-id="wrapping-table"]');
    const shell = message.locator(".markdown-table").first();
    const compact = message.locator(".markdown-table__viewport");
    const expand = shell.getByRole("button", { name: "Expand table" });
    await shell.waitFor({ state: "visible" });
    for (const width of [1920, 1440, 1280, 760, 390, 932]) {
      await page.setViewportSize({ width, height: width === 932 ? 430 : 1000 });
      await page.locator(".chat-thread").evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect
        .poll(async () => {
          const geometry = await shell.evaluate(readTableGeometry);
          return geometry.overflow <= 1 && geometry.currentColumn;
        })
        .toBe(true);
      expect(
        await compact.evaluateAll((elements) =>
          elements.slice(1, 3).every((element) => element.scrollWidth <= element.clientWidth + 1),
        ),
      ).toBe(true);
      const geometry = await shell.evaluate(readResponsiveTableGeometry);
      expectResponsiveTableGeometry(geometry, width);
      if (width === 390) {
        await expectReadableAuditTable(page, message.locator(".markdown-table").nth(4));
      }
    }
    await page.setViewportSize({ width: 1440, height: 800 });
    await openChatSidePanelType(page, "Files");
    await page.locator('.side-panel__panel[data-panel-slot="workspace"]').waitFor();
    await expect
      .poll(async () => {
        const geometry = await shell.evaluate(readTableGeometry);
        return geometry.contained && geometry.overflow <= 1;
      })
      .toBe(true);
    await page.getByRole("button", { name: "Close Files" }).click();
    await expand.click();
    const dialog = page.locator(".markdown-table-dialog");
    await dialog.waitFor({ state: "visible" });
    await dialog.evaluate((element) => {
      element.scrollTop = 400;
    });
    const sticky = await dialog.evaluate((element) => {
      const header = element.querySelector("thead")!;
      const rect = header.getBoundingClientRect();
      return {
        scrolled: element.scrollTop,
        pinned: Math.abs(rect.top - element.getBoundingClientRect().top) < 2,
        painted: header.contains(document.elementFromPoint(rect.left + 4, rect.top + 4)),
        background: getComputedStyle(header).backgroundColor,
      };
    });
    expect(sticky.scrolled).toBeGreaterThan(100);
    expect(sticky).toMatchObject({ pinned: true, painted: true });
    expect(sticky.background).not.toBe("rgba(0, 0, 0, 0)");
    await page.keyboard.press("Escape");
    await expectFocused(expand);
  });

  it("contains content-sized tables after restoring a percentage reading width", async () => {
    const overflowTable = [
      `| ${Array.from({ length: 14 }, (_, index) => `Configuration${index + 1}`).join(" | ")} |`,
      `| ${Array(14).fill("---").join(" | ")} |`,
      `| ${Array(14).fill("Available").join(" | ")} |`,
    ].join("\n");
    const context = await suite.newBrowserContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        tableMessage(
          "percentage-table",
          `Keep this explanation at the saved reading width.

| Failure | Recorded implementation author |
| --- | --- |
| Quiet mode displays reasoning and an unwanted exit message after a queued run is cancelled | Morgan, with Riley as coauthor on the follow-up repair |
| A warning survives an intentional no-reply response | Casey, exposing older fallback behavior |

${overflowTable}`,
        ),
      ],
    });
    await page.goto(`${suite.server.baseUrl}settings/appearance#settings-appearance-chat`);
    const widthInput = page.locator("[data-settings-chat-message-width]");
    await widthInput.fill("82%");
    await widthInput.press("Tab");
    await page.goto(`${suite.server.baseUrl}chat`);
    const tables = page.locator('[data-entry-id="percentage-table"] .markdown-table');
    const shell = tables.first();
    const overflow = tables.nth(1);
    await shell.waitFor({ state: "visible" });
    await expect
      .poll(() =>
        page
          .locator(".chat")
          .evaluate((element) =>
            getComputedStyle(element).getPropertyValue("--chat-thread-max-width").trim(),
          ),
      )
      .toBe("82%");
    const contained = async () =>
      (
        await Promise.all((await tables.all()).map((table) => table.evaluate(readTableGeometry)))
      ).every((geometry) => geometry.contained && geometry.currentColumn);
    for (const width of [1440, 1920, 1280]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const direction of ["ltr", "rtl"]) {
        await page.evaluate((value) => {
          document.documentElement.dir = value;
        }, direction);
        await expect.poll(contained).toBe(true);
        const sizing = await overflow.evaluate(readTableGeometry);
        // The 18px gutter plus 12px inset is independent of native scrollbar width.
        expect(sizing.leadingGap).toBeGreaterThanOrEqual(29);
        expect(sizing.trailingGap).toBeGreaterThanOrEqual(29);
        expect(sizing.overflow).toBeGreaterThan(0);
        expect(sizing.paneOverflow).toBeLessThanOrEqual(1);
        expect(
          await shell.evaluate(
            (element) =>
              element.getBoundingClientRect().width -
              element.parentElement!.getBoundingClientRect().width,
          ),
        ).toBeLessThanOrEqual(1);
      }
    }
    await page.evaluate(() => {
      document.documentElement.dir = "ltr";
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect.poll(contained).toBe(true);
    await openChatSidePanelType(page, "Files");
    await page.locator('.side-panel__panel[data-panel-slot="workspace"]').waitFor();
    await expect.poll(contained).toBe(true);
    expect(
      await shell
        .locator(".markdown-table__viewport")
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeLessThanOrEqual(1);
  });

  it.each(["chat", "assistant panel"])(
    "contains overflow and preserves copy, fullscreen focus, and web links in %s",
    async (surface) => {
      const context = await tableContext(surface === "chat" ? 760 : 1280, 800);
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(suite.server.baseUrl).origin,
      });
      await context.route("https://example.com/table-reference", (route) =>
        route.fulfill({ contentType: "text/html", body: "<h1>Table reference</h1>" }),
      );
      const page = await context.newPage();
      await installMockGateway(page, {
        ...(surface === "assistant panel"
          ? {
              sessions: [
                { key: "agent:main:main", label: "Main", kind: "direct", updatedAt: Date.now() },
              ],
              featureMethods: [
                "chat.metadata",
                "chat.startup",
                "chat.history",
                "chat.send",
                "openclaw.chat",
                "openclaw.chat.history",
              ],
              methodResponses: {
                "sessions.list": {
                  cases: [
                    // Main is the only session and does not match this palette query.
                    {
                      match: { search: "Ask OpenClaw" },
                      response: { count: 0, sessions: [] },
                    },
                  ],
                },
                "openclaw.chat": {
                  sessionId: "table-proof",
                  reply: "Ready to help.",
                  action: "none",
                },
                "openclaw.chat.history": {
                  turns: [{ role: "assistant", text: wideTable, at: 1_700_000_101_000 }],
                },
              },
            }
          : {}),
        historyMessages: [tableMessage("assistant-table", wideTable)],
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      if (surface === "assistant panel") {
        await page.locator(".sidebar-brand__search").click();
        await page
          .locator("openclaw-command-palette")
          .getByPlaceholder("Search or start a task…")
          .fill("Ask OpenClaw");
        await page.getByRole("option", { name: "Ask OpenClaw", exact: true }).click();
      }
      const bubble = page.locator(
        surface === "chat" ? '[data-entry-id="assistant-table"]' : ".custodian__messages",
      );
      const shell = bubble.locator(".markdown-table");
      const viewport = shell.locator(".markdown-table__viewport");
      const copy = shell.getByRole("button", { name: "Copy table" });
      const expand = shell.getByRole("button", { name: "Expand table" });
      await shell.waitFor({ state: "visible" });
      await expect.poll(() => shell.getAttribute("class")).toContain("can-scroll-right");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        ),
      ).toBe(true);

      await viewport.evaluate((element) => {
        element.scrollLeft = Math.max(1, (element.scrollWidth - element.clientWidth) / 2);
        element.dispatchEvent(new Event("scroll"));
      });
      await expect.poll(() => shell.getAttribute("class")).toContain("can-scroll-left");
      await expect.poll(() => shell.getAttribute("class")).toContain("can-scroll-right");

      await copy.click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toContain("Service\tOwner\tRegion\tStatus\tVersion\tDeploy\tIncidents\tNotes");

      await expand.focus();
      const inlineTable = shell.locator("table");
      const noteWidth = await inlineTable
        .locator("td")
        .last()
        .evaluate((cell) => cell.getBoundingClientRect().width);
      const statusWidth = await inlineTable
        .locator("td")
        .nth(3)
        .evaluate((cell) => cell.getBoundingClientRect().width);
      expect(noteWidth).toBeGreaterThan(statusWidth * 2);
      await expand.dblclick();
      const dialog = page.locator(".markdown-table-dialog");
      await dialog.waitFor({ state: "visible" });
      expect(await page.locator(".markdown-table-modal").count()).toBe(1);
      const fullscreenTable = dialog.locator("table");
      expect(await fullscreenTable.textContent()).toContain("Gateway");
      const tableProperties = [
        "background-color",
        "border-collapse",
        "border-top-width",
        "box-shadow",
      ] as const;
      const cellProperties = [
        "background-color",
        "border-right-width",
        "border-bottom-color",
        "overflow-wrap",
        "white-space",
        "word-break",
      ] as const;
      const readStyles = async (locator: typeof inlineTable, properties: readonly string[]) =>
        locator.evaluate((element, propertyNames) => {
          const styles = getComputedStyle(element);
          return Object.fromEntries(
            propertyNames.map((property) => {
              const value = styles.getPropertyValue(property);
              if (!value) {
                throw new Error(`Missing computed value for ${property}`);
              }
              return [property, value];
            }),
          );
        }, properties);
      for (const [selector, properties] of [
        ["table", tableProperties],
        ["th", cellProperties],
        ["td", cellProperties],
      ] as const) {
        expect(await readStyles(dialog.locator(selector).first(), properties)).toEqual(
          await readStyles(shell.locator(selector).first(), properties),
        );
      }

      // The viewport margin stays outside the dialog while its opening scale changes.
      await page.mouse.click(8, 8);
      await expect.poll(() => dialog.count()).toBe(0);
      await expectFocused(expand);

      const sourceUrl = page.url();
      await expand.click();
      await dialog.waitFor({ state: "visible" });
      const popupPromise = context.waitForEvent("page");
      await dialog
        .getByRole("link", { name: "Long operational note that keeps this column wide" })
        .press("Enter");
      const popup = await popupPromise;
      await popup.getByRole("heading", { name: "Table reference" }).waitFor();
      expect(popup.url()).toBe("https://example.com/table-reference");
      expect(page.url()).toBe(sourceUrl);
      await popup.close();
      await dialog.waitFor({ state: "detached" });

      await expand.click();
      await dialog.waitFor({ state: "visible" });
      await page.keyboard.press("Escape");
      await expect.poll(() => dialog.count()).toBe(0);
      await expectFocused(expand);
    },
  );

  it.each(["expanded table", "held session hovercard"])(
    "releases an %s when browser history retires its retained pane",
    async (overlay) => {
      const alphaKey = "agent:main:dashboard:table-alpha";
      const betaKey = "agent:main:dashboard:table-beta";
      const context = await tableContext();
      const page = await context.newPage();
      await installMockGateway(page, {
        sessionKey: alphaKey,
        sessions: [
          { key: alphaKey, label: "Alpha table" },
          { key: betaKey, label: "Beta table" },
        ],
        featureMethods: ["chat.metadata", "chat.startup", "chat.history", "chat.send"],
        sessionTranscripts: Object.fromEntries(
          (
            [
              [alphaKey, betaKey, "history-alpha", "Alpha"],
              [betaKey, alphaKey, "history-beta", "Beta"],
            ] as const
          ).map(([key, other, id, name]) => [
            key,
            {
              messages: [
                tableMessage(id, `| Name | Task |\n| --- | --- |\n| ${name} table | ${other} |`, 1),
              ],
            },
          ]),
        ),
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, alphaKey));
      const alpha = page.locator('[data-entry-id="history-alpha"]');
      await alpha.waitFor({ state: "visible" });
      const alphaPane = await alpha.evaluateHandle((entry) => entry.closest("openclaw-chat-pane"));
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);

      await alpha.locator(`a[data-session-key="${betaKey}"]`).click();
      await page.waitForURL(controlUiSessionUrl(suite.server.baseUrl, betaKey));
      const beta = page.locator('[data-entry-id="history-beta"]');
      await beta.waitFor({ state: "visible" });
      const betaPane = await beta.evaluateHandle((entry) => entry.closest("openclaw-chat-pane"));
      const expectRetainedPanes = async (activeIndex: number) => {
        const states = await Promise.all(
          [alphaPane, betaPane].map((pane) =>
            pane.evaluate((element) => [
              element?.isConnected,
              element?.getAttribute("aria-hidden"),
              element?.hasAttribute("inert"),
            ]),
          ),
        );
        // Connected, aria-hidden, inert: both panes survive, but only one stays active.
        expect(states).toEqual(
          [0, 1].map((index) => [true, String(index !== activeIndex), index !== activeIndex]),
        );
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
      };
      await expectRetainedPanes(1);

      const dialog = page.locator(".markdown-table-dialog");
      const hovercard = page.locator(".session-progress-hovercard");
      const sourceLink = beta.locator(`a[data-session-key="${alphaKey}"]`);
      if (overlay === "expanded table") {
        // The parked pointer can open Beta's backlink card over the table controls.
        await page.mouse.move(8, 8);
        await expect.poll(() => hovercard.count()).toBe(0);
        await beta.getByRole("button", { name: "Expand table" }).click();
        await dialog.waitFor({ state: "visible" });
        expect(await dialog.textContent()).toContain("Beta table");
      } else {
        await sourceLink.hover();
        await hovercard.waitFor({ state: "visible" });
        expect(await sourceLink.getAttribute("aria-controls")).toBe(
          await hovercard.getAttribute("id"),
        );
        await hovercard.hover();
      }
      await page.goBack();
      await page.waitForURL(controlUiSessionUrl(suite.server.baseUrl, alphaKey));
      await expect
        .poll(() => alphaPane.evaluate((pane) => pane?.getAttribute("aria-hidden")))
        .toBe("false");
      await expect.poll(() => dialog.count()).toBe(0);
      await expectRetainedPanes(0);
      if (overlay === "held session hovercard") {
        await expect.poll(() => hovercard.count()).toBe(0);
      }

      for (const [entry, name, index] of [
        [alpha, "Alpha", 0],
        [beta, "Beta", 1],
      ] as const) {
        if (index === 1) {
          await page.goForward();
          await page.waitForURL(controlUiSessionUrl(suite.server.baseUrl, betaKey));
          await expect
            .poll(() => betaPane.evaluate((pane) => pane?.getAttribute("aria-hidden")))
            .toBe("false");
          await expectRetainedPanes(1);
        }
        const expand = entry.getByRole("button", { name: "Expand table" });
        await expand.click();
        await dialog.waitFor({ state: "visible" });
        expect(await dialog.count()).toBe(1);
        expect(await dialog.textContent()).toContain(name + " table");
        await page.keyboard.press("Escape");
        await expect.poll(() => dialog.count()).toBe(0);
        if (index === 0) {
          await expectFocused(expand);
        }
      }
    },
  );

  it("restores overflow affordances when a retained table viewport narrows", async () => {
    const context = await tableContext();
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        tableMessage(
          "retained-table",
          `| Service | Owner | Region | Status | Version | Reference |
| --- | --- | --- | --- | --- | --- |
| Gateway | Platform | EU | Healthy | 1.0 | ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890123456789 |`,
          1,
        ),
      ],
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    const shell = page.locator('[data-entry-id="retained-table"] .markdown-table');
    const viewport = shell.locator(".markdown-table__viewport");
    await shell.waitFor({ state: "visible" });
    expect(
      await viewport.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    expect(await shell.getAttribute("class")).not.toContain("can-scroll-right");
    const originalTable = await shell.elementHandle();

    const retained = await page
      .locator("openclaw-chat-pane")
      .first()
      .evaluate((pane) => {
        const table = pane.querySelector(".markdown-table");
        const parent = pane.parentNode!;
        const next = pane.nextSibling;
        pane.remove();
        parent.insertBefore(pane, next);
        return pane.querySelector(".markdown-table") === table;
      });
    expect(retained).toBe(true);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    // Resize only the viewport: a whole-app responsive render also resynchronizes tables.
    await viewport.evaluate((element) => {
      element.style.maxWidth = "360px";
    });
    expect(
      await viewport.evaluate((element) => element.scrollWidth - element.clientWidth),
    ).toBeGreaterThan(1);
    await expect.poll(() => shell.getAttribute("class")).toContain("can-scroll-right");
    expect(await shell.evaluate((element, original) => element === original, originalTable)).toBe(
      true,
    );
  });

  it.each([
    { surface: "chat", link: "file", activation: "click" },
    { surface: "chat", link: "session", activation: "Space" },
    { surface: "assistant panel", link: "session", activation: "click" },
    { surface: "assistant panel", link: "session", activation: "Enter" },
  ])(
    "opens a $link from an expanded table in $surface with $activation",
    async ({ surface, link, activation }) => {
      const sourceKey = "agent:main:dashboard:table-source";
      const targetKey = "agent:main:dashboard:table-target";
      const table = `| File | Task |
| --- | --- |
| \`src/ready.ts:2\` | ${targetKey} |`;
      const context = await suite.newBrowserContext({
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const gateway = await installMockGateway(page, {
        sessionKey: sourceKey,
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "chat.history",
          "chat.send",
          "progressCard.get",
          "openclaw.chat",
          "openclaw.chat.history",
        ],
        sessions: [
          { key: sourceKey, label: "Table links" },
          { key: targetKey, label: "Linked task" },
        ],
        sessionTranscripts: {
          [sourceKey]: {
            messages: [tableMessage("table-links", table, 1)],
          },
          [targetKey]: {
            messages: [tableMessage("linked-task", "Linked task reached.", 2)],
          },
        },
        methodResponses: {
          "openclaw.chat": { sessionId: "table-links", reply: "Ready to help.", action: "none" },
          "openclaw.chat.history": {
            turns: [{ role: "assistant", text: table, at: 1_700_000_101_000 }],
          },
          "progressCard.get": { card: null },
          "sessions.files.get": {
            root: "/workspace",
            sessionKey: sourceKey,
            file: {
              previewKind: "text",
              contentEncoding: "utf8",
              content: "// Workspace file\nexport const ready = true;\n",
              kind: "read",
              missing: false,
              name: "ready.ts",
              path: "src/ready.ts",
              workspacePath: "src/ready.ts",
            },
          },
        },
      });
      const selector =
        link === "file" ? 'a[data-file-path="src/ready.ts"]' : `a[data-session-key="${targetKey}"]`;
      const activate = async (scope: ReturnType<typeof page.locator>) => {
        const anchor = scope.locator(selector);
        if (activation === "click") {
          await anchor.click();
        } else {
          await anchor.press(activation);
        }
      };
      const expectDestination = async (fileRequestCount: number) => {
        if (link === "file") {
          await expect
            .poll(async () => (await gateway.getRequests("sessions.files.get")).length)
            .toBe(fileRequestCount);
          await expect
            .poll(() => page.locator(".sidebar-file-view").textContent())
            .toContain("export const ready = true;");
        } else {
          await expect
            .poll(() => page.url())
            .toBe(controlUiSessionUrl(suite.server.baseUrl, targetKey));
          await page.locator('[data-entry-id="linked-task"]').waitFor({ state: "visible" });
        }
      };
      const openSource = async () => {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sourceKey));
        await page.locator('[data-entry-id="table-links"]').waitFor({ state: "visible" });
        if (surface === "assistant panel") {
          await page.locator(".sidebar-footer-bar__home").click();
          await page
            .locator("openclaw-assistant-panel")
            .getByRole("button", { name: "Ask OpenClaw", exact: true })
            .click();
        }
      };
      await openSource();
      const shell = page.locator(
        surface === "chat"
          ? '[data-entry-id="table-links"] .markdown-table'
          : ".custodian__messages .markdown-table",
      );
      await activate(shell);
      await expectDestination(1);
      await openSource();
      await shell.getByRole("button", { name: "Expand table" }).click();
      const dialog = page.locator(".markdown-table-dialog");
      await dialog.waitFor({ state: "visible" });
      if (link === "session" && surface === "chat") {
        const sessionLink = dialog.locator(selector);
        const close = dialog.getByRole("button", { name: "Close expanded table" });
        await sessionLink.focus();
        await page.keyboard.press("Tab");
        await expectFocused(close);
        await page.keyboard.press("Shift+Tab");
        await expectFocused(sessionLink);
        await gateway.setMethodResponse("progressCard.get", {
          card: {
            markdown: "[Open build log](https://example.com/build)",
            revision: 1,
            sessionKey: targetKey,
            updatedAt: 1,
          },
        });
        await gateway.emitGatewayEvent("progressCard.changed", {
          revision: 1,
          sessionKey: targetKey,
        });
        const progressLink = page
          .locator(".session-progress-hovercard")
          .getByRole("link", { name: "Open build log" });
        await progressLink.waitFor({ state: "visible" });
        await page.keyboard.press("Tab");
        await expect
          .poll(() => page.locator(".session-progress-hovercard a:focus").count())
          .toBe(1);
        expect(await dialog.isVisible()).toBe(true);
        await page.keyboard.press("Shift+Tab");
        await expectFocused(sessionLink);
        const popupPromise = context.waitForEvent("page");
        await sessionLink.click({ modifiers: ["ControlOrMeta"] });
        const popup = await popupPromise;
        await expect
          .poll(() => popup.url())
          .toBe(controlUiSessionUrl(suite.server.baseUrl, targetKey));
        await popup.close();
        expect(page.url()).toBe(controlUiSessionUrl(suite.server.baseUrl, sourceKey));
        await dialog.waitFor({ state: "detached" });
        await shell.getByRole("button", { name: "Expand table" }).click();
        await dialog.waitFor({ state: "visible" });
      }
      const before = (await gateway.getRequests("sessions.files.get")).length;
      await activate(dialog);
      await expectDestination(before + 1);
      await dialog.waitFor({ state: "detached" });
    },
  );
});
