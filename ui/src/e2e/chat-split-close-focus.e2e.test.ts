import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

// Closing a focused pane preserves keyboard ownership, independently of draft persistence.
const suite = createControlUiE2eSuite({ name: "Split pane close focus" });
suite.define(() => {
  it.each([
    { count: 2, closed: 1, surviving: 0, presentation: "chat" },
    { count: 2, closed: 0, surviving: 1, presentation: "chat" },
    { count: 3, closed: 2, surviving: 1, presentation: "chat" },
    { count: 2, closed: 1, surviving: 0, presentation: "read-only" },
    { count: 2, closed: 1, surviving: 0, presentation: "dashboard" },
  ])(
    "returns named focus to the surviving $presentation pane after closing pane $closed of $count",
    async ({ count, closed, surviving, presentation }) => {
      const editable = presentation !== "read-only";
      const composerVisible = presentation !== "dashboard";
      await suite.withPage({ viewport: { width: 1920, height: 1000 } }, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const rows = Array.from({ length: count }, (_, index) => ({
          key: `agent:main:close-${index}`,
          kind: "direct",
          label: `Research ${index}`,
          ...(!editable
            ? { visibility: "read-only" as const, sharingRole: "viewer" as const }
            : {}),
          updatedAt: 100 - index,
        }));
        const home = {
          key: "agent:main:main",
          kind: "direct",
          label: "Personal Home",
          updatedAt: 80,
        };
        await page.addInitScript(
          ({ storageKey, sessions, closedIndex, survivingIndex, dashboard }) => {
            localStorage.setItem(
              storageKey,
              JSON.stringify({
                ...(dashboard
                  ? {
                      sidebarSessionLayouts: {
                        [sessions[survivingIndex]!.key]: {
                          columns: [
                            {
                              id: "dashboard-column",
                              side: "right",
                              panels: [{ id: "dashboard", slot: "dashboard" }],
                              activePanelId: "dashboard",
                              width: 480,
                              height: 360,
                            },
                          ],
                          mainPanelId: "dashboard",
                          open: true,
                          expanded: true,
                        },
                      },
                    }
                  : {}),
                chatSplitLayout: {
                  activePaneId: `p${closedIndex + 1}`,
                  columnWeights: sessions.map(() => 1 / sessions.length),
                  columns: sessions.map((row, index) => ({
                    id: `c${index + 1}`,
                    paneWeights: [1],
                    panes: [{ id: `p${index + 1}`, sessionKey: row.key }],
                  })),
                },
              }),
            );
          },
          {
            storageKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
            sessions: rows,
            closedIndex: closed,
            survivingIndex: surviving,
            dashboard: !composerVisible,
          },
        );
        const gateway = await installMockGateway(page, {
          sessionKey: rows[closed]!.key,
          operatorScopes: editable ? undefined : ["operator.read"],
          methodResponses: {
            "board.get": {
              sessionKey: rows[surviving]!.key,
              revision: 1,
              tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
              widgets: [],
            },
          },
          sessions: [...rows, home],
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "chat.history",
            "chat.send",
            "board.get",
          ],
          sessionTranscripts: Object.fromEntries(
            [...rows, home].map((row) => [
              row.key,
              {
                messages: [
                  { role: "assistant", content: `Conversation ${row.label}`, timestamp: 1 },
                ],
              },
            ]),
          ),
        });
        await page.goto(`${suite.server.baseUrl}chat/main/close-${closed}`);
        const paneA = page
          .locator("openclaw-chat-page openclaw-chat-pane")
          .filter({ hasText: `Conversation Research ${surviving}` });
        const paneB = page
          .locator("openclaw-chat-page openclaw-chat-pane")
          .filter({ hasText: `Conversation Research ${closed}` });
        const composerA = paneA.locator(".agent-chat__composer-combobox textarea");
        const composerB = paneB.locator(".agent-chat__composer-combobox textarea");
        if (editable && composerVisible) {
          await composerA.fill("Draft A");
        }
        if (editable) {
          await composerB.fill("Draft B");
        }
        if (!editable) {
          await expect.poll(() => composerA.isDisabled()).toBe(true);
        }
        if (!composerVisible) {
          await paneA.locator('[data-panel-slot="dashboard"][data-region="main"]').waitFor();
          await expect.poll(() => composerA.isVisible()).toBe(false);
        }
        if (editable) {
          await page.locator(".sidebar-footer-bar__home").click();
        }
        const homeComposer = page.locator(
          "openclaw-assistant-panel .agent-chat__composer-combobox textarea",
        );
        if (editable) {
          await homeComposer.fill("Home draft");
        }
        const close = paneB.locator(".chat-pane__close-pane");
        await close.focus();
        expect(await close.evaluate((element) => element === document.activeElement)).toBe(true);
        await page.screenshot({ path: path.join(suite.artifactDir, "before-close.png") });
        await page.keyboard.press("Enter");
        // Closed logical pane retires; another pane may retain B as an inert cache entry.
        await expect
          .poll(() => page.locator("openclaw-chat-page .chat-split-view__cell").count())
          .toBe(count - 1);
        await expect.poll(() => paneA.getAttribute("aria-hidden")).toBe("false");
        await expect
          .poll(() => paneA.getAttribute("class"))
          .toContain("chat-pane-cache__pane--active");
        await expect
          .poll(() => page.url())
          .toContain(`/${composerVisible ? "chat" : "dashboard"}/main/close-${surviving}`);
        const focus = () =>
          page.evaluate(() => ({
            tag: document.activeElement?.tagName,
            className: document.activeElement?.className,
            label: document.activeElement?.getAttribute("aria-label"),
            inChat: Boolean(
              document.activeElement?.closest(
                'openclaw-chat-page openclaw-chat-pane.chat-pane-cache__pane--active[aria-hidden="false"]:not([inert])',
              ),
            ),
            focusedPane: (() => {
              const pane = document.activeElement?.closest("openclaw-chat-pane");
              return pane
                ? {
                    active: pane.classList.contains("chat-pane-cache__pane--active"),
                    presented: pane.getAttribute("aria-hidden") === "false",
                    inert: pane.hasAttribute("inert"),
                  }
                : null;
            })(),
            inHome: Boolean(document.activeElement?.closest("openclaw-assistant-panel")),
          }));
        const afterClose = await focus();
        const accessibilityAfterClose = await page.locator(":focus").ariaSnapshot();
        const draftAfterClose = await composerA.inputValue();
        await page.screenshot({ path: path.join(suite.artifactDir, "after-close.png") });
        if (editable && composerVisible) {
          await page.keyboard.type(" continuation");
        }
        const afterTyping = await focus();
        const observations = {
          afterClose,
          accessibilityAfterClose,
          afterTyping,
          draftAfterClose,
          finalDraftA: await composerA.inputValue(),
          finalHomeDraft: editable ? await homeComposer.inputValue() : null,
          url: page.url(),
          errors,
          methods: (await gateway.getRequests()).map(({ method }) => method),
        };
        await writeFile(
          path.join(suite.artifactDir, "observations.json"),
          JSON.stringify(observations, null, 2),
        );
        await page.screenshot({
          path: path.join(suite.artifactDir, "after-keyboard-continuation.png"),
        });
        expect.soft(draftAfterClose).toBe(editable && composerVisible ? "Draft A" : "");
        expect
          .soft(observations.finalDraftA)
          .toBe(editable && composerVisible ? "Draft A continuation" : "");
        expect.soft(observations.finalHomeDraft).toBe(editable ? "Home draft" : null);
        expect.soft(observations.methods.filter((method) => method === "chat.send")).toEqual([]);
        expect.soft(await gateway.getRequests("sessions.patch")).toEqual([]);
        expect.soft(errors).toEqual([]);
        expect.soft(afterClose.inChat).toBe(true);
        expect
          .soft(accessibilityAfterClose.split("\n")[0])
          .toBe(`- group "Research ${surviving}":`);
      });
    },
  );
});
