/** Tests /tools status output for compact and verbose tool inventory modes. */
import type { ChatCommandDefinition } from "openclaw/plugin-sdk/native-command-registry";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import * as commandsRegistry from "./commands-registry.js";
import { buildCommandsMessage, buildHelpMessage, buildToolsMessage } from "./status.js";

vi.mock("../plugins/commands.js", () => ({
  listPluginCommands: () => [],
}));

type InventoryTool = Parameters<typeof buildToolsMessage>[0]["groups"][number]["tools"][number];

function createToolFixture(
  id: string,
  label: string,
  description: string,
  overrides: Partial<InventoryTool> = {},
): InventoryTool {
  return { id, label, description, rawDescription: description, source: "core", ...overrides };
}

describe("tools product copy", () => {
  it("renders shipped SDK docks-category definitions without restoring docking commands", () => {
    const command: ChatCommandDefinition = {
      key: "saved-layout",
      description: "Inspect a saved layout.",
      textAliases: ["/saved-layout"],
      scope: "text",
      category: "docks",
    };
    const tool: ChatCommandDefinition = {
      key: "inspect-tool",
      description: "Inspect a tool.",
      textAliases: ["/inspect-tool"],
      scope: "text",
      category: "tools",
    };
    const commands = vi
      .spyOn(commandsRegistry, "listChatCommands")
      .mockReturnValue([command, tool]);
    try {
      const text = buildCommandsMessage();
      expect(text).toContain("Tools\n  /saved-layout [text] - Inspect a saved layout.");
      expect(text).toContain("  /inspect-tool [text] - Inspect a tool.");
      expect(text.match(/^Tools$/gm)).toHaveLength(1);
      expect(text).not.toContain("Docks");
    } finally {
      commands.mockRestore();
    }
  });

  it("mentions /tools in command discovery copy", () => {
    const cfg = {
      commands: { config: false, debug: false },
    } as unknown as OpenClawConfig;

    expect(buildCommandsMessage(cfg)).toContain("/tools - List available runtime tools.");
    expect(buildCommandsMessage(cfg)).toContain("More: /tools for available capabilities");
    expect(buildHelpMessage(cfg)).toContain("/tools for available capabilities");
    expect(buildHelpMessage(cfg)).not.toContain("/tasks");
  });

  it("formats built-in and plugin tools for end users", () => {
    const text = buildToolsMessage({
      agentId: "main",
      profile: "coding",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [
            createToolFixture("exec", "Exec", "Run shell commands"),
            createToolFixture("web_search", "Web Search", "Search the web"),
          ],
        },
        {
          id: "plugin",
          label: "Connected tools",
          source: "plugin",
          tools: [
            createToolFixture("docs_lookup", "Docs Lookup", "Search internal documentation", {
              source: "plugin",
              pluginId: "docs",
            }),
          ],
        },
      ],
    });

    expect(text).toContain("Available tools");
    expect(text).toContain("Profile: coding");
    expect(text).toContain("Built-in tools");
    expect(text).toContain("exec, web_search");
    expect(text).toContain("Connected tools");
    expect(text).toContain("docs_lookup (docs)");
    expect(text).toContain("Use /tools verbose for descriptions.");
    expect(text).not.toContain("unavailable right now");
  });

  it("renders effective tool inventory notices", () => {
    const text = buildToolsMessage({
      agentId: "main",
      profile: "coding",
      groups: [
        {
          id: "core",
          label: "Built-in tools",
          source: "core",
          tools: [createToolFixture("web_fetch", "Web Fetch", "Fetch web content")],
        },
      ],
      notices: [
        {
          id: "browser-filtered-by-profile",
          severity: "info",
          message:
            'Browser is configured, but the current tool profile does not include the browser tool. Add tools.alsoAllow: ["browser"].',
        },
      ],
    });

    expect(text).toContain("Notes");
    expect(text).toContain('Add tools.alsoAllow: ["browser"].');
  });

  it("keeps detailed descriptions in verbose mode", () => {
    const text = buildToolsMessage(
      {
        agentId: "main",
        profile: "minimal",
        groups: [
          {
            id: "core",
            label: "Built-in tools",
            source: "core",
            tools: [createToolFixture("exec", "Exec", "Run shell commands")],
          },
        ],
      },
      { verbose: true },
    );

    expect(text).toContain("What this agent can use right now:");
    expect(text).toContain("Profile: minimal");
    expect(text).toContain("Exec - Run shell commands");
    expect(text).toContain("Tool availability depends on this agent's configuration.");
    expect(text).not.toContain("unavailable right now");
  });

  it("trims verbose output before schema-like doc blocks", () => {
    const text = buildToolsMessage(
      {
        agentId: "main",
        profile: "coding",
        groups: [
          {
            id: "core",
            label: "Built-in tools",
            source: "core",
            tools: [
              {
                id: "cron",
                label: "Cron",
                description: "Schedule and manage cron jobs.",
                rawDescription:
                  'Manage Gateway cron jobs and send wake events. Use this for reminders, "check back later" requests, delayed follow-ups, and recurring tasks. Do not emulate scheduling with exec sleep or process polling.\n\nACTIONS:\n- status: Check cron scheduler status\nJOB SCHEMA:\n{ ... }',
                source: "core",
              },
            ],
          },
        ],
      },
      { verbose: true },
    );

    expect(text).toContain(
      'Cron - Manage Gateway cron jobs and send wake events. Use this for reminders, "check back later" requests, delayed follow-ups, and recurring tasks. Do not emulate scheduling with exec sleep or process polling.',
    );
    expect(text).not.toContain("ACTIONS:");
    expect(text).not.toContain("JOB SCHEMA:");
  });

  it("returns the empty state when no tools are available", () => {
    expect(
      buildToolsMessage({
        agentId: "main",
        profile: "full",
        groups: [],
      }),
    ).toBe("No tools are available for this agent right now.\n\nProfile: full");
  });
});
