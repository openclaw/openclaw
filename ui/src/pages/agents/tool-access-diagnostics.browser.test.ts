import { assert, describe, expect, it } from "vitest";
import { installBrowserHistoryIsolation } from "../../test-helpers/browser-history.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { createBaseParams } from "./panels-tools-skills.test-support.ts";
import { AgentTools } from "./panels-tools-skills.tsx";

installBrowserHistoryIsolation();

describe("agent tool access diagnostics (browser)", () => {
  it.each([false, true])("only verifies saved policy (configDirty=%s)", (configDirty) => {
    const container = document.createElement("div");
    const label = configDirty ? "Old profile exclusion" : "Messaging profile";
    const params = createBaseParams({
      configDirty,
      configForm: {
        tools: { profile: "full" },
        agents: { entries: { main: { tools: { profile: "messaging" } } } },
      },
      toolsEffectiveResult: {
        agentId: "main",
        profile: "messaging",
        groups: [],
        toolAccess: {
          checked: "live-session",
          profiles: [
            { profile: "full", source: "tools.profile", active: false },
            { profile: "messaging", source: "agents.entries.main.tools.profile", active: true },
          ],
          tools: [
            {
              id: "exec",
              status: "excluded",
              reasons: [
                {
                  kind: "profile",
                  label,
                  source: "agents.entries.main.tools.profile",
                  profile: "messaging",
                },
              ],
            },
          ],
        },
      },
    });
    mountSolid(AgentTools, params, container);

    const card = container.querySelector<HTMLDetailsElement>("#agent-tool-exec");
    assert(card);
    expect(card.open).toBe(false);
    const summary = card.querySelector("summary");
    if (configDirty) {
      expect(summary?.textContent).toContain("Unverified");
      expect(card.textContent).not.toContain("Old profile exclusion");
      expect(card.textContent).toContain("Save your changes to refresh the preview.");
      return;
    }
    expect(summary?.textContent).toContain("Off");
    expect(summary?.textContent).toContain("Messaging profile");
    card.open = true;
    expect(card.querySelector(".agent-tool-policy")?.textContent).toContain("Session preview");
    expect(card.querySelector(".agent-tool-policy")?.textContent).toContain(
      "agents.entries.main.tools.profile",
    );
    expect(card.querySelector(".agent-tool-policy")?.textContent).toContain("tools.profile");
    expect(card.querySelector(".agent-tool-policy")?.textContent).toContain("Active");
  });

  it("keeps session-denied MCP entries out of the tool preview", () => {
    const container = document.createElement("div");
    const tool = {
      id: "terminal__run",
      label: "Terminal",
      description: "Run a terminal command",
      source: "plugin" as const,
      defaultProfiles: [],
    };
    mountSolid(
      AgentTools,
      createBaseParams({
        toolsCatalogResult: {
          agentId: "main",
          profiles: [],
          groups: [{ id: "terminal", label: "Terminal", source: "plugin", tools: [tool] }],
        },
        toolsEffectiveResult: {
          agentId: "main",
          profile: "full",
          groups: [
            {
              id: "mcp",
              label: "MCP tools",
              source: "mcp",
              tools: [
                {
                  ...tool,
                  source: "mcp",
                  rawDescription: tool.description,
                  deniedBySession: true,
                },
              ],
            },
          ],
        },
      }),
      container,
    );
    const card = container.querySelector("#agent-tool-terminal__run");
    expect(card?.querySelector("summary")?.textContent).toContain("Off");
    expect(card?.textContent).toContain("Denied by this session’s tool restrictions.");
    expect(card?.textContent).not.toContain("Listed in preview via");
    expect(card?.textContent).not.toContain("Included in preview");
    expect(container.querySelector(".agent-tools-runtime-chip")).toBeNull();
    expect(container.textContent).toContain("No tools are listed in this preview.");
  });
});
