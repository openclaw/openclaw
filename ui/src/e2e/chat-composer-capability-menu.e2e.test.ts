// Control UI E2E coverage proves the composer capability menu against a mocked Gateway.
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite, tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI composer capability menu",
});

function skill(
  name: string,
  options: { blocked?: boolean; disabled?: boolean; missingDeps?: boolean } = {},
) {
  const missingBins = options.missingDeps ? ["missing-cli"] : [];
  return {
    name,
    description: `${name} skill`,
    source: "test",
    filePath: `/tmp/openclaw-e2e/skills/${name}/SKILL.md`,
    baseDir: `/tmp/openclaw-e2e/skills/${name}`,
    skillKey: name.toLowerCase(),
    always: false,
    disabled: options.disabled ?? false,
    blockedByAllowlist: options.blocked ?? false,
    eligible: missingBins.length === 0,
    requirements: { anyBins: [], bins: missingBins, env: [], config: [], os: [] },
    missing: { anyBins: [], bins: missingBins, env: [], config: [], os: [] },
    configChecks: [],
    install: [],
  };
}

function sessionsList(
  toolOverrides?: Record<string, unknown>,
  model: { id: string; provider: string } = { id: "gpt-5.5", provider: "openai" },
) {
  return {
    count: 1,
    defaults: { contextTokens: 200_000, model: model.id, modelProvider: model.provider },
    path: "",
    sessions: [
      {
        key: "agent:main:main",
        kind: "direct",
        model: model.id,
        modelProvider: model.provider,
        sessionId: "capability-menu-session",
        status: "done",
        updatedAt: Date.now(),
        ...(toolOverrides ? { toolOverrides } : {}),
      },
    ],
    ts: Date.now(),
  };
}

function configResponse(
  servers: Record<string, unknown>,
  webSearch = true,
  hash = "capability-menu-config",
) {
  const config = {
    mcp: { servers },
    plugins: webSearch
      ? {
          entries: { brave: { enabled: true, config: { webSearch: { apiKey: "redacted" } } } },
        }
      : undefined,
    tools: { web: { search: webSearch ? { provider: "brave" } : { enabled: false } } },
  };
  return {
    raw: JSON.stringify(config),
    hash,
    sourceConfig: config,
    runtimeConfig: config,
    config,
  };
}

function effectiveToolsResponse(serverName = "github") {
  const tool = (
    id: string,
    label: string,
    description: string,
    mcpToolName: string,
    mcpServer = serverName,
    deniedBySession?: boolean,
  ) => ({
    id,
    label,
    description,
    rawDescription: description,
    source: "mcp",
    mcpServer,
    mcpToolName,
    ...(deniedBySession ? { deniedBySession } : {}),
  });
  return {
    agentId: "main",
    profile: "full",
    groups: [
      {
        id: "mcp",
        label: "MCP",
        source: "mcp",
        tools: [
          tool("mcp_github_list_issues", "list_issues", "List issues", "list-issues"),
          tool("mcp_github_search_items_dash", "search_items", "Search items", "search-items"),
          tool(
            "mcp_github_search_items_underscore",
            "search_items",
            "Search items",
            "search_items",
            serverName,
            true,
          ),
          tool("mcp_notion_delete_page", "delete_page", "Delete a page", "delete_page", "notion"),
        ],
      },
    ],
  };
}

function undiscoveredMcpToolsResponse(serverName = "github") {
  return {
    agentId: "main",
    profile: "full",
    groups: [],
    notices: [
      {
        id: "mcp-not-yet-connected",
        severity: "info",
        message: `MCP servers "${serverName}" are configured but not connected for this session yet. MCP tools will appear here after an agent run discovers them.`,
        servers: [serverName],
      },
    ],
  };
}

async function latestToolOverrides(gateway: MockGatewayControls) {
  const requests = await gateway.getRequests("sessions.patch");
  return (requests.at(-1)?.params as { toolOverrides?: unknown } | undefined)?.toolOverrides;
}

function configPatchRaw(request: { params?: unknown }) {
  const params = request.params as { raw?: unknown } | undefined;
  if (typeof params?.raw !== "string") {
    throw new Error("Expected config.patch raw JSON");
  }
  return JSON.parse(params.raw) as Record<string, unknown>;
}

async function openMenu(page: Page) {
  const composer = page.locator(".agent-chat__input");
  const dropdown = composer.locator(".agent-chat__capability-menu");
  const skills = composer.getByRole("menuitem", { name: "Skills" });
  const isOpen = await dropdown.evaluate((node) => node.hasAttribute("open"));
  if (!isOpen) {
    await composer.getByRole("button", { name: "Add attachment" }).click();
  }
  await expect
    .poll(async () => {
      const open = await dropdown.evaluate((node) => node.hasAttribute("open"));
      return open && (await skills.isVisible());
    })
    .toBe(true);
  return composer;
}

function webSearchItem(menu: Locator) {
  return menu.locator('.oc-menu-item[data-value="toggle-web-search"]');
}

async function forceCapabilitySelection(item: Locator) {
  await item.evaluate(async (element) => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    // Drain the handler's microtasks and the mock Gateway's response task before checking writes.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  });
}

function skillsStatus(skills: ReturnType<typeof skill>[]) {
  return {
    workspaceDir: "/tmp/openclaw-e2e/workspace",
    managedSkillsDir: "/tmp/openclaw-e2e/skills",
    skills,
  };
}

async function expectView(menu: Locator, view: string) {
  await expect.poll(() => menu.getAttribute("data-view")).toBe(view);
}

async function expectChecked(item: Locator, checked: boolean) {
  await expect.poll(() => item.getAttribute("aria-checked") === "true").toBe(checked);
}

async function expectDisabled(item: Locator, disabled = true) {
  await expect.poll(() => item.isDisabled()).toBe(disabled);
}

async function expectVisible(item: Locator) {
  await expect.poll(() => item.isVisible()).toBe(true);
}

async function expectCount(item: Locator, count: number) {
  await expect.poll(() => item.count()).toBe(count);
}

suite.define(() => {
  it("renders the root stack, proxies attachments, patches sparse overrides, and clears the pill", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": configResponse({
            github: { url: "https://mcp.example.test", enabled: true },
            notion: { command: "notion-mcp", enabled: false },
          }),
          "sessions.list": sessionsList({
            mcpServers: { github: false },
            mcpToolsDeny: { notion: ["delete_page"] },
            skills: { docs: false },
            webSearch: false,
          }),
          "skills.status": skillsStatus([
            skill("Docs"),
            skill("Deploy", { disabled: true }),
            skill("Broken", { missingDeps: true }),
            skill("Private", { blocked: true }),
          ]),
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const attachTrigger = page.getByRole("button", { name: "Add attachment" });
      await expect
        .poll(() => attachTrigger.getAttribute("class"))
        .toContain("agent-chat__input-btn--has-overrides");

      let composer = await openMenu(page);
      const dropdown = composer.locator(".agent-chat__capability-menu");
      await expectView(dropdown, "root");
      await expect
        .poll(() => dropdown.getByRole("menuitem").allTextContents())
        .toEqual(
          expect.arrayContaining([
            expect.stringContaining("Take photo"),
            expect.stringContaining("Photo"),
            expect.stringContaining("File"),
            expect.stringContaining("Skills"),
            expect.stringContaining("Connectors"),
            expect.stringContaining("Manage plugins"),
          ]),
        );
      const clearOverrides = dropdown.getByRole("menuitem", { name: /4 overrides/ });
      await expectVisible(clearOverrides);
      await expectVisible(webSearchItem(dropdown));
      const skillsRoot = dropdown.getByRole("menuitem", { name: /^Skills/ });
      await skillsRoot.focus();
      await skillsRoot.evaluate((item) => {
        item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await expectView(dropdown, "skills");
      await dropdown.getByRole("menuitem", { name: "Back" }).click();
      await expectView(dropdown, "root");
      await expect
        .poll(() => dropdown.locator(".oc-menu-item:focus").textContent())
        .toContain("Take photo");
      await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>(".agent-chat__file-input");
        if (!input) {
          throw new Error("file input missing");
        }
        input.click = () => {
          input.dataset.proxied = "true";
        };
      });
      await dropdown.getByRole("menuitem", { name: "File", exact: true }).click();
      await expect
        .poll(() => page.locator(".agent-chat__file-input").getAttribute("data-proxied"))
        .toBe("true");

      composer = await openMenu(page);
      const reopenedMenu = composer.locator(".agent-chat__capability-menu");
      await reopenedMenu.locator('.oc-menu-item[data-value="clear-overrides"]').click();
      await expect.poll(() => latestToolOverrides(gateway)).toEqual(null);
      await expect
        .poll(() => attachTrigger.getAttribute("class"))
        .not.toContain("agent-chat__input-btn--has-overrides");

      composer = await openMenu(page);
      const menu = composer.locator(".agent-chat__capability-menu");
      await menu.getByRole("menuitem", { name: /^Skills/ }).click();
      await expectView(menu, "skills");
      const docs = menu.getByRole("menuitemcheckbox", { name: /^Docs/ });
      const broken = menu.getByRole("menuitemcheckbox", { name: /Broken.*deps missing/ });
      const blocked = menu.getByRole("menuitemcheckbox", {
        name: /Private.*not available for this agent/,
      });
      await expectDisabled(broken, true);
      await expectDisabled(blocked, true);
      await docs.click();
      await expect.poll(() => latestToolOverrides(gateway)).toEqual({ skills: { docs: false } });
      await docs.click();
      await expect.poll(() => latestToolOverrides(gateway)).toEqual({});

      await menu.getByRole("menuitem", { name: "Back" }).click();
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await expectView(menu, "connectors");
      const github = menu.getByRole("menuitemcheckbox", { name: /^github/ });
      await github.click();
      await expect
        .poll(() => latestToolOverrides(gateway))
        .toEqual({
          mcpServers: { github: false },
        });
      await github.click();
      await expect.poll(() => latestToolOverrides(gateway)).toEqual({});
      await expectDisabled(menu.getByRole("menuitem", { name: /Add MCP server/ }), false);

      await menu.getByRole("menuitem", { name: "Back" }).click();
      const webSearch = webSearchItem(menu);
      await expectChecked(webSearch, true);
      await webSearchItem(menu).click();
      await expect.poll(() => latestToolOverrides(gateway)).toEqual({ webSearch: false });
      await expectChecked(webSearch, false);
      await webSearchItem(menu).click();
      await expect.poll(() => latestToolOverrides(gateway)).toEqual({});
      await expectChecked(webSearch, true);

      const patchCount = (await gateway.getRequests("sessions.patch")).length;
      await gateway.deferNext("sessions.patch");
      await webSearch.click();
      await gateway.waitForRequest("sessions.patch", { after: patchCount });
      await gateway.rejectDeferred("sessions.patch", {
        code: "UNAVAILABLE",
        message: "Web search preference could not be saved",
      });
      await page.getByText("Web search preference could not be saved", { exact: true }).waitFor();
      await expectDisabled(webSearch, false);
      expect(await webSearch.evaluate((node) => node.getAttribute("aria-checked") === "true")).toBe(
        true,
      );

      const themeBackgrounds: string[] = [];
      for (const mode of ["dark", "light"] as const) {
        themeBackgrounds.push(
          await menu.evaluate((node, nextMode) => {
            document.documentElement.dataset.themeMode = nextMode;
            const surface = node.querySelector(".oc-menu");
            return surface ? getComputedStyle(surface).backgroundColor : "";
          }, mode),
        );
      }
      expect(themeBackgrounds[0]).not.toBe("");
      expect(themeBackgrounds[1]).not.toBe("");
      expect(themeBackgrounds[0]).not.toBe(themeBackgrounds[1]);
    });
  });

  it("shows per-connector tool access and preserves raw MCP tool identity", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.patch", "tools.effective"],
        methodResponses: {
          "config.get": configResponse({
            github: { url: "https://mcp.example.test", enabled: true },
            notion: { command: "notion-mcp", enabled: true },
          }),
          "sessions.list": sessionsList({
            mcpToolsDeny: { github: ["search_items"] },
          }),
          "tools.effective": effectiveToolsResponse(),
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = await openMenu(page);
      const menu = composer.locator(".agent-chat__capability-menu");
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await menu.getByRole("menuitem", { name: "Tool access" }).first().click();
      await expectView(menu, "tools:github");
      await expectVisible(menu.getByText("2 of 3 tools on"));
      await expectCount(menu.getByRole("menuitemcheckbox", { name: "delete_page" }), 0);

      const toolRows = menu.locator('.oc-menu-item[data-value^="mcp-tool:"]');
      const rawToolNames = toolRows.locator(
        ".agent-chat__capability-menu-label > span:first-child",
      );
      await expect
        .poll(() => rawToolNames.allTextContents())
        .toEqual(["list-issues", "search-items", "search_items"]);
      await expect
        .poll(async () => [
          await rawToolNames.nth(1).isVisible(),
          await rawToolNames.nth(2).isVisible(),
        ])
        .toEqual([true, true]);
      await expectChecked(toolRows.nth(2), false);

      await gateway.deferNext("tools.effective");
      await gateway.setSessionsListResponse(
        sessionsList(
          { mcpToolsDeny: { github: ["search_items"] } },
          { id: "gpt-5.6", provider: "openai" },
        ),
      );
      await gateway.emitGatewayEvent("sessions.changed", { sessionKey: "agent:main:main" });
      await expect.poll(async () => (await gateway.getRequests("tools.effective")).length).toBe(2);
      await expectVisible(menu.getByText("Loading tools…"));
      await gateway.resolveDeferred("tools.effective", effectiveToolsResponse());
      await expect
        .poll(() => rawToolNames.allTextContents())
        .toEqual(["list-issues", "search-items", "search_items"]);

      await toolRows.nth(1).click();
      await expect
        .poll(() => latestToolOverrides(gateway))
        .toEqual({ mcpToolsDeny: { github: ["search-items", "search_items"] } });
      await expectView(menu, "tools:github");

      await menu.getByRole("menuitem", { name: "Back" }).click();
      await expectView(menu, "connectors");
    });
  });

  it('renders tool access for a server named "constructor"', async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "tools.effective"],
        methodResponses: {
          "config.get": configResponse({
            constructor: { url: "https://mcp.example.test", enabled: true },
          }),
          "sessions.list": sessionsList({
            mcpToolsDeny: { github: ["search_items"] },
          }),
          "tools.effective": effectiveToolsResponse("constructor"),
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = await openMenu(page);
      const menu = composer.locator(".agent-chat__capability-menu");
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await menu.getByRole("menuitem", { name: "Tool access" }).click();

      await expectView(menu, "tools:constructor");
      await expectVisible(menu.getByText("3 of 3 tools on"));
      await expectCount(menu.locator('.oc-menu-item[data-value^="mcp-tool:"]'), 3);
    });
  });

  it("scopes effective-tools discovery notices to their connector", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "tools.effective"],
        methodResponses: {
          "config.get": configResponse({
            github: { url: "https://mcp.example.test", enabled: true },
            notion: { command: "notion-mcp", enabled: true },
          }),
          "sessions.list": sessionsList(),
          "tools.effective": undiscoveredMcpToolsResponse(),
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = await openMenu(page);
      const menu = composer.locator(".agent-chat__capability-menu");
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await menu.getByRole("menuitem", { name: "Tool access" }).first().click();

      await expectView(menu, "tools:github");
      await expect
        .poll(() =>
          menu
            .getByText("MCP tools will appear here after an agent run discovers them.")
            .isVisible(),
        )
        .toBe(true);
      await expectCount(menu.getByText("No tools available for this connector."), 0);
      await expectCount(menu.getByText("0 of 0 tools on"), 0);

      await menu.getByRole("menuitem", { name: "Back" }).click();
      await menu.getByRole("menuitem", { name: "Tool access" }).nth(1).click();
      await expectView(menu, "tools:notion");
      await expect
        .poll(() =>
          menu.getByText("MCP tools will appear here after an agent run discovers them.").count(),
        )
        .toBe(0);
      await expectVisible(menu.getByText("No tools available for this connector."));
      await expectCount(menu.getByText("0 of 0 tools on"), 0);
    });
  });

  it("blocks tool mutations until the session, runtime config, and catalog are ready", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.patch", "tools.effective"],
        deferredMethods: ["tools.effective"],
        heldMethods: ["sessions.list"],
        methodResponses: {
          // Keep the session projection unavailable until the held list arrives.
          "chat.startup": { messages: [], sessionId: "session:agent:main:main" },
          "sessions.describe": { session: null },
          "config.get": configResponse({
            github: { url: "https://mcp.example.test", enabled: true },
          }),
          "tools.effective": effectiveToolsResponse(),
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("sessions.list");
      const composer = await openMenu(page);
      const menu = composer.locator(".agent-chat__capability-menu");
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await menu.getByRole("menuitem", { name: "Tool access" }).click();
      await gateway.waitForRequest("tools.effective");
      await expectVisible(menu.getByText("Loading tools…"));
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);

      await gateway.resolveDeferred("tools.effective", effectiveToolsResponse());
      const listIssues = menu.locator('.oc-menu-item[data-value="mcp-tool:list-issues"]');
      await expectDisabled(listIssues, true);
      await expect.poll(() => tooltipTitleText(listIssues)).toBe("Loading…");
      await listIssues.evaluate((item) => {
        item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);

      await gateway.resolveDeferred("sessions.list", sessionsList());
      await expectView(menu, "tools:github");
      await menu.getByRole("menuitem", { name: "Back" }).click();
      await menu.getByRole("menuitem", { name: "Tool access" }).click();
      const readyListIssues = menu.locator('.oc-menu-item[data-value="mcp-tool:list-issues"]');
      await expectDisabled(readyListIssues, false);
      await readyListIssues.click();
      await expect
        .poll(() => latestToolOverrides(gateway))
        .toEqual({ mcpToolsDeny: { github: ["list-issues"] } });
    });
  });

  it.each([
    { name: "read-only", operatorScopes: ["operator.read"] },
    { name: "read-write", operatorScopes: ["operator.read", "operator.write"] },
  ])(
    "disables unavailable composer controls and capability mutations for a $name operator",
    async ({ operatorScopes }) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          operatorScopes,
          methodResponses: {
            "config.get": configResponse({ github: { url: "https://mcp.example.test" } }, false),
            "sessions.list": sessionsList({ webSearch: true }),
            "skills.status": skillsStatus([skill("Docs")]),
          },
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        if (!operatorScopes.includes("operator.write")) {
          const composer = page.locator(".agent-chat__input");
          const input = composer.locator("textarea");
          await input.waitFor();
          expect(await input.isDisabled()).toBe(true);
          expect(await composer.getByRole("button", { name: "Add attachment" }).isDisabled()).toBe(
            true,
          );
          expect(
            await composer.getByRole("button", { name: "Write a message to send." }).isDisabled(),
          ).toBe(true);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
          return;
        }
        const composer = await openMenu(page);
        const menu = composer.locator(".agent-chat__capability-menu");
        const clear = menu.locator('.oc-menu-item[data-value="clear-overrides"]');
        await expectDisabled(clear, true);
        await expect.poll(() => tooltipTitleText(clear)).toContain("operator.admin access");
        await expectDisabled(webSearchItem(menu), true);
        await expectChecked(webSearchItem(menu), false);
        await forceCapabilitySelection(webSearchItem(menu));
        await forceCapabilitySelection(clear);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        await menu.getByRole("menuitem", { name: /^Skills/ }).click();
        const docs = menu.getByRole("menuitemcheckbox", { name: /^Docs/ });
        await expectDisabled(docs, true);
        await expect.poll(() => tooltipTitleText(docs)).toContain("operator.admin access");
        // Leave disabled-row hints before the next click's hit test. Returning to
        // the root can put Web search under the pointer that clicked Back.
        await composer.locator("textarea").hover();
        await menu.getByRole("menuitem", { name: "Back" }).click();
        await composer.locator("textarea").hover();
        await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
        await expectDisabled(menu.getByRole("menuitemcheckbox", { name: /^github/ }), true);
        expect(await menu.getByRole("menuitem", { name: "Browse connectors" }).count()).toBe(0);
        const addServer = menu.getByRole("menuitem", { name: /Add MCP server/ });
        await expectDisabled(addServer, true);
        await expect.poll(() => tooltipTitleText(addServer)).toContain("Admin access");
      });
    },
  );

  it("blocks capability mutations until the session row and runtime config load", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const rosterMatch = { includeGlobal: true };
      const roster = sessionsList({
        mcpToolsDeny: { notion: ["delete_page"] },
        webSearch: true,
      });
      const gateway = await installMockGateway(page, {
        sessions: roster.sessions,
        heldMethods: ["sessions.list"],
        deferredMethods: ["config.get"],
        methodResponses: {
          // The held roster owns readiness; other projections must not expose the seeded row early.
          "chat.startup": { messages: [], sessionId: "capability-menu-session" },
          "sessions.describe": { session: null },
          "sessions.list": {
            cases: [
              { match: rosterMatch, response: roster },
              {
                match: { includeGlobal: false },
                response: { ...roster, count: 0, sessions: [] },
              },
            ],
          },
          "skills.status": skillsStatus([skill("Docs")]),
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await Promise.all([
        gateway.waitForRequest("sessions.list", { match: rosterMatch }),
        gateway.waitForRequest("config.get"),
      ]);
      const composer = await openMenu(page);
      const menu = composer.locator(".agent-chat__capability-menu");
      const webSearch = webSearchItem(menu);
      await expectDisabled(webSearch, true);
      await expect.poll(() => tooltipTitleText(webSearch)).toBe("Loading…");
      await webSearch.evaluate((item) => {
        item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);

      await gateway.resolveDeferred("sessions.list");
      await expectDisabled(webSearchItem(menu), true);
      await expect.poll(() => tooltipTitleText(webSearchItem(menu))).toBe("Loading…");
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);

      await gateway.setMethodResponse("config.get", configResponse({}, false));
      await gateway.resolveDeferred("config.get", configResponse({}, false));
      await expectDisabled(webSearchItem(menu), false);
      await expectChecked(webSearchItem(menu), false);
      await expect.poll(() => tooltipTitleText(webSearchItem(menu))).toContain("clear");
      await gateway.setOnline(false);
      await expectDisabled(webSearchItem(menu), true);
      await expect
        .poll(() => tooltipTitleText(webSearchItem(menu)))
        .toContain("Connect to the gateway");
      await forceCapabilitySelection(webSearchItem(menu));
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      await gateway.setOnline(true);
      await expectDisabled(webSearchItem(menu), false);
      await expect.poll(() => tooltipTitleText(webSearchItem(menu))).toContain("clear");
      await webSearchItem(menu).click();
      await expect
        .poll(() => latestToolOverrides(gateway))
        .toEqual({
          mcpToolsDeny: { notion: ["delete_page"] },
        });
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(1);
      await expectDisabled(webSearchItem(menu), true);
      expect(
        await webSearchItem(menu).evaluate((node) => node.getAttribute("aria-checked") === "true"),
      ).toBe(false);
    });
  });

  it.each([undefined, false])(
    "disables turning web search on when globally off (override: %s)",
    async (webSearchOverride) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const overrides = {
          skills: { docs: false },
          mcpServers: { github: false },
          ...(webSearchOverride === undefined ? {} : { webSearch: webSearchOverride }),
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": configResponse({}, false),
            "sessions.list": sessionsList(overrides),
            "skills.status": skillsStatus([]),
          },
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = await openMenu(page);
        const menu = composer.locator(".agent-chat__capability-menu");
        const webSearch = webSearchItem(menu);
        await expectDisabled(webSearch, true);
        await expectChecked(webSearch, false);
        await expect.poll(() => tooltipTitleText(webSearch)).toContain("tools.web.search.enabled");
        await forceCapabilitySelection(webSearch);
        expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
        expect(
          await webSearch.evaluate((node) => node.getAttribute("aria-checked") === "true"),
        ).toBe(false);
      });
    },
  );

  it("shows empty skills and connector states", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "config.get": configResponse({}, false),
          "sessions.list": sessionsList(),
          "skills.status": skillsStatus([]),
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = await openMenu(page);
      const menu = composer.locator(".agent-chat__capability-menu");
      await expectCount(webSearchItem(menu), 1);
      await menu.getByRole("menuitem", { name: /^Skills/ }).click();
      await expectVisible(menu.getByText("No skills available."));
      await menu.getByRole("menuitem", { name: "Back" }).click();
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await expectVisible(menu.getByText("No MCP servers configured."));
    });
  });

  it("validates and adds MCP servers for session and everywhere scopes", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": configResponse({}, false),
          "sessions.list": sessionsList({ skills: { docs: false } }),
          "skills.status": skillsStatus([]),
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      let composer = await openMenu(page);
      let menu = composer.locator(".agent-chat__capability-menu");
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await menu.getByRole("menuitem", { name: /Add MCP server/ }).click();

      const dialog = page.getByRole("dialog", { name: "Add MCP server" });
      const modal = page.locator("openclaw-modal-dialog").filter({ hasText: "Add MCP server" });
      await expectVisible(dialog);
      const sessionScope = modal.getByRole("radio", { name: "This session", exact: true });
      await expect.poll(() => sessionScope.isChecked()).toBe(true);
      await modal.getByLabel("Name").fill("bad name");
      await modal.getByLabel("URL or command").fill("https://mcp.example.test");
      await modal.getByRole("button", { name: "Add server" }).click();
      await expect
        .poll(() => modal.getByRole("alert").textContent())
        .toContain("Server names use letters");
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);

      await modal.getByLabel("Name").fill("session-docs");
      await modal.getByLabel("URL or command").fill("ftp://mcp.example.test");
      await modal.getByRole("button", { name: "Add server" }).click();
      await expect
        .poll(() => modal.getByRole("alert").textContent())
        .toContain("Enter a URL for HTTP transports");
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);

      await modal.getByLabel("URL or command").fill("https://session.example.test/mcp");
      await gateway.deferNext("config.patch");
      await modal.getByRole("button", { name: "Add server" }).click();
      const sessionConfigPatch = await gateway.waitForRequest("config.patch");
      expect(configPatchRaw(sessionConfigPatch)).toEqual({
        mcp: {
          servers: {
            "session-docs": {
              enabled: false,
              transport: "streamable-http",
              url: "https://session.example.test/mcp",
            },
          },
        },
      });
      const afterSessionAdd = configResponse(
        {
          "session-docs": {
            enabled: false,
            transport: "streamable-http",
            url: "https://session.example.test/mcp",
          },
        },
        false,
        "capability-menu-config-1",
      );
      await gateway.setMethodResponse("config.get", afterSessionAdd);
      await gateway.resolveDeferred("config.patch", { ok: true, ...afterSessionAdd });
      await expect
        .poll(() => latestToolOverrides(gateway))
        .toEqual({ mcpServers: { "session-docs": true }, skills: { docs: false } });
      await expectCount(modal, 0);

      composer = await openMenu(page);
      menu = composer.locator(".agent-chat__capability-menu");
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await expect
        .poll(() =>
          menu.getByRole("menuitemcheckbox", { name: /session-docs.*session/ }).isVisible(),
        )
        .toBe(true);
      await menu.getByRole("menuitem", { name: /Add MCP server/ }).click();

      const everywhereDialog = page
        .locator("openclaw-modal-dialog")
        .filter({ hasText: "Add MCP server" });
      await everywhereDialog.getByRole("radio", { name: "Everywhere", exact: true }).check();
      await everywhereDialog.getByLabel("Name").fill("global-docs");
      await everywhereDialog.getByLabel("URL or command").fill("docs-mcp --stdio");
      await everywhereDialog.getByLabel("Transport").selectOption("stdio");
      const sessionPatchCount = (await gateway.getRequests("sessions.patch")).length;
      // Pin past the session-scoped config.patch above so a slow runner can't
      // return it stale for the everywhere-scoped save.
      const configPatchesBeforeEverywhereAdd = (await gateway.getRequests("config.patch")).length;
      await gateway.deferNext("config.patch");
      await everywhereDialog.getByRole("button", { name: "Add server" }).click();
      const everywhereConfigPatch = await gateway.waitForRequest("config.patch", {
        after: configPatchesBeforeEverywhereAdd,
      });
      expect(configPatchRaw(everywhereConfigPatch)).toEqual({
        mcp: {
          servers: {
            "global-docs": { args: ["--stdio"], command: "docs-mcp" },
          },
        },
      });
      const afterEverywhereAdd = configResponse(
        {
          "global-docs": { args: ["--stdio"], command: "docs-mcp" },
          "session-docs": {
            enabled: false,
            transport: "streamable-http",
            url: "https://session.example.test/mcp",
          },
        },
        false,
        "capability-menu-config-2",
      );
      await gateway.setMethodResponse("config.get", afterEverywhereAdd);
      await gateway.resolveDeferred("config.patch", { ok: true, ...afterEverywhereAdd });
      await expectCount(everywhereDialog, 0);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(sessionPatchCount);

      composer = await openMenu(page);
      menu = composer.locator(".agent-chat__capability-menu");
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await expect
        .poll(() =>
          menu.getByRole("menuitemcheckbox", { name: /^global-docs.*Enabled/ }).isVisible(),
        )
        .toBe(true);
    });
  });
});
