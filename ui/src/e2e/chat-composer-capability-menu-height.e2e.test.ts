import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiChatHistoryMessage } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  browserLaunchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
  name: "Control UI composer capability menu height",
});

function skill(index: number) {
  const name = `Skill ${String(index).padStart(2, "0")}`;
  return {
    name,
    description: `${name} skill`,
    source: "test",
    filePath: `/tmp/openclaw-e2e/skills/${name}/SKILL.md`,
    baseDir: `/tmp/openclaw-e2e/skills/${name}`,
    skillKey: name.toLowerCase().replaceAll(" ", "-"),
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    eligible: true,
    requirements: { anyBins: [], bins: [], env: [], config: [], os: [] },
    missing: { anyBins: [], bins: [], env: [], config: [], os: [] },
    configChecks: [],
    install: [],
  };
}

function sessionsList() {
  return {
    count: 1,
    defaults: { contextTokens: 200_000, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: [
      {
        key: "main",
        kind: "direct",
        model: "gpt-5.5",
        modelProvider: "openai",
        status: "done",
        updatedAt: Date.now(),
      },
    ],
    ts: Date.now(),
  };
}

function configResponse() {
  const servers = Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => [
      `connector-${String(index).padStart(2, "0")}`,
      { enabled: true, url: `https://connector-${index}.example.test` },
    ]),
  );
  const config = { mcp: { servers }, tools: { web: { search: { enabled: false } } } };
  return {
    raw: JSON.stringify(config),
    hash: "capability-menu-height-config",
    sourceConfig: config,
    runtimeConfig: config,
    config,
  };
}

function toolsEffectiveResponse() {
  return {
    agentId: "main",
    profile: "full",
    groups: [
      {
        id: "mcp",
        label: "MCP",
        source: "mcp",
        tools: Array.from({ length: 28 }, (_, index) => {
          const number = String(index + 1).padStart(2, "0");
          return {
            id: `mcp_connector_00_tool_${number}`,
            label: `Project tool ${number}`,
            description: `Operate on project resource ${number}`,
            rawDescription: `Operate on project resource ${number}`,
            source: "mcp",
            mcpServer: "connector-00",
            mcpToolName: `project-tool-${number}`,
          };
        }),
      },
    ],
  };
}

suite.define(() => {
  it("keeps long capability lists within the viewport and keyboard-focused rows visible", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.patch", "tools.effective"],
        historyMessages: [
          createControlUiChatHistoryMessage(
            "user",
            "Review the release dashboard and flag anything that needs attention.",
            Date.now() - 60_000,
          ),
          createControlUiChatHistoryMessage(
            "assistant",
            "The rollout is healthy. I found two follow-ups:\n\n- Confirm the mobile smoke lane\n- Review the connector permission changes",
            Date.now() - 30_000,
          ),
        ],
        methodResponses: {
          "config.get": configResponse(),
          "sessions.list": sessionsList(),
          "skills.status": {
            workspaceDir: "/tmp/openclaw-e2e/workspace",
            managedSkillsDir: "/tmp/openclaw-e2e/skills",
            skills: Array.from({ length: 36 }, (_, index) => skill(index + 1)),
          },
          "tools.effective": toolsEffectiveResponse(),
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("sessions.messages.subscribe");
      const composer = page.locator(".agent-chat__input");
      await expect.poll(() => composer.isVisible()).toBe(true);
      const dropdown = composer.locator(".agent-chat__capability-menu");
      const attach = composer.locator("button.agent-chat__input-btn--attach");
      await expect.poll(() => attach.isVisible()).toBe(true);
      await attach.click();
      await dropdown.locator('[data-value="open-skills"]').click();
      await expect.poll(() => dropdown.getAttribute("data-view")).toBe("skills");

      const panel = dropdown.locator(".oc-menu");
      const expectVisibleFocus = async (target: import("playwright").Locator) => {
        await expect
          .poll(() =>
            target.evaluate((node) => {
              const menu = node.closest<HTMLElement>(".oc-menu");
              if (!menu || document.activeElement !== node) {
                return false;
              }
              const bounds = menu.getBoundingClientRect();
              const row = node.getBoundingClientRect();
              return (
                bounds.top >= 0 &&
                bounds.bottom <= window.innerHeight &&
                row.top >= bounds.top &&
                row.bottom <= bounds.bottom
              );
            }),
          )
          .toBe(true);
      };
      const expectScrollable = async () => {
        await expect
          .poll(() =>
            panel.evaluate((node) => {
              const bounds = node.getBoundingClientRect();
              const inner = node.querySelector<HTMLElement>(".agent-chat__capability-menu-scroll");
              const scroll = inner && inner.scrollHeight > inner.clientHeight ? inner : node;
              return (
                bounds.height > 0 &&
                bounds.top >= 0 &&
                bounds.bottom <= window.innerHeight &&
                scroll.scrollHeight > scroll.clientHeight
              );
            }),
          )
          .toBe(true);
      };

      await expectScrollable();
      await dropdown.locator('[data-value="skill:skill-01"]').focus();
      for (let index = 1; index < 36; index += 1) {
        await page.keyboard.press("ArrowDown");
      }
      await expectVisibleFocus(dropdown.locator('[data-value="skill:skill-36"]'));

      await dropdown.locator('[data-value="back"]').click();
      await dropdown.locator('[data-value="open-connectors"]').click();
      await expect.poll(() => dropdown.getAttribute("data-view")).toBe("connectors");
      await expectScrollable();
      await dropdown.locator('[data-value="server:connector-00"]').focus();
      for (let index = 1; index < 24; index += 1) {
        await page.keyboard.press("ArrowDown");
      }
      await expectVisibleFocus(dropdown.locator('[data-value="server:connector-23"]'));

      await dropdown.locator('[data-value="server:connector-00"]').click();
      const tools = dropdown.locator('[data-value^="mcp-tool:"]');
      await expect.poll(() => tools.count()).toBe(28);
      await expectScrollable();
      await tools.first().focus();
      for (let index = 1; index < 28; index += 1) {
        await page.keyboard.press("ArrowDown");
      }
      await expectVisibleFocus(dropdown.locator('[data-value="mcp-tool:project-tool-28"]'));
    });
  });
});
