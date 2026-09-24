// Control UI tests cover the agents skills panel.
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { SkillStatusEntry } from "../../api/types.ts";
import { installBrowserHistoryIsolation } from "../../test-helpers/browser-history.ts";
import { renderAgentSkills } from "./panels-skills.ts";

installBrowserHistoryIsolation();

function createSkill(
  name: string,
  options: { source?: string; bundled?: boolean; blockedByAgentFilter?: boolean } = {},
): SkillStatusEntry {
  return {
    name,
    description: `${name} skill`,
    source: options.source ?? "openclaw-managed",
    bundled: options.bundled ?? false,
    filePath: `/tmp/skills/${name}/SKILL.md`,
    baseDir: `/tmp/skills/${name}`,
    skillKey: name,
    always: false,
    disabled: false,
    blockedByAllowlist: false,
    blockedByAgentFilter: options.blockedByAgentFilter ?? false,
    eligible: true,
    platformIncompatible: false,
    modelVisible: !options.blockedByAgentFilter,
    userInvocable: true,
    commandVisible: !options.blockedByAgentFilter,
    requirements: { bins: [], anyBins: [], env: [], config: [], os: [] },
    missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
    configChecks: [],
    install: [],
  };
}

describe("agents skills panel (browser)", () => {
  it("shows matches from default-collapsed groups while filtering", async () => {
    const container = document.createElement("div");
    const params: Parameters<typeof renderAgentSkills>[0] = {
      agentId: "main",
      canPatchConfig: true,
      canUpdateConfig: true,
      report: {
        workspaceDir: "/tmp/workspace",
        managedSkillsDir: "/tmp/skills",
        agentId: "main",
        skills: [
          createSkill("Unique Built In Match", {
            source: "openclaw-bundled",
            bundled: true,
          }),
          createSkill("Installed Distractor"),
        ],
      },
      loading: false,
      error: null,
      activeAgentId: "main",
      configForm: { agents: { entries: { main: { default: true } } } },
      configLoading: false,
      configSaving: false,
      configDirty: false,
      filter: "",
      onFilterChange: () => undefined,
      onRefresh: () => undefined,
      onToggle: () => undefined,
      onClear: () => undefined,
      onDisableAll: () => undefined,
      onConfigReload: () => undefined,
      onConfigSave: () => undefined,
    };

    render(renderAgentSkills(params), container);
    await Promise.resolve();
    const builtInGroup = container.querySelector<HTMLDetailsElement>(".agent-skills-group");
    expect(builtInGroup?.open).toBe(false);

    render(renderAgentSkills({ ...params, filter: "Unique Built In Match" }), container);
    await Promise.resolve();
    const filteredGroup = container.querySelector<HTMLDetailsElement>(".agent-skills-group");
    expect(container.textContent).toContain("1 shown");
    expect(filteredGroup?.open).toBe(true);
    expect(filteredGroup?.querySelector(".agent-skill-row")?.textContent).toContain(
      "Unique Built In Match",
    );
  });

  it("reflects an inherited default skill allowlist", async () => {
    const container = document.createElement("div");

    render(
      renderAgentSkills({
        agentId: "main",
        canPatchConfig: true,
        canUpdateConfig: true,
        report: {
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/skills",
          agentId: "main",
          agentSkillFilter: ["github"],
          skills: [createSkill("github"), createSkill("weather", { blockedByAgentFilter: true })],
        },
        loading: false,
        error: null,
        activeAgentId: "main",
        configForm: {
          agents: {
            defaults: { skills: ["github"] },
            entries: { main: { default: true } },
          },
        },
        configLoading: false,
        configSaving: false,
        configDirty: false,
        filter: "",
        onFilterChange: () => undefined,
        onRefresh: () => undefined,
        onToggle: () => undefined,
        onClear: () => undefined,
        onDisableAll: () => undefined,
        onConfigReload: () => undefined,
        onConfigSave: () => undefined,
      }),
      container,
    );
    await Promise.resolve();

    expect(container.querySelector(".callout.info")?.textContent).toContain(
      "inherits the default skill allowlist",
    );
    expect(
      Array.from(container.querySelectorAll<HTMLElement>(".agent-skill-row wa-switch")).map(
        (toggle) => (toggle as HTMLElement & { checked: boolean }).checked,
      ),
    ).toEqual([true, false]);
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons[0]?.disabled).toBe(false);
    expect(buttons[1]?.disabled).toBe(true);
  });

  it("gates allowlist clearing separately from staged config edits", async () => {
    const container = document.createElement("div");
    render(
      renderAgentSkills({
        agentId: "main",
        canPatchConfig: false,
        canUpdateConfig: true,
        report: {
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/skills",
          skills: [],
        },
        loading: false,
        error: null,
        activeAgentId: "main",
        configForm: { agents: { entries: { main: { skills: ["coding-agent"] } } } },
        configLoading: false,
        configSaving: false,
        configDirty: false,
        filter: "",
        onFilterChange: () => undefined,
        onRefresh: () => undefined,
        onToggle: () => undefined,
        onClear: () => undefined,
        onDisableAll: () => undefined,
        onConfigReload: () => undefined,
        onConfigSave: () => undefined,
      }),
      container,
    );
    await Promise.resolve();

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>("button"));
    expect(buttons[0]?.disabled).toBe(false);
    expect(buttons[1]?.disabled).toBe(true);
  });

  it("explains an unsatisfied one-of binary requirement", async () => {
    const container = document.createElement("div");
    const skill: SkillStatusEntry = {
      ...createSkill("coding-agent", { source: "openclaw-bundled", bundled: true }),
      name: "Coding Agent",
      description: "Delegate coding work to an available coding CLI.",
      eligible: false,
      modelVisible: false,
      commandVisible: false,
      requirements: {
        bins: [],
        anyBins: ["claude", "codex", "opencode"],
        env: [],
        config: [],
        os: [],
      },
      missing: {
        bins: [],
        anyBins: ["claude", "codex", "opencode"],
        env: [],
        config: [],
        os: [],
      },
      install: [{ id: "node-codex", kind: "node", label: "Install Codex CLI", bins: ["codex"] }],
    };

    render(
      renderAgentSkills({
        agentId: "main",
        canPatchConfig: true,
        canUpdateConfig: true,
        report: {
          workspaceDir: "/tmp/workspace",
          managedSkillsDir: "/tmp/skills",
          skills: [skill],
        },
        loading: false,
        error: null,
        activeAgentId: "main",
        configForm: { agents: { entries: { main: { default: true } } } },
        configLoading: false,
        configSaving: false,
        configDirty: false,
        filter: "",
        onFilterChange: () => undefined,
        onRefresh: () => undefined,
        onToggle: () => undefined,
        onClear: () => undefined,
        onDisableAll: () => undefined,
        onConfigReload: () => undefined,
        onConfigSave: () => undefined,
      }),
      container,
    );
    await Promise.resolve();

    expect(container.querySelector(".agent-skill-row")?.textContent).toContain(
      "bin:any of (claude, codex, opencode)",
    );
  });
});
