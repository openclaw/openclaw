import { describe, expect, it } from "vitest";
import { configSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createSkill } from "../skills/view.test-support.ts";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { Agents } from "./view.tsx";

function skillsReadData() {
  return {
    ...createProps().readData(),
    agentsPanel: "skills" as const,
    agentSkillsAgentId: "beta",
    agentSkillsReport: {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [
        createSkill({ name: "github", source: "openclaw-managed" }),
        createSkill({ name: "weather", source: "openclaw-managed" }),
        createSkill({ name: "learned", source: "openclaw-workshop" }),
      ],
    },
  };
}

describe("agent skill policy", () => {
  it.each(["pending", "failed"])(
    "keeps skill policy unknown when the first config read is %s",
    async (status) => {
      const container = document.createElement("div");
      const props = { readData: skillsReadData };
      const view = mountSolid(
        Agents,
        createProps({
          ...props,
          config: {
            ...createProps().config,
            configLoading: status === "pending",
            lastError: status === "failed" ? "Config read failed" : null,
          },
        }),
        container,
      );
      await waitForSolid(() =>
        expect(container.querySelectorAll(".agent-skill-row")).toHaveLength(3),
      );
      const rows = [...container.querySelectorAll(".agent-skill-row")];
      const filter = container.querySelector("input[name=agent-skills-filter]");
      expect(filter).not.toBeNull();
      expect(container.textContent).not.toContain("All skills are enabled");
      expect(container.querySelector("#agent-panel .settings-section__desc .mono")).toBeNull();
      if (status === "failed") {
        expect(container.querySelector('[role="alert"]')?.textContent).toContain(
          "Config read failed",
        );
      }

      view.update(
        createProps({
          ...props,
          config: { ...createProps().config, configSnapshot: configSnapshot({}) },
        }),
      );
      await waitForSolid(() => expect(container.textContent).toContain("All skills are enabled"));
      expect(
        container.querySelector("#agent-panel .settings-section__desc .mono")?.textContent,
      ).toBe("3/3");
      const currentRows = container.querySelectorAll(".agent-skill-row");
      rows.forEach((row, index) => expect(currentRows[index]).toBe(row));
      expect(container.querySelector("input[name=agent-skills-filter]")).toBe(filter);
    },
  );

  it.each([
    {
      name: "unrestricted",
      agents: {},
      copy: "All skills are enabled",
      count: "3/3",
      github: true,
      weather: true,
    },
    {
      name: "inherited",
      agents: { defaults: { skills: ["github"] } },
      copy: "inherits the default skill allowlist",
      count: "2/3",
      github: true,
      weather: false,
    },
    {
      name: "custom",
      agents: { defaults: { skills: ["github"] }, entries: { beta: { skills: ["weather"] } } },
      copy: "uses a custom skill allowlist",
      count: "2/3",
      github: false,
      weather: true,
    },
    {
      name: "empty",
      agents: { defaults: { skills: ["github"] }, entries: { beta: { skills: [] } } },
      copy: "uses a custom skill allowlist",
      count: "1/3",
      github: false,
      weather: false,
    },
  ])(
    "retains known $name skill policy while config refreshes or saves",
    async ({ agents, copy, count, github, weather }) => {
      const container = document.createElement("div");
      const props = { readData: skillsReadData };
      const accepted = { ...createProps().config, configSnapshot: configSnapshot({ agents }) };
      const view = mountSolid(Agents, createProps({ ...props, config: accepted }), container);
      for (const busy of [{ configLoading: true }, { configSaving: true }]) {
        view.update(createProps({ ...props, config: { ...accepted, ...busy } }));
        await waitForSolid(() =>
          expect(container.querySelectorAll(".agent-skill-row")).toHaveLength(3),
        );
        expect(container.textContent).toContain(copy);
        expect(container.textContent).not.toContain("Load the gateway config");
        expect(
          container.querySelector("#agent-panel .settings-section__desc .mono")?.textContent,
        ).toBe(count);
        for (const [name, checked] of [
          ["github", github],
          ["weather", weather],
          ["learned", true],
        ] as const) {
          const toggle = container.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`);
          expect(toggle?.checked).toBe(checked);
          expect(toggle?.disabled).toBe(true);
        }
      }
    },
  );
});
