import type { Locator, Page } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { expect, it } from "vitest";
import type {
  SessionCatalog,
  SessionCatalogHost,
  SessionCatalogSession,
} from "../../../packages/gateway-protocol/src/index.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { assertSessionSectionCountAlignment } from "../test-helpers/control-ui-session-section-layout.ts";
import { readTextTone } from "../test-helpers/rendered-colors.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import {
  createControlUiE2eSuite,
  expandCodingSection,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Codex native session catalog",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
const catalogGroupingStorageKey = "openclaw:sidebar:sessions:catalog-grouping";
const collapsedSessionSectionsStorageKey = "openclaw:sidebar:sessions:collapsed-sections";
const catalogMethods = ["chat.metadata", "chat.startup", "sessions.catalog.list"];
function makeNativeSession(
  threadId: string,
  name: string,
  extra: Partial<SessionCatalogSession> = {},
): SessionCatalogSession {
  return {
    threadId,
    name,
    status: "idle",
    archived: false,
    canContinue: true,
    canArchive: true,
    ...extra,
  };
}
function makeHost(
  hostId: string,
  label: string,
  sessions: SessionCatalogSession[],
  extra: Partial<SessionCatalogHost> = {},
): SessionCatalogHost {
  return { hostId, label, kind: "gateway", connected: true, sessions, ...extra };
}
function makeCatalog(
  id: string,
  label: string,
  hosts: SessionCatalogHost[],
  extra: Partial<SessionCatalog> = {},
) {
  return { id, label, capabilities: { continueSession: true, archive: true }, hosts, ...extra };
}
function liveSessions(key: string, displayName: string, updatedAt = Date.now(), extra = {}) {
  const model = { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" };
  return {
    count: 1,
    defaults: model,
    path: "",
    ts: updatedAt,
    sessions: [{ ...model, displayName, key, kind: "direct", totalTokens: 0, updatedAt, ...extra }],
  };
}

const projectLabel = (section: Locator, key: string) =>
  section
    .locator(`[data-session-catalog-project="${key}"] .sidebar-session-catalog-project__label`)
    .textContent();
function creator(id: string, label: string): SessionCatalogSession["createdActor"] {
  return { type: "human", id, identity: { type: "profile", id }, label };
}
function offlineHost(hostId: string, label: string) {
  return makeHost(hostId, label, [], {
    kind: "node",
    connected: false,
    error: { code: "NODE_OFFLINE", message: "Paired node is offline" },
  });
}
async function expectListItems(list: Locator, count: number) {
  expect(
    await list
      .locator(":scope > *")
      .evaluateAll((items) => items.map((item) => item.getAttribute("role"))),
  ).toEqual(Array(count).fill("listitem"));
}
async function chooseGrouping(section: Locator, page: Page, name: string) {
  await section.locator(".sidebar-recent-sessions__head").hover();
  await section.locator('[data-session-catalog-view-menu="codex"]').click();
  await page
    .getByRole("menuitemradio", { name })
    .evaluate((element) => (element as HTMLElement).click());
}
const readGrouping = (page: Page) =>
  page.evaluate((key) => localStorage.getItem(key), catalogGroupingStorageKey);

suite.define(() => {
  it("omits empty native session catalogs from the sidebar", async () => {
    const page = await suite.browser.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: catalogMethods,
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
            makeCatalog("codex", "Codex", [makeHost("gateway:codex", "Local Codex", [])]),
            makeCatalog("claude", "Claude Code", [makeHost("gateway:claude", "Local Claude", [])], {
              capabilities: { continueSession: true, archive: false },
            }),
          ],
        },
      },
    });

    await page.goto(`${suite.server.baseUrl}chat`);
    await gateway.waitForRequest("sessions.catalog.list");
    expect(await page.locator('[data-session-section="catalog:codex"]').count()).toBe(0);
    expect(await page.locator('[data-session-section="catalog:claude"]').count()).toBe(0);
    await page.close();
  });

  it("separates native catalogs from live Coding rows", async () => {
    const page = await suite.browser.newPage({
      deviceScaleFactor: 2,
      viewport: { height: 900, width: 1280 },
      colorScheme: "dark",
    });
    await page.addInitScript(
      (key) => localStorage.removeItem(key),
      collapsedSessionSectionsStorageKey,
    );
    await installMockGateway(page, {
      featureMethods: catalogMethods,
      methodResponses: {
        "sessions.list": liveSessions(
          "agent:main:startup-phases",
          "Understanding Startup Phases and Delays",
          Date.now(),
          {
            hasActiveRun: false,
            label: "Understanding Startup Phases and Delays",
            status: "done",
            worktree: {
              id: "startup-phases",
              branch: "startup-phases",
              repoRoot: "/workspace/openclaw",
            },
          },
        ),
        "sessions.catalog.list": {
          catalogs: [
            makeCatalog(
              "codex",
              "Codex Native Sessions with a Deliberately Long Provider Label",
              [
                makeHost("gateway:local", "Local Codex", [
                  makeNativeSession("thread-startup", "Trace startup labels to code paths", {
                    cwd: "/workspace/openclaw",
                  }),
                ]),
              ],
              { capabilities: { continueSession: true, archive: true, startTerminal: true } },
            ),
            makeCatalog(
              "claude",
              "Claude Code",
              [
                makeHost("gateway:claude", "Local Claude", [
                  makeNativeSession("thread-claude", "Review the provider catalog UI", {
                    cwd: "/workspace/openclaw",
                    canArchive: false,
                  }),
                ]),
              ],
              { capabilities: { continueSession: true, archive: false } },
            ),
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await expandCodingSection(page, true);
      const sessionGroups = page.locator(".sidebar-recent-sessions");
      const workSection = sessionGroups.locator(':scope > [data-session-section="work"]');
      const liveRows = workSection.locator(":scope > .sidebar-recent-sessions__list");
      const catalog = sessionGroups.locator(':scope > [data-session-section="catalog:codex"]');
      const claudeCatalog = sessionGroups.locator(
        ':scope > [data-session-section="catalog:claude"]',
      );
      for (const [section, provider] of [
        [catalog, "codex"],
        [claudeCatalog, "claude"],
      ] as const) {
        await section.waitFor({ state: "visible" });
        await expect
          .poll(() =>
            section
              .locator(".sidebar-session-catalog-provider-icon")
              .getAttribute("data-provider-icon"),
          )
          .toBe(provider);
      }
      const [liveRowsBox, catalogBox] = await Promise.all([
        liveRows.boundingBox(),
        catalog.boundingBox(),
      ]);
      expect([liveRowsBox, catalogBox]).not.toContain(null);
      const groupGap = await page.evaluate(() => {
        const sidebar = document.querySelector(".sidebar");
        return sidebar
          ? Number.parseInt(getComputedStyle(sidebar).getPropertyValue("--sidebar-group-gap"), 10)
          : Number.NaN;
      });
      expect(groupGap).toBeGreaterThan(0);
      expect(Math.round(catalogBox!.y - (liveRowsBox!.y + liveRowsBox!.height))).toBe(groupGap);
      await assertSessionSectionCountAlignment(page, ["work", "catalog:codex", "catalog:claude"]);
    } finally {
      await page.close();
    }
  });

  it("groups sessions by host and hides empty offline nodes", async () => {
    const page = await suite.browser.newPage({
      deviceScaleFactor: 2,
      colorScheme: "dark",
      viewport: { height: 1100, width: 1440 },
    });
    await page.addInitScript(
      ({ key, gatewayUrl }) =>
        localStorage.setItem(key, JSON.stringify({ gatewayUrl, theme: "knot", themeMode: "dark" })),
      {
        key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
        gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
      },
    );
    await installMockGateway(page, {
      featureMethods: catalogMethods,
      methodResponses: {
        "config.get": {
          config: { ui: { prefs: { theme: "knot", themeMode: "dark" } } },
          hash: "catalog-knot-dark",
        },
        "sessions.list": liveSessions(
          "agent:main:research",
          "Research thread",
          Date.parse("2026-07-29T06:00:00.000Z"),
          {
            hasActiveRun: false,
            label: "Research thread",
            status: "done",
          },
        ),
        "sessions.catalog.list": {
          catalogs: [
            makeCatalog("codex", "Codex", [
              makeHost("gateway:local", "Local Codex", [
                makeNativeSession("thread-local", "Local planning session", {
                  cwd: "/Users/dev/openclaw",
                  createdActor: creator("profile-ada", "Ada"),
                }),
                makeNativeSession("thread-worktree", "Worktree fix session", {
                  cwd: "/Users/dev/openclaw/.claude/worktrees/fix-1",
                  createdActor: creator("profile-zoe", "Zoe"),
                }),
                makeNativeSession("thread-other", "Other project session", {
                  cwd: "/Users/dev/other",
                }),
              ]),
              offlineHost("node:offline-a", "Offline Workstation"),
              makeHost(
                "node:build",
                "Build Node",
                [makeNativeSession("thread-remote", "Remote review session")],
                { kind: "node" },
              ),
              offlineHost("node:offline-b", "Offline Laptop"),
            ]),
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await expandCodingSection(page);
      const section = page.locator('[data-session-section="catalog:codex"]');
      await section.waitFor({ state: "visible" });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const palette = document.getElementById("openclaw-theme-palette-knot");
            return (
              document.documentElement.dataset.theme === "openknot" &&
              document.documentElement.dataset.themeMode === "dark" &&
              palette instanceof HTMLLinkElement &&
              Boolean(palette.sheet)
            );
          }),
        )
        .toBe(true);
      await expect.poll(() => section.locator("[data-session-catalog-host]").count()).toBe(2);
      expect(await section.locator('[data-session-catalog-host="gateway:local"]').count()).toBe(1);
      expect(await section.locator('[data-session-catalog-host="node:build"]').count()).toBe(1);
      expect(await section.getByText("Offline Workstation", { exact: true }).count()).toBe(0);
      expect(await section.getByText("Offline Laptop", { exact: true }).count()).toBe(0);
      const localHost = section.locator('[data-session-catalog-host="gateway:local"]');
      const localHostList = localHost.locator(":scope > .sidebar-session-catalog-host__sessions");
      expect(await localHostList.getAttribute("role")).toBe("list");
      expect(await localHostList.getAttribute("aria-label")).toBe("Local Codex");
      const projectHeads = section.locator("[data-session-catalog-project]");
      await expect.poll(() => projectHeads.count()).toBe(2);
      await expectListItems(localHostList, 2);
      const openclawProject = section.locator(
        '[data-session-catalog-project="project:/Users/dev/openclaw"]',
      );
      const openclawProjectItem = openclawProject.locator("..");
      const openclawProjectList = openclawProjectItem.locator(":scope > [role=list]");
      expect(await openclawProjectItem.getAttribute("role")).toBe("listitem");
      expect(await openclawProjectList.getAttribute("aria-label")).toBe("Local Codex: openclaw");
      expect(
        await openclawProject.locator(".sidebar-session-catalog-project__label").textContent(),
      ).toBe("openclaw");
      expect(
        await openclawProject.locator(".sidebar-session-catalog-project__count").textContent(),
      ).toBe("2");
      const projectRows = section.locator(".sidebar-recent-session--catalog-project-child");
      await expect.poll(() => projectRows.count()).toBe(3);
      await expectListItems(openclawProjectList, 2);
      const buildHostList = section.locator(
        '[data-session-catalog-host="node:build"] > .sidebar-session-catalog-host__sessions',
      );
      expect(await buildHostList.getAttribute("aria-label")).toBe("Build Node");
      expect(await buildHostList.locator(":scope > [role=listitem]").count()).toBe(1);
      const threadRows = page.locator(
        '[data-session-section="ungrouped"] .sidebar-recent-session, [data-session-section="catalog:codex"] .sidebar-recent-session--catalog-project-child',
      );
      await expect.poll(() => threadRows.count()).toBe(4);
      expect(await threadRows.locator(".sidebar-recent-session__link[title]").count()).toBe(0);
      expect(
        await threadRows.evaluateAll(
          (rows) => new Set(rows.map((row) => row.getBoundingClientRect().height)).size,
        ),
      ).toBe(1);
      const tone = await readTextTone(
        openclawProject.locator(".sidebar-session-catalog-project__label"),
      );
      expect(tone.distanceToText).toBeLessThan(tone.distanceToMuted);
      expect(await projectLabel(section, "project:/Users/dev/other")).toBe("other");
      expect(await section.getByText("Worktree fix session", { exact: true }).count()).toBe(1);
      const toggle = section.locator(".sidebar-session-group-toggle");
      expect(await toggle.getAttribute("title")).toBeNull();
      expect(await section.locator(".sidebar-session-group-count").count()).toBe(0);

      await chooseGrouping(section, page, "None");
      await expect.poll(() => projectHeads.count()).toBe(0);
      expect(await section.locator("[data-session-key]").count()).toBe(4);
      await expectListItems(localHostList, 3);
      expect(await readGrouping(page)).toBe("none");

      await chooseGrouping(section, page, "Person");
      await expect.poll(() => projectHeads.count()).toBe(2);
      await expectListItems(localHostList, 3);
      expect(await projectLabel(section, "person:profile:profile-ada")).toBe("Ada");
      expect(await projectLabel(section, "person:profile:profile-zoe")).toBe("Zoe");
      expect(await readGrouping(page)).toBe("person");

      await chooseGrouping(section, page, "Project");
      await expect.poll(() => projectHeads.count()).toBe(2);
      expect(await readGrouping(page)).toBe("project");

      await openclawProject.click();
      await expect.poll(() => openclawProject.getAttribute("aria-expanded")).toBe("false");
      expect(await section.getByText("Local planning session", { exact: true }).count()).toBe(0);
      expect(await section.getByText("Worktree fix session", { exact: true }).count()).toBe(0);
      expect(await section.getByText("Other project session", { exact: true }).count()).toBe(1);
      expect(await openclawProject.count()).toBe(1);
      expect(
        await openclawProject.locator(".sidebar-session-catalog-project__count").textContent(),
      ).toBe("2");
      expect(
        await page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
          collapsedSessionSectionsStorageKey,
        ),
      ).toContain("catalog-project:codex:gateway:local:project:/Users/dev/openclaw");

      await openclawProject.click();
      await expect.poll(() => openclawProject.getAttribute("aria-expanded")).toBe("true");
      expect(await section.getByText("Local planning session", { exact: true }).count()).toBe(1);
      expect(await section.getByText("Worktree fix session", { exact: true }).count()).toBe(1);
      expect(
        await page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
          collapsedSessionSectionsStorageKey,
        ),
      ).not.toContain("catalog-project:codex:gateway:local:project:/Users/dev/openclaw");
    } finally {
      await page.close();
    }
  });

  it("shows a catalog Load More rejection without losing the retry cursor", async () => {
    const page = await suite.browser.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const gateway = await installMockGateway(page, {
      featureMethods: catalogMethods,
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
            makeCatalog("codex", "Codex", [
              makeHost(
                "gateway:codex",
                "Local Codex",
                [makeNativeSession("thread-1", "Newest session")],
                { nextCursor: "page-2" },
              ),
            ]),
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await expandCodingSection(page);
      await expect
        .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length)
        .toBe(1);
      const loadMore = page.locator('[data-session-catalog-load-more="codex"]');
      await loadMore.waitFor({ state: "visible" });
      await gateway.deferNext("sessions.catalog.list");
      await loadMore.click();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.catalog.list")).length)
        .toBe(2);
      await gateway.rejectDeferred("sessions.catalog.list", {
        code: "UNAVAILABLE",
        message: "Second catalog page unavailable",
      });

      const section = page.locator('[data-session-section="catalog:codex"]');
      await section.locator('[data-session-catalog-error="codex"]').waitFor({ state: "visible" });
      await expect
        .poll(() => section.locator(".sidebar-session-group-toggle").getAttribute("aria-label"))
        .toContain("Second catalog page unavailable");
      await expect.poll(() => loadMore.getAttribute("aria-busy")).toBe("false");
      expect(await loadMore.isEnabled()).toBe(true);
      expect(await page.getByText("Newest session", { exact: true }).count()).toBe(1);
      expect(pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  it("renders catalog records with ordinary tool cards and recorded outcomes", async () => {
    const command = `printf '%s' '${"long-command ".repeat(60)}'`;
    await suite.withPage({}, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...catalogMethods, "chat.message.get"],
        methodResponses: {
          "sessions.catalog.list": {
            catalogs: [
              makeCatalog("codex", "Codex", [
                makeHost("gateway:local", "Local Codex", [
                  makeNativeSession("preview", "External release check"),
                ]),
              ]),
            ],
          },
          "sessions.catalog.read": {
            hostId: "gateway:local",
            threadId: "preview",
            items: [
              {
                id: "answer",
                type: "agentMessage",
                text: 'The publication check failed.\n[embed ref="cv_external" /]',
              },
              {
                id: "patch",
                type: "toolResult",
                toolName: "apply_patch",
                toolCallId: "patch",
                isError: false,
                toolInput: {
                  changes: [
                    {
                      path: "/workspace/example.ts",
                      kind: { type: "update", move_path: null },
                      diff: `@@ -1 +1 @@\n-${"before ".repeat(100)}\n+${"after ".repeat(100)}\n`,
                    },
                  ],
                },
                text: "Updated example.ts",
              },
              {
                id: "text-only-failure",
                type: "toolResult",
                toolName: "custom",
                toolCallId: "text-only-failure",
                isError: true,
                text: '{"exitCode":7,"error":"reported failure"}',
              },
              {
                id: "unknown",
                type: "toolResult",
                toolName: "inventory.lookup",
                toolCallId: "unknown",
                toolInput: null,
                text: JSON.stringify({
                  kind: "canvas",
                  view: { id: "cv_external" },
                  error: "unverified",
                }),
              },
              {
                id: "quiet",
                raw: { result: null },
                type: "toolResult",
                toolName: "bash",
                toolCallId: "quiet",
                toolInput: { command },
                text: "",
                isError: false,
                exitCode: 0,
              },
              {
                id: "failed",
                type: "toolResult",
                toolName: "bash",
                toolCallId: "failed",
                toolInput: { command: "publish --check" },
                isError: true,
                exitCode: 17,
                truncated: true,
                text: JSON.stringify({
                  exitCode: 7,
                  error: `authentication required ${"x".repeat(600)}omitted-native-output`,
                }),
              },
              { id: "user", type: "userMessage", text: "Check the release artifacts." },
            ],
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await expandCodingSection(page);
      await page.getByText("External release check", { exact: true }).click();
      const pane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
      await browserExpect(pane.getByText(/The publication check failed/)).toBeVisible();
      await pane.locator(".chat-activity-group__summary").click();
      await browserExpect(pane.locator(".chat-tool-msg-summary")).toHaveCount(5);
      for (const summary of await pane
        .locator("button.chat-tool-msg-summary, .chat-tool-row__toggle")
        .all()) {
        await summary.click({ position: { x: 4, y: 4 } });
        await browserExpect(summary).toHaveAttribute("aria-expanded", "true");
      }
      await browserExpect(pane.locator(".chat-tool-card__outcome")).toHaveText([
        "Exit code 17",
        "Completed",
        "Outcome unknown",
        "failed",
        "Completed",
      ]);
      await browserExpect(pane.locator(".chat-tool-term__cmd").nth(1)).toHaveText(`$${command}`);
      await browserExpect(pane.locator(".chat-diff")).toHaveCount(1);
      expect((await pane.textContent())?.match(/\[Output truncated\]/g)).toHaveLength(1);
      await browserExpect(
        pane
          .locator(".chat-tool-msg-collapse")
          .nth(2)
          .locator(".chat-tool-card__block-content")
          .first(),
      ).toHaveText("null");
      await browserExpect(pane.locator(".chat-tool-msg-collapse").nth(1)).not.toContainText("null");
      await browserExpect(pane).not.toContainText("omitted-native-output");
      const thread = pane.locator(".chat-thread");
      await thread.hover({ position: { x: 20, y: 4 } });
      await page.mouse.wheel(0, await thread.evaluate((element) => element.scrollHeight));
      await waitForChatScrollIdle(page);
      await browserExpect(pane).toContainText('[embed ref="cv_external" /]');
      await browserExpect(pane.locator("mcp-app-view, iframe")).toHaveCount(0);
      await pane
        .getByRole("button", { name: "Open tool details in side panel", exact: true })
        .nth(2)
        .click();
      await browserExpect(page.locator(".chat-tool-output__text")).toContainText("unverified");
      expect(await gateway.getRequests("chat.message.get")).toEqual([]);
    });
  });

  it.each([
    {
      name: "supervision off",
      canArchive: true,
      reason: "Codex supervision is off. Enable it in plugin settings to continue this session.",
      settingsLinks: 1,
    },
    {
      name: "not continuable",
      canArchive: false,
      reason: "This external session source is view-only.",
      settingsLinks: 0,
    },
  ])("explains a view-only local Codex session ($name)", async (row) => {
    const { canArchive, reason } = row;
    const page = await suite.browser.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: catalogMethods,
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
            makeCatalog("codex", "Codex", [
              makeHost("gateway:local", "Local Codex", [
                makeNativeSession("thread-1", "Release checklist", {
                  source: "cli",
                  canContinue: false,
                  canArchive,
                }),
              ]),
            ]),
          ],
        },
        "sessions.catalog.read": {
          hostId: "gateway:local",
          threadId: "thread-1",
          items: [{ id: "u1", type: "userMessage", text: "prepare release" }],
        },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await expandCodingSection(page);
    await page.getByText("Release checklist", { exact: true }).click();
    const catalogPane = page
      .locator("openclaw-chat-pane.chat-pane-cache__pane--visible")
      .filter({ hasText: "prepare release" });
    await catalogPane.getByText("prepare release", { exact: true }).waitFor();
    await expect.poll(() => catalogPane.getByText(reason, { exact: true }).count()).toBe(1);
    expect(
      await catalogPane.locator(".agent-chat__composer-combobox > textarea").isDisabled(),
    ).toBe(true);
    expect(await gateway.getRequests("sessions.catalog.continue")).toHaveLength(0);
    const openSettings = catalogPane.getByRole("link", { name: "Open settings", exact: true });
    expect(await openSettings.count()).toBe(row.settingsLinks);
    if (row.settingsLinks) {
      await openSettings.click();
      await expect
        .poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`)
        .toBe("/settings/plugins/codex?view=settings");
    }
    await page.close();
  });
});
