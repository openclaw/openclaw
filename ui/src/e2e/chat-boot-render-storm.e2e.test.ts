import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForCommittedComposerDraft } from "./settle.test-support.ts";

declare global {
  interface Window {
    chatBootPaneInstances: number;
  }
}

const suite = createControlUiE2eSuite({ name: "Chat boot render storm" });
const sessionKey = "agent:main:render-storm";
const label = "Synthetic busy conversation";

async function nextFrame(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      }),
  );
}

async function installRenderProbe(page: Page) {
  await page.addInitScript(() => {
    window.chatBootPaneInstances = 0;
    const instances = new WeakSet<object>();
    const define = customElements.define.bind(customElements);
    customElements.define = (name, constructor, options) => {
      if (name === "openclaw-chat-pane") {
        const connected = constructor.prototype.connectedCallback;
        constructor.prototype.connectedCallback = function (this: HTMLElement) {
          if (!instances.has(this)) {
            instances.add(this);
            window.chatBootPaneInstances += 1;
          }
          return connected.call(this);
        };
      }
      define(name, constructor, options);
    };
  });
}

suite.define(() => {
  it("prewarms session actions after a busy cold load without building unrelated menus or losing the draft", () =>
    suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 1000 } },
      async ({ page }) => {
        const pageErrors: Error[] = [];
        const pageError = new Promise<never>((_, reject) => {
          page.on("pageerror", (error) => {
            pageErrors.push(error);
            reject(error);
          });
        });
        void pageError.catch(() => {});
        await installRenderProbe(page);
        const layout = {
          columns: [
            {
              id: "side-panel-column",
              side: "right",
              panels: [{ id: "workspace", slot: "workspace" }],
              activePanelId: "workspace",
              height: 360,
              width: 480,
            },
          ],
          dock: "right",
          open: true,
          expanded: false,
        };
        await page.addInitScript(
          ({ key, settings }) => localStorage.setItem(key, JSON.stringify(settings)),
          {
            key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
            settings: { sessionKey, sidebarSessionLayouts: { [sessionKey]: layout } },
          },
        );
        const people = Array.from({ length: 110 }, (_, index) => ({
          id: `person-${index}`,
          name: `Person ${String(index).padStart(3, "0")}`,
          self: index === 0,
          identity: { type: "profile" as const, id: `person-${index}` },
          watchedSessions: [sessionKey],
        }));
        const identities = people.map(({ id, name }) => ({
          type: "human" as const,
          id,
          label: name,
        }));
        const owner = identities[0]!;
        const shared = { owner: { actor: owner }, sharingRole: "owner", visibility: "shared" };
        const sessions = Array.from({ length: 300 }, (_, index) =>
          createControlUiSessionRow(
            index === 0 ? sessionKey : `agent:main:fixture-${index}`,
            index === 0 ? label : `Synthetic session ${index}`,
            1_800_000_000_000 - index,
            Object.assign({}, shared, { pinned: index > 0 && index <= 30 }),
          ),
        );
        const historyMessages = Array.from({ length: 160 }, (_, index) => ({
          role: index % 2 === 0 ? "user" : "assistant",
          timestamp: 1_800_000_000_000 + index,
          content:
            index === 159
              ? "Synthetic history is ready."
              : `Message ${index}.\n\n${"A measured conversation with a stable reading position. ".repeat(8)}\n\n\`\`\`ts\nconst item = ${index};\n\`\`\``,
        }));
        const gateway = await installMockGateway(page, {
          sessionKey,
          awaitInitialRoster: false,
          sessions,
          historyMessages,
          workspace: "/synthetic/workspace",
          hasMultipleSessionSharingIdentities: true,
          presenceUsers: people,
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "users.list",
            "sessions.files.list",
            "session.suggestions.list",
            "session.suggestions.add",
            "taskSuggestions.list",
          ],
          methodResponses: {
            "sessions.files.list": {
              browser: { entries: [], path: "" },
              files: [],
              root: "/synthetic/workspace",
              sessionKey,
              gitCheckout: false,
            },
            "users.list": {
              profiles: people.map((person) => ({
                id: person.id,
                displayName: person.name,
                emails: [],
                avatarMime: null,
                mergedInto: null,
                githubIdentity: null,
                hasAvatar: false,
                createdAt: 1,
                updatedAt: 1,
              })),
            },
            "session.members.listEvidence": {
              sessionKey,
              owner,
              members: [],
              role: "owner",
              identities,
              allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
            },
            "session.suggestions.list": { suggestions: [], role: "owner" },
            "taskSuggestions.list": { suggestions: [] },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await gateway.waitForRequest("chat.startup");
        // Distinct event deliveries exercise the real Gateway subscription during boot.
        for (let index = 0; index < 24; index += 1) {
          await gateway.emitGatewayEvent("session.suggestion", {
            action: "added",
            suggestion: {
              id: `suggestion-${index}`,
              sessionKey,
              agentId: "main",
              author: owner,
              text: `Suggestion ${index}`,
              createdAt: index + 1,
              state: "pending",
            },
          });
        }
        await Promise.race([
          page.getByText("Synthetic history is ready.", { exact: true }).waitFor(),
          pageError,
        ]);
        await nextFrame(page);
        await nextFrame(page);
        const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        expect(pageErrors).toEqual([]);
        await expect
          .poll(() => pane.locator('openclaw-chat-header-session-menu [role^="menuitem"]').count())
          .toBeGreaterThan(0);
        expect(await pane.locator('[role="menu"][popover]:popover-open').count()).toBe(0);
        const measurement = await page.evaluate(() => {
          const items = Array.from(
            document.querySelectorAll(
              'openclaw-chat-pane [role="menu"][popover]:not(:popover-open) [role^="menuitem"]',
            ),
          );
          return {
            paneInstances: window.chatBootPaneInstances,
            unrelatedClosedMenuItems: items.filter(
              (item) => !item.closest("openclaw-chat-header-session-menu"),
            ).length,
          };
        });
        expect(measurement).toEqual({ paneInstances: 1, unrelatedClosedMenuItems: 0 });

        const composer = pane.getByRole("textbox", { name: "Chat composer" });
        const draft = "Keep this draft while the menus open.";
        await composer.fill(draft);
        await waitForCommittedComposerDraft(
          page,
          `chat:v3:${sessionKey}\u0000agent:main`,
          draft,
          0,
        );
        const trigger = pane.getByRole("button", { name: `Actions for ${label}` });
        await trigger.focus();
        await page.keyboard.press("Enter");
        await pane
          .getByRole("menu", { name: `Actions for ${label}` })
          .waitFor({ state: "visible" });
        expect(
          await pane.locator('openclaw-chat-header-session-menu [role^="menuitem"]').count(),
        ).toBeGreaterThan(10);
        await page.keyboard.press("Escape");
        await pane.getByRole("button", { name: "Session sharing", exact: true }).click();
        const sharing = pane.locator(".chat-pane__sharing-menu");
        await sharing.getByText("Members", { exact: true }).waitFor();
        const search = sharing.getByRole("searchbox", { name: "Search people and agents…" });
        await search.fill("Person 109");
        await nextFrame(page);
        await page.keyboard.press("ArrowDown");
        expect(await sharing.locator(".chat-pane__sharing-member").count()).toBe(1);
        expect(
          await sharing
            .locator('[data-value="member:person-109"]')
            .evaluate((element) => element === document.activeElement),
        ).toBe(true);
        await page.keyboard.press("ArrowUp");
        expect(await search.evaluate((element) => element === document.activeElement)).toBe(true);
        await page.keyboard.press("Escape");
        expect(await search.inputValue()).toBe("");
        await page.keyboard.press("Escape");
        expect(
          await sharing
            .locator(".chat-pane__sharing-trigger")
            .evaluate((element) => element === document.activeElement),
        ).toBe(true);
        expect(await composer.inputValue()).toBe(draft);
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    ));
});
