import { describe, expect, it, vi } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { SkillStatusEntry, SkillStatusReport } from "../../api/types.ts";
import { installBrowserHistoryIsolation } from "../../test-helpers/browser-history.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createSkill } from "../skills/view.test-support.ts";
import { createAgentViewTestProps } from "./agents-view.test-helpers.ts";
import { AgentSkills } from "./panels-skills.tsx";

installBrowserHistoryIsolation();

type Params = Parameters<typeof AgentSkills>[0] &
  Pick<
    ReturnType<Parameters<typeof AgentSkills>[0]["readData"]>,
    "agentSkillsReport" | "agentSkillsRead" | "agentSkillsUpdateError" | "agentSkillsAgentId"
  >;
function skillsParams(skills: SkillStatusEntry[], overrides: Partial<Params> = {}): Params {
  return {
    readData() {
      return { ...createAgentViewTestProps().readData(), ...this };
    },
    agentId: "main",
    canPatchConfig: true,
    canUpdateConfig: true,
    agentSkillsReport: { workspaceDir: "/tmp/workspace", managedSkillsDir: "/tmp/skills", skills },
    agentSkillsRead: null,
    agentSkillsUpdateError: null,
    agentSkillsAgentId: "main",
    configForm: { agents: { entries: { main: {} } } },
    configLoading: false,
    configSaving: false,
    configDirty: false,
    filter: "",
    onFilterChange: () => undefined,
    onRefresh: () => undefined,
    onToggle: () => false,
    onClear: () => undefined,
    onDisableAll: () => false,
    onConfigReload: () => undefined,
    onConfigSave: () => undefined,
    ...overrides,
  };
}

describe("agents skills panel (browser)", () => {
  it.each(["Refresh", "owner receipt"])(
    "shows pending reads, keeps the cached report after failure, and retries through %s",
    async (retrySource) => {
      const initial = deferred<SkillStatusReport>();
      const refreshed = deferred<SkillStatusReport>();
      const retried = deferred<SkillStatusReport>();
      const container = document.createElement("div");
      const params = skillsParams([], {
        agentSkillsReport: null,
        agentSkillsAgentId: null,
        agentSkillsRead: { agentId: "main", result: initial.promise },
      });
      const view = mountSolid(AgentSkills, params, container);
      await waitForSolid(() => expect(container.textContent).toContain("Loading"));
      const report: SkillStatusReport = {
        workspaceDir: "/workspace/synthetic",
        managedSkillsDir: "/skills/synthetic",
        skills: [createSkill({ name: "Synthetic cached skill" })],
      };
      initial.resolve(report);
      await waitForSolid(() => expect(container.textContent).toContain("Synthetic cached skill"));

      const loaded = {
        ...params,
        agentSkillsReport: report,
        agentSkillsAgentId: "main",
        agentSkillsRead: { agentId: "main", result: refreshed.promise },
      };
      view.update(loaded);
      await waitForSolid(() => {
        expect(container.textContent).toContain("Synthetic cached skill");
        expect(container.textContent).toContain("Loading");
      });
      refreshed.reject(new Error("Synthetic skills failure"));
      const onRefresh = vi.fn(() => {
        view.update({
          ...loaded,
          agentSkillsRead: { agentId: "main", result: retried.promise },
          onRefresh,
        });
      });
      view.update({ ...loaded, onRefresh });
      await waitForSolid(() => {
        expect(container.textContent).toContain("Synthetic skills failure");
        expect(container.textContent).toContain("Synthetic cached skill");
      });
      const refresh = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => button.textContent?.includes("Refresh"),
      );
      if (retrySource === "Refresh") {
        refresh?.click();
      } else {
        onRefresh();
      }
      expect(onRefresh).toHaveBeenCalledOnce();
      await waitForSolid(() => {
        expect(container.textContent).not.toContain("Synthetic skills failure");
        expect(container.textContent).toContain("Loading");
        expect(container.textContent).toContain("Synthetic cached skill");
      });
      retried.resolve({ ...report, skills: [createSkill({ name: "Synthetic fresh skill" })] });
      await waitForSolid(() => {
        expect(container.textContent).toContain("Synthetic fresh skill");
        expect(container.textContent).not.toContain("Synthetic skills failure");
      });
    },
  );

  it.each(["agent", "connection"])(
    "renders a replacement %s scope while the retired read stays pending",
    async (replacement) => {
      const retired = deferred<SkillStatusReport>();
      const current = deferred<SkillStatusReport>();
      const container = document.createElement("div");
      const params = skillsParams([], {
        agentSkillsRead: { agentId: "main", result: retired.promise },
      });
      const view = mountSolid(AgentSkills, params, container);
      await waitForSolid(() => expect(container.textContent).toContain("Loading"));
      const agentId = replacement === "agent" ? "other" : "main";
      view.update({
        ...params,
        agentId,
        readData: () => ({
          ...params.readData(),
          requestGeneration: 1,
          agentSkillsAgentId: agentId,
          agentSkillsRead: { agentId, result: current.promise },
        }),
      });
      current.resolve({
        workspaceDir: "/workspace/synthetic",
        managedSkillsDir: "/skills/synthetic",
        skills: [createSkill({ name: "Current scope skill" })],
      });
      await waitForSolid(() => expect(container.textContent).toContain("Current scope skill"));
      retired.reject(new Error("Retired scope failure"));
      await waitForSolid(() => {
        expect(container.textContent).toContain("Current scope skill");
        expect(container.textContent).not.toContain("Retired scope failure");
      });
    },
  );

  it("keeps cached skills when a reload returns no report", async () => {
    const pending = deferred<SkillStatusReport | undefined>();
    const container = document.createElement("div");
    mountSolid(
      AgentSkills,
      skillsParams([createSkill({ name: "Synthetic cached skill" })], {
        agentSkillsRead: { agentId: "main", result: pending.promise },
      }),
      container,
    );
    await waitForSolid(() => expect(container.textContent).toContain("Loading"));
    pending.resolve(undefined);
    await waitForSolid(() => {
      expect(container.textContent).toContain("Synthetic cached skill");
      expect(container.textContent).not.toContain("Loading");
    });
  });

  it("shows matches from default-collapsed groups while filtering", async () => {
    const container = document.createElement("div");
    const params = skillsParams([
      createSkill({ name: "Unique Built In Match", source: "openclaw-bundled", bundled: true }),
      createSkill({ name: "Installed Distractor", source: "openclaw-managed" }),
    ]);
    const view = mountSolid(AgentSkills, params, container);
    await waitForSolid(() =>
      expect(container.querySelector<HTMLDetailsElement>(".agent-skills-group")?.open).toBe(false),
    );

    view.update({ ...params, filter: "Unique Built In Match" });
    await waitForSolid(() => expect(container.textContent).toContain("1 shown"));
    const filteredGroup = container.querySelector<HTMLDetailsElement>(".agent-skills-group");
    expect(container.textContent).toContain("1 shown");
    expect(filteredGroup?.open).toBe(true);
    expect(filteredGroup?.querySelector(".agent-skill-row")?.textContent).toContain(
      "Unique Built In Match",
    );
  });

  it("keeps learned Workshop skills on under an allowlist", async () => {
    const container = document.createElement("div");
    mountSolid(
      AgentSkills,
      skillsParams(
        [
          createSkill({ name: "github", source: "openclaw-managed" }),
          createSkill({ name: "budget", source: "openclaw-workshop" }),
        ],
        { configForm: { agents: { entries: { main: { skills: ["github"] } } } } },
      ),
      container,
    );
    await waitForSolid(() => expect(container.textContent).toContain("2/2"));

    const learnedRow = Array.from(container.querySelectorAll(".agent-skill-row")).find((row) =>
      row.textContent?.includes("budget"),
    );
    const toggle = learnedRow?.querySelector<HTMLInputElement>("input.settings-toggle__input");
    expect(toggle?.checked).toBe(true);
    expect(toggle?.disabled).toBe(true);
    expect(learnedRow?.textContent).toContain("archive in Workshop to hide");
    expect(container.textContent).toContain("2/2");
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
      mountSolid(
        AgentSkills,
        skillsParams(skills, {
          canPatchConfig: inherited,
          configForm: {
            agents: inherited
              ? { defaults: { skills: ["github"] }, entries: { main: {} } }
              : { entries: { main: { skills: ["coding-agent"] } } },
          },
        }),
        container,
      );
      await waitForSolid(() => expect(container.textContent).toContain("shown"));
      if (inherited) {
        expect(container.querySelector(".callout.info")?.textContent).toContain(
          "inherits the default skill allowlist",
        );
        expect(
          Array.from(
            container.querySelectorAll<HTMLInputElement>(
              ".agent-skill-row input.settings-toggle__input",
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
    mountSolid(AgentSkills, skillsParams([skill]), container);
    await waitForSolid(() =>
      expect(container.querySelector(".agent-skill-row")?.textContent).toContain(
        "bin:any of (claude, codex, opencode)",
      ),
    );
  });
});
