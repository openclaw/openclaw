import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { SkillStatusEntry } from "../../api/types.ts";
import { installBrowserHistoryIsolation } from "../../test-helpers/browser-history.ts";
import { createSkill } from "../skills/view.test-support.ts";
import { renderAgentSkills } from "./panels-skills.ts";

installBrowserHistoryIsolation();

type Params = Parameters<typeof renderAgentSkills>[0];
function skillsParams(skills: SkillStatusEntry[], overrides: Partial<Params> = {}): Params {
  return {
    agentId: "main",
    canPatchConfig: true,
    canUpdateConfig: true,
    report: { workspaceDir: "/tmp/workspace", managedSkillsDir: "/tmp/skills", skills },
    loading: false,
    error: null,
    activeAgentId: "main",
    configForm: { agents: { entries: { main: {} } } },
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
    ...overrides,
  };
}

describe("agents skills panel (browser)", () => {
  it("shows matches from default-collapsed groups while filtering", async () => {
    const container = document.createElement("div");
    const params = skillsParams([
      createSkill({ name: "Unique Built In Match", source: "openclaw-bundled", bundled: true }),
      createSkill({ name: "Installed Distractor", source: "openclaw-managed" }),
    ]);
    render(renderAgentSkills(params), container);
    await Promise.resolve();
    expect(container.querySelector<HTMLDetailsElement>(".agent-skills-group")?.open).toBe(false);

    render(renderAgentSkills({ ...params, filter: "Unique Built In Match" }), container);
    await Promise.resolve();
    const filteredGroup = container.querySelector<HTMLDetailsElement>(".agent-skills-group");
    expect(container.textContent).toContain("1 shown");
    expect(filteredGroup?.open).toBe(true);
    expect(filteredGroup?.querySelector(".agent-skill-row")?.textContent).toContain(
      "Unique Built In Match",
    );
  });

  it.each(["inherited", "explicit without patch access"])(
    "gates clearing a %s allowlist separately from staged edits",
    async (mode) => {
      const inherited = mode === "inherited";
      const container = document.createElement("div");
      const skills = inherited
        ? [
            createSkill({ name: "github", source: "openclaw-managed" }),
            createSkill({
              name: "weather",
              source: "openclaw-managed",
              blockedByAgentFilter: true,
              modelVisible: false,
              commandVisible: false,
            }),
          ]
        : [];
      render(
        renderAgentSkills(
          skillsParams(skills, {
            canPatchConfig: inherited,
            configForm: {
              agents: inherited
                ? { defaults: { skills: ["github"] }, entries: { main: {} } }
                : { entries: { main: { skills: ["coding-agent"] } } },
            },
          }),
        ),
        container,
      );
      await Promise.resolve();
      if (inherited) {
        expect(container.querySelector(".callout.info")?.textContent).toContain(
          "inherits the default skill allowlist",
        );
        expect(
          Array.from(
            container.querySelectorAll<HTMLElement & { checked: boolean }>(
              ".agent-skill-row wa-switch",
            ),
          ).map((toggle) => toggle.checked),
        ).toEqual([true, false]);
      }
      const buttons = container.querySelectorAll<HTMLButtonElement>("button");
      expect(buttons[0]?.disabled).toBe(false);
      expect(buttons[1]?.disabled).toBe(true);
    },
  );

  it("explains an unsatisfied one-of binary requirement", async () => {
    const container = document.createElement("div");
    const requirements = {
      bins: [],
      anyBins: ["claude", "codex", "opencode"],
      env: [],
      config: [],
      os: [],
    };
    const skill = createSkill({
      name: "Coding Agent",
      source: "openclaw-bundled",
      bundled: true,
      eligible: false,
      modelVisible: false,
      commandVisible: false,
      requirements,
      missing: requirements,
      install: [{ id: "node-codex", kind: "node", label: "Install Codex CLI", bins: ["codex"] }],
    });
    render(renderAgentSkills(skillsParams([skill])), container);
    await Promise.resolve();
    expect(container.querySelector(".agent-skill-row")?.textContent).toContain(
      "bin:any of (claude, codex, opencode)",
    );
  });
});
