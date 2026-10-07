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
    report: { workspaceDir: "/tmp/workspace", managedSkillsDir: "/tmp/skills", skills },
    loading: false,
    error: null,
    activeAgentId: "main",
    filter: "",
    onFilterChange: () => undefined,
    onRefresh: () => undefined,
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

  it("shows eligibility without obsolete agent allowlist toggles", async () => {
    const container = document.createElement("div");
    render(
      renderAgentSkills(
        skillsParams([
          createSkill({ name: "new-workshop-skill", source: "openclaw-workshop" }),
          createSkill({
            name: "disabled",
            disabled: true,
            eligible: false,
            modelVisible: false,
            commandVisible: false,
          }),
        ]),
      ),
      container,
    );
    await Promise.resolve();
    expect(container.textContent).toContain("otherwise-eligible skills");
    expect(container.textContent).toContain("new-workshop-skill");
    expect(container.textContent).toContain("disabled");
    expect(container.querySelector("wa-switch")).toBeNull();
    expect(
      Array.from(container.querySelectorAll("button"), (button) => button.textContent?.trim()),
    ).toEqual(["Refresh"]);
  });

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
