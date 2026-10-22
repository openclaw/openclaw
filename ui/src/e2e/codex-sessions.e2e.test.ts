import type { Locator, Page } from "playwright";
import { assert, expect, it } from "vitest";
import type {
  SessionCatalog,
  SessionCatalogHost,
  SessionCatalogSession,
  SessionsCatalogHostEvent,
} from "../../../packages/gateway-protocol/src/index.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  controlUiSessionPath,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { assertSessionSectionCountAlignment } from "../test-helpers/control-ui-session-section-layout.ts";
import { readTextTone } from "../test-helpers/rendered-colors.ts";
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

  it("shows a completed host while the aggregate catalog request is still pending", async () => {
    const page = await suite.browser.newPage({ viewport: { height: 900, width: 1280 } });
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.catalog.list"],
      featureMethods: catalogMethods,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const request = await gateway.waitForRequest("sessions.catalog.list");
      const progressId = (request.params as { progressId?: string })?.progressId;
      expect(progressId).toEqual(expect.any(String));
      assert(progressId, "catalog request did not opt in to progressive host events");
      await gateway.emitGatewayEvent("sessions.catalog.host", {
        progressId,
        agentId: "main",
        catalog: makeCatalog("codex", "Codex", [
          makeHost(
            "node:fast",
            "Fast Mac",
            [makeNativeSession("thread-fast", "Progressive node result", { canArchive: false })],
            { kind: "node", nodeId: "fast" },
          ),
        ]),
      } satisfies SessionsCatalogHostEvent);

      await expandCodingSection(page);
      await page.getByText("Progressive node result", { exact: true }).waitFor();
      expect((await gateway.getRequests("sessions.catalog.list")).length).toBe(1);

      await gateway.resolveDeferred("sessions.catalog.list", { catalogs: [] });
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
      ({ key, gatewayUrl, groupingKey, sectionsKey }) => {
        localStorage.removeItem(groupingKey);
        localStorage.removeItem(sectionsKey);
        localStorage.setItem(key, JSON.stringify({ gatewayUrl, theme: "knot", themeMode: "dark" }));
      },
      {
        groupingKey: catalogGroupingStorageKey,
        sectionsKey: collapsedSessionSectionsStorageKey,
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
          evaluateControlUiContext(page, (context) => {
            const theme = context.theme;
            const palette = document.getElementById("openclaw-theme-palette-knot");
            const root = document.documentElement.dataset;
            return {
              preferences: [theme.settings.theme, theme.mode, theme.resolvedMode],
              paletteReady: palette instanceof HTMLLinkElement && Boolean(palette.sheet),
              root: [root.theme, root.themeMode],
            };
          }),
        )
        .toEqual({
          preferences: ["knot", "dark", "dark"],
          paletteReady: true,
          root: ["openknot", "dark"],
        });
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
      const threadRowMetrics = await threadRows.evaluateAll((rows) =>
        rows.map((row) => {
          const link = row.querySelector(".sidebar-recent-session__link");
          const name = row.querySelector(".sidebar-recent-session__name");
          const rowStyle = getComputedStyle(row);
          const linkStyle = link ? getComputedStyle(link) : null;
          const nameStyle = name ? getComputedStyle(name) : null;
          return {
            height: row.getBoundingClientRect().height,
            minHeight: rowStyle.minHeight,
            nameFontSize: nameStyle?.fontSize ?? "",
            paddingBottom: linkStyle?.paddingBottom ?? "",
            paddingTop: linkStyle?.paddingTop ?? "",
            singleLine: row.classList.contains("sidebar-recent-session--single-line"),
          };
        }),
      );
      expect(threadRowMetrics).toHaveLength(4);
      // Native and Gateway rows must have the same one-line density.
      for (const metric of threadRowMetrics) {
        expect(metric).toMatchObject({
          singleLine: true,
          height: expect.closeTo(30, 1),
          minHeight: "30px",
          nameFontSize: "13px",
          paddingBottom: "4px",
          paddingTop: "4px",
        });
      }
      const projectLabelTone = await readTextTone(
        openclawProject.locator(".sidebar-session-catalog-project__label"),
      );
      expect(projectLabelTone.distanceToText).toBeLessThan(projectLabelTone.distanceToMuted);
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

  it("adopts from the native chat composer, navigates, and auto-sends", async () => {
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
        "sessions.catalog.continue": { sessionKey: "agent:main:adopted-codex" },
        "chat.send": { runId: "run-adopted", status: "started" },
      },
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await expandCodingSection(page);
    await page.getByText("Release checklist", { exact: true }).click();
    const catalogPane = page
      .locator("openclaw-chat-pane.chat-pane-cache__pane--visible")
      .filter({ hasText: "prepare release" });
    await catalogPane.getByText("prepare release", { exact: true }).waitFor();
    expect(
      (await gateway.getRequests("sessions.catalog.list")).every(
        (request) => (request.params as { agentId?: string } | undefined)?.agentId === "main",
      ),
    ).toBe(true);
    const target = {
      agentId: "main",
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "thread-1",
    };
    expect((await gateway.waitForRequest("sessions.catalog.read")).params).toMatchObject(target);
    const composer = catalogPane.locator(".agent-chat__composer-combobox > textarea");
    await composer.fill("continue with the final checks /status");
    expect(await catalogPane.locator('.slash-menu[role="listbox"]').count()).toBe(0);
    await gateway.setMethodResponse(
      "sessions.list",
      liveSessions("agent:main:adopted-codex", "Adopted Codex session"),
    );
    await composer.press("Enter");
    const continued = await gateway.waitForRequest("sessions.catalog.continue");
    expect(continued.params).toEqual(target);
    const sent = await gateway.waitForRequest("chat.send");
    expect(sent.params).toMatchObject({
      sessionKey: "agent:main:adopted-codex",
      message: "continue with the final checks /status",
    });
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe(controlUiSessionPath("agent:main:adopted-codex"));
    await page.close();
  });
});
