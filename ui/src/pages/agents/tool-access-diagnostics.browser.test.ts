import { assert, expect, it } from "vitest";
import { installBrowserHistoryIsolation } from "../../test-helpers/browser-history.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { createBaseParams, openToolGroups } from "./panels-tools-skills.test-support.ts";
import { AgentTools } from "./panels-tools-skills.tsx";

installBrowserHistoryIsolation();

it.each([false, true])("only verifies saved policy (configDirty=%s)", (configDirty) => {
  const label = configDirty ? "Old profile exclusion" : "Messaging profile";
  const source = "agents.entries.main.tools.profile";
  const profile = "messaging";
  const reasons = [{ kind: "profile" as const, label, source }];
  const params = createBaseParams({
    configDirty,
    configForm: {
      tools: { profile: "full" },
      agents: { entries: { main: { tools: { profile } } } },
    },
    effective: {
      agentId: "main",
      profile,
      groups: [],
      toolAccess: {
        checked: "live-session",
        profiles: [
          { profile: "full", source: "tools.profile", active: false },
          { profile, source, active: true },
        ],
        tools: [{ id: "exec", status: "excluded", reasons }],
      },
    },
  });
  const { container } = mountSolid(AgentTools, params);

  openToolGroups(container);
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
  for (const text of ["Session preview", source, "tools.profile", "Active"]) {
    expect(card.querySelector(".agent-tool-policy")?.textContent).toContain(text);
  }
});

it("keeps session-denied MCP entries out of the tool preview", () => {
  const id = "terminal__run";
  const tool = { id, label: id, description: id, source: "plugin" as const, defaultProfiles: [] };
  const deniedTool = {
    ...tool,
    source: "mcp" as const,
    rawDescription: tool.description,
    deniedBySession: true as const,
  };
  const { container } = mountSolid(
    AgentTools,
    createBaseParams({
      catalog: {
        agentId: "main",
        profiles: [],
        groups: [{ id: "terminal", label: "Terminal", source: "plugin", tools: [tool] }],
      },
      effective: {
        agentId: "main",
        profile: "full",
        groups: [{ id: "mcp", label: "MCP tools", source: "mcp", tools: [deniedTool] }],
      },
    }),
  );
  openToolGroups(container);
  const card = container.querySelector("#agent-tool-terminal__run");
  expect(card?.querySelector("summary")?.textContent).toContain("Off");
  expect(card?.textContent).toContain("Denied by this session’s tool restrictions.");
  expect(card?.textContent).not.toMatch(/Listed in preview via|Included in preview/);
  expect(container.querySelector(".agent-tools-runtime-chip")).toBeNull();
  expect(container.textContent).toContain("No tools are listed in this preview.");
});
