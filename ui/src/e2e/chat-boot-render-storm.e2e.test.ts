import { writeFile } from "node:fs/promises";
import path from "node:path";
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

type RenderCount = { updates: number; milliseconds: number; instances: number };
type RenderProbeWindow = Window & { chatBootRenderCounts: Map<string, RenderCount> };

const suite = createControlUiE2eSuite({ name: "Chat boot render storm" });
const sessionKey = "agent:main:render-storm";
const label = "Synthetic busy conversation";

async function nextFrame(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

// The same performUpdate boundary used by the campaign's browser-init census.
// Counting all tags also exposes work transferred from a host into its children.
async function installRenderProbe(page: Page) {
  await page.addInitScript(() => {
    const counts = new Map<string, RenderCount>();
    (window as RenderProbeWindow).chatBootRenderCounts = counts;
    const patched = new WeakSet<object>();
    const instances = new WeakSet<object>();
    const define = customElements.define.bind(customElements);
    customElements.define = (name, constructor, options) => {
      let prototype = constructor.prototype;
      while (prototype && !Object.hasOwn(prototype, "performUpdate")) {
        prototype = Object.getPrototypeOf(prototype);
      }
      if (prototype && !patched.has(prototype)) {
        patched.add(prototype);
        const update = prototype.performUpdate;
        prototype.performUpdate = function (this: HTMLElement) {
          const count = counts.get(this.localName) ?? {
            updates: 0,
            milliseconds: 0,
            instances: 0,
          };
          const start = performance.now();
          try {
            return update.call(this);
          } finally {
            count.updates += 1;
            count.milliseconds += performance.now() - start;
            if (!instances.has(this)) {
              instances.add(this);
              count.instances += 1;
            }
            counts.set(this.localName, count);
          }
        };
      }
      define(name, constructor, options);
    };
  });
}

suite.define(() => {
  it("keeps closed menus unbuilt through a busy cold load and preserves the draft when opened", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 1000 } },
      async ({ page }) => {
        const pageErrors: Error[] = [];
        const pageError = new Promise<never>((_, reject) => {
          page.on("pageerror", (error) => {
            pageErrors.push(error);
            console.log("CHAT_BOOT_PAGE_ERROR", error.stack);
            reject(error);
          });
        });
        void pageError.catch(() => {});
        await installRenderProbe(page);
        await page.addInitScript(
          ({ key, sessionKey }) =>
            localStorage.setItem(
              key,
              JSON.stringify({
                sessionKey,
                sidebarSessionLayouts: {
                  [sessionKey]: {
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
                  },
                },
              }),
            ),
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl), sessionKey },
        );
        const people = Array.from({ length: 110 }, (_, index) => ({
          id: `person-${index}`,
          name: `Person ${String(index).padStart(3, "0")}`,
          self: index === 0,
          identity: { type: "profile" as const, id: `person-${index}` },
          watchedSessions: [sessionKey],
        }));
        const owner = { type: "human" as const, id: people[0]!.id, label: people[0]!.name };
        const sessions = Array.from({ length: 300 }, (_, index) =>
          createControlUiSessionRow(
            index === 0 ? sessionKey : `agent:main:fixture-${index}`,
            index === 0 ? label : `Synthetic session ${index}`,
            1_800_000_000_000 - index,
            {
              pinned: index > 0 && index <= 30,
              owner: { actor: owner },
              sharingRole: "owner",
              visibility: "shared",
            },
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
          workspaceGit: false,
          hasMultipleSessionSharingIdentities: true,
          presenceUsers: people,
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "users.list",
            "sessions.files.list",
            "session.members.listEvidence",
            "session.members.add",
            "session.members.remove",
            "session.visibility.set",
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
              identities: people.map((person) => ({
                type: "human",
                id: person.id,
                label: person.name,
              })),
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
        try {
          await Promise.race([
            page.getByText("Synthetic history is ready.", { exact: true }).waitFor(),
            pageError,
          ]);
        } catch (error) {
          console.log(
            "CHAT_BOOT_FAILURE",
            JSON.stringify(
              await page.evaluate(() => ({
                text: document.body.innerText.slice(-12000),
                state: (() => {
                  const pane = document.querySelector("openclaw-chat-pane") as HTMLElement & {
                    state?: {
                      connected?: boolean;
                      sessionKey?: string;
                      currentSessionId?: string;
                      chatLoading?: boolean;
                      chatMessages?: unknown[];
                      chatError?: unknown;
                      lastError?: unknown;
                      connectionEpoch?: number;
                      sessionsResult?: { sessions: unknown[] };
                    };
                  };
                  const state = pane?.state;
                  return (
                    state && {
                      connected: state.connected,
                      sessionKey: state.sessionKey,
                      currentSessionId: state.currentSessionId,
                      chatLoading: state.chatLoading,
                      messageCount: state.chatMessages?.length,
                      chatError: state.chatError,
                      lastError: state.lastError,
                      connectionEpoch: state.connectionEpoch,
                      sessionCount: state.sessionsResult?.sessions.length,
                    }
                  );
                })(),
                tags: Object.fromEntries((window as RenderProbeWindow).chatBootRenderCounts),
              })),
            ),
          );
          console.log(
            "CHAT_BOOT_REQUESTS",
            JSON.stringify(
              (await gateway.getRequests()).map(({ method, params }) => ({
                method,
                params: method === "connect" ? undefined : params,
              })),
            ),
          );
          await page.screenshot({ path: path.join(suite.artifactDir, "chat-boot-failure.png") });
          throw error;
        }
        await nextFrame(page);
        await nextFrame(page);
        const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        expect(pageErrors).toEqual([]);
        const measurement = await page.evaluate(() => ({
          tags: Object.fromEntries((window as RenderProbeWindow).chatBootRenderCounts),
          closedMenuItems: document.querySelectorAll(
            "openclaw-chat-pane wa-dropdown:not([open]) wa-dropdown-item",
          ).length,
          closedMenuHosts: Array.from(
            document.querySelectorAll(
              "openclaw-chat-pane wa-dropdown:not([open]) wa-dropdown-item",
            ),
            (item) => item.closest("wa-dropdown")?.className,
          ),
        }));
        await writeFile(
          path.join(suite.artifactDir, "chat-boot-render-counts.json"),
          JSON.stringify(measurement, null, 2),
        );
        console.log("CHAT_BOOT_RENDER_COUNTS", JSON.stringify(measurement));
        await page.screenshot({ path: path.join(suite.artifactDir, "chat-boot-closed-menus.png") });
        expect(measurement.tags["openclaw-chat-pane"]?.instances).toBe(1);
        expect(measurement.closedMenuItems).toBe(0);

        const composer = pane.getByRole("textbox", { name: "Chat composer" });
        await composer.fill("Keep this draft while the menus open.");
        await waitForCommittedComposerDraft(
          page,
          `chat:v3:${sessionKey}\u0000agent:main`,
          "Keep this draft while the menus open.",
          0,
        );
        const trigger = pane.getByRole("button", { name: `Actions for ${label}` });
        await trigger.focus();
        await page.keyboard.press("Enter");
        await pane
          .getByRole("menu", { name: `Actions for ${label}` })
          .waitFor({ state: "visible" });
        expect(
          await pane.locator("openclaw-chat-header-session-menu wa-dropdown-item").count(),
        ).toBeGreaterThan(10);
        await page.keyboard.press("Escape");
        await pane.getByRole("button", { name: "Session sharing", exact: true }).click();
        await pane
          .locator(".chat-pane__sharing-menu")
          .getByText("Members", { exact: true })
          .waitFor();
        await page.screenshot({ path: path.join(suite.artifactDir, "chat-boot-sharing-open.png") });
        await page.keyboard.press("Escape");
        expect(await composer.inputValue()).toBe("Keep this draft while the menus open.");
        expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      },
    );
  });
});
