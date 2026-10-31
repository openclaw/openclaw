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
    "agentSkillsReport" | "agentSkillsRead" | "agentSkillsAgentId"
  >;
function skillsParams(skills: SkillStatusEntry[], overrides: Partial<Params> = {}): Params {
  const fixture = createAgentViewTestProps();
  return {
    ...fixture.agentSkills,
    onConfigReload: fixture.onConfigReload,
    onConfigSave: fixture.onConfigSave,
    readData() {
      return { ...fixture.readData(), ...this };
    },
    agentId: "main",
    canPatchConfig: true,
    canUpdateConfig: true,
    agentSkillsReport: { workspaceDir: "/tmp/workspace", managedSkillsDir: "/tmp/skills", skills },
    agentSkillsRead: null,
    agentSkillsAgentId: "main",
    configForm: { agents: { entries: { main: {} } } },
    configLoading: false,
    configSaving: false,
    configDirty: false,
    presentationRetired: Promise.withResolvers<void>().promise,
    ...overrides,
  };
}

function mountSkills(skills: SkillStatusEntry[], overrides: Partial<Params> = {}) {
  const params = skillsParams(skills, overrides);
  const view = mountSolid(AgentSkills, params);
  const container = view.container;
  const rows = () => [...container.querySelectorAll(".agent-skill-row")];
  return {
    ...view,
    params,
    rows,
    expectRows: (expected: (Element | undefined)[]) =>
      expected.forEach((row, index) => expect(rows()[index]).toBe(row)),
    filter: () => container.querySelector("input[name=agent-skills-filter]"),
    checked: () =>
      Array.from(
        container.querySelectorAll<HTMLInputElement>(".agent-skill-row input"),
        (input) => input.checked,
      ),
    button: (name: string) =>
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === name,
      )!,
    text: (present: string[], absent: string[] = []) =>
      waitForSolid(() => {
        for (const value of present) {
          expect(container.textContent).toContain(value);
        }
        for (const value of absent) {
          expect(container.textContent).not.toContain(value);
        }
      }),
  };
}

describe("agents skills panel (browser)", () => {
  it("retains cached skill rows and the search control when the initial read settles", async () => {
    const pending = deferred<SkillStatusReport>();
    const container = document.createElement("div");
    const params = skillsParams(
      [createSkill({ name: "Cached first" }), createSkill({ name: "Cached second" })],
      { agentSkillsRead: { agentId: "main", result: pending.promise } },
    );
    mountSolid(AgentSkills, params, container);
    await waitForSolid(() => {
      expect(container.querySelectorAll(".agent-skill-row")).toHaveLength(2);
      expect(container.textContent).toContain("Loading");
    });
    const rows = [...container.querySelectorAll(".agent-skill-row")];
    const filter = container.querySelector("input[name=agent-skills-filter]");

    pending.resolve(structuredClone(params.agentSkillsReport!));
    await waitForSolid(() => expect(container.textContent).not.toContain("Loading"));
    const currentRows = [...container.querySelectorAll(".agent-skill-row")];
    expect(currentRows).toHaveLength(rows.length);
    rows.forEach((row, index) => expect(currentRows[index]).toBe(row));
    expect(container.querySelector("input[name=agent-skills-filter]")).toBe(filter);
  });

  it("retains skill rows and diagnostics when a refresh returns new snapshots", async () => {
    const view = mountSkills([
      createSkill({
        name: "First skill",
        disabled: true,
        missing: {
          bins: ["synthetic-tool"],
          anyBins: ["claude", "codex", "opencode"],
          env: [],
          config: [],
          os: [],
        },
      }),
      createSkill({ name: "Second skill" }),
    ]);
    const { container, params } = view;
    await waitForSolid(() => {
      expect(container.querySelectorAll(".agent-skill-row")).toHaveLength(2);
      expect(container.textContent).not.toContain("Loading");
    });
    const rows = view.rows();
    expect(rows[0]!.textContent).toContain("bin:any of (claude, codex, opencode)");
    const diagnostics = [...rows[0]!.querySelectorAll(".settings-row__desc")];
    const filter = view.filter();
    const refreshed = deferred<SkillStatusReport>();
    view.update({
      ...params,
      agentSkillsRead: { agentId: "main", result: refreshed.promise },
    });
    await view.text(["Loading"]);
    expect(view.filter()).toBe(filter);
    view.expectRows(rows);

    const next = structuredClone(params.agentSkillsReport!);
    next.skills[0]!.description = "Updated description";
    next.skills.reverse();
    refreshed.resolve(next);
    await view.text(["Updated description"]);
    view.expectRows([rows[1], rows[0]]);
    const currentDiagnostics = rows[0]!.querySelectorAll(".settings-row__desc");
    expect(currentDiagnostics).toHaveLength(diagnostics.length);
    diagnostics.forEach((diagnostic, index) => expect(currentDiagnostics[index]).toBe(diagnostic));
    expect(view.filter()).toBe(filter);

    const resolved = structuredClone(next);
    resolved.skills[1]!.missing.bins = [];
    resolved.skills[1]!.missing.anyBins = [];
    resolved.skills[1]!.disabled = false;
    resolved.skills[0]!.missing.bins = ["new-tool"];
    const changed = deferred<SkillStatusReport>();
    view.update({ ...params, agentSkillsRead: { agentId: "main", result: changed.promise } });
    changed.resolve(resolved);
    await waitForSolid(() => expect(rows[1]!.textContent).toContain("new-tool"));
    expect(rows[0]!.textContent).not.toContain("synthetic-tool");
    view.expectRows([rows[1], rows[0]]);
  });

  it("shows inherited skills while resetting and restores the allowlist after rejection before retry", async () => {
    const first = deferred();
    const retry = deferred();
    const onClear = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    const view = mountSkills(
      [
        createSkill({ name: "github", source: "openclaw-managed" }),
        createSkill({ name: "weather", source: "openclaw-managed" }),
        createSkill({ name: "learned", source: "openclaw-workshop" }),
      ],
      {
        onClear,
        configForm: {
          agents: { defaults: { skills: ["github"] }, entries: { main: { skills: ["weather"] } } },
        },
      },
    );
    const { container, params, checked } = view;
    await waitForSolid(() => expect(checked()).toEqual([true, false, true]));
    const learned = view.rows().find((row) => row.textContent?.includes("learned"))!;
    expect(learned.querySelector("input")).toHaveProperty("disabled", true);
    expect(learned.textContent).toContain("archive in Workshop to hide");
    expect(container.textContent).toContain("2/3");
    const filter = view.filter();

    view.button("Reset").click();
    await waitForSolid(() => {
      expect(checked()).toEqual([true, true, false]);
      expect(container.textContent).toContain("Saving");
      expect(container.textContent).toContain("inherits the default skill allowlist");
    });
    first.reject(new Error("Reset was rejected."));
    await waitForSolid(() => {
      expect(container.textContent).toContain("Reset was rejected.");
      expect(checked()).toEqual([true, false, true]);
    });
    expect(view.filter()).toBe(filter);

    view.button("Reset").click();
    await waitForSolid(() => {
      expect(container.textContent).toContain("Saving");
      expect(container.textContent).not.toContain("Reset was rejected.");
    });
    view.update({
      ...params,
      configForm: { agents: { defaults: { skills: ["github"] }, entries: { main: {} } } },
    });
    retry.resolve();
    await waitForSolid(() => {
      expect(checked()).toEqual([true, true, false]);
      expect(container.textContent).not.toContain("Saving");
      expect(container.textContent).not.toContain("Reset was rejected.");
    });
    expect(onClear).toHaveBeenNthCalledWith(1, "main");
    expect(onClear).toHaveBeenNthCalledWith(2, "main");
    expect(view.filter()).toBe(filter);
  });

  it("keeps unavailable inventories distinct from empty results and retries through Refresh", async () => {
    const initial = deferred<SkillStatusReport>();
    const refreshed = deferred<SkillStatusReport>();
    const retried = deferred<SkillStatusReport>();
    const view = mountSkills([], {
      agentSkillsReport: null,
      agentSkillsAgentId: null,
      agentSkillsRead: { agentId: "main", result: initial.promise },
    });
    const { params } = view;
    await view.text(["Loading"], ["No skills found.", "0 shown"]);
    initial.reject(new Error("Initial skills failure"));
    const onRefresh = vi.fn(() =>
      view.update({
        ...params,
        agentSkillsRead: { agentId: "main", result: retried.promise },
        onRefresh,
      }),
    );
    view.update({ ...params, onRefresh });
    await view.text(["Initial skills failure"], ["No skills found.", "0 shown"]);
    view.button("Refresh").click();
    expect(onRefresh).toHaveBeenCalledOnce();
    await view.text(["Loading"], ["Initial skills failure", "No skills found.", "0 shown"]);
    const report = {
      workspaceDir: "/workspace/synthetic",
      managedSkillsDir: "/skills/synthetic",
      skills: [createSkill({ name: "Synthetic cached skill" })],
    };
    retried.resolve(report);
    await view.text(["Synthetic cached skill"], ["Initial skills failure", "No skills found."]);
    view.update({
      ...params,
      agentSkillsReport: report,
      agentSkillsAgentId: "main",
      agentSkillsRead: { agentId: "main", result: refreshed.promise },
    });
    await view.text(["Synthetic cached skill", "Loading"]);
    refreshed.reject(new Error("Synthetic skills failure"));
    await view.text(["Synthetic skills failure", "Synthetic cached skill"]);
    const empty = mountSkills([]);
    await empty.text(["0 shown", "No skills found."]);
  });

  it.each(["agent", "connection"])(
    "renders a replacement %s scope while the retired read stays pending",
    async (replacement) => {
      const retired = deferred<SkillStatusReport>();
      const current = deferred<SkillStatusReport>();
      const view = mountSkills([], {
        agentSkillsRead: { agentId: "main", result: retired.promise },
      });
      const { params } = view;
      await view.text(["Loading"]);
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
      await view.text(["Current scope skill"]);
      retired.reject(new Error("Retired scope failure"));
      await view.text(["Current scope skill"], ["Retired scope failure"]);
    },
  );

  it.each(["cached", "uncached"])(
    "settles an initially %s read when no report is returned",
    async (cacheState) => {
      const pending = deferred<SkillStatusReport | undefined>();
      const container = document.createElement("div");
      const cached = cacheState === "cached";
      const params = skillsParams([createSkill({ name: "Synthetic cached skill" })], {
        ...(!cached ? { agentSkillsReport: null, agentSkillsAgentId: null } : {}),
        agentSkillsRead: { agentId: "main", result: pending.promise },
      });
      mountSolid(AgentSkills, params, container);
      const button = (label: string) =>
        Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
          (element) => element.textContent === label,
        );
      await waitForSolid(() => {
        expect(button("Loading…")?.disabled).toBe(true);
        expect(container.querySelectorAll(".agent-skill-row")).toHaveLength(cached ? 1 : 0);
        expect(container.textContent).not.toContain("Load skills for this agent");
      });
      const rows = [...container.querySelectorAll(".agent-skill-row")];
      const filter = container.querySelector("input[name=agent-skills-filter]");

      pending.resolve(undefined);
      await waitForSolid(() => {
        expect(button("Loading…")).toBeUndefined();
        expect(button("Refresh")?.disabled).toBe(false);
        expect(container.querySelectorAll(".agent-skill-row")).toHaveLength(cached ? 1 : 0);
        if (cached) {
          expect(container.textContent).toContain("Synthetic cached skill");
        } else {
          expect(container.textContent).toContain("Load skills for this agent");
        }
      });
      const currentRows = [...container.querySelectorAll(".agent-skill-row")];
      rows.forEach((row, index) => expect(currentRows[index]).toBe(row));
      expect(container.querySelector("input[name=agent-skills-filter]")).toBe(filter);
    },
  );

  it("retains Unicode matching controls and restores raw skills after clearing", async () => {
    const view = mountSkills([
      createSkill({ name: "Cafe\u0301 match", source: "openclaw-bundled", bundled: true }),
      createSkill({ name: "Installed Distractor", source: "openclaw-managed" }),
    ]);
    const { container, params } = view;
    await waitForSolid(() =>
      expect(container.querySelector<HTMLDetailsElement>(".agent-skills-group")?.open).toBe(false),
    );
    const matchedRow = view.rows()[0]!;
    const matchedControl = matchedRow.querySelector("input");
    const filter = view.filter();

    view.update({ ...params, filter: "CAFÉ" });
    await waitForSolid(() => expect(view.rows()).toHaveLength(1));
    const filteredGroup = container.querySelector<HTMLDetailsElement>(".agent-skills-group");
    expect(filteredGroup?.open).toBe(true);
    expect(view.rows()[0]).toBe(matchedRow);
    expect(matchedRow.querySelector("input")).toBe(matchedControl);
    expect(container.textContent).not.toContain("Installed Distractor");

    view.update({ ...params, filter: "Cafe\u0301 match" });
    await waitForSolid(() => expect(container.textContent).toContain("1 shown"));
    expect(view.rows()[0]).toBe(matchedRow);
    expect(view.filter()).toBe(filter);

    view.update({ ...params, filter: "No matching skill" });
    await waitForSolid(() => expect(container.textContent).toContain("0 shown"));
    expect(view.rows()).toHaveLength(0);
    expect(container.querySelectorAll(".agent-skills-group")).toHaveLength(0);
    expect(view.filter()).toBe(filter);

    view.update({ ...params, filter: "" });
    await waitForSolid(() => expect(view.rows()).toHaveLength(2));
    expect(container.textContent).toContain("Cafe\u0301 match");
    expect(container.textContent).toContain("Installed Distractor");
    expect(view.checked()).toEqual([true, true]);
    expect(view.filter()).toBe(filter);
  });

  it.each(["initial", "agent", "connection"])(
    "only mounts matching controls when the %s scope starts filtered",
    async (scope) => {
      const view = mountSkills(
        [
          createSkill({ name: "Café skill", source: "openclaw-managed" }),
          createSkill({ name: "Unrelated skill", source: "openclaw-managed" }),
        ],
        { filter: scope === "initial" ? "Cafe\u0301" : "" },
      );
      const { container, params } = view;
      await waitForSolid(() => expect(view.rows()).toHaveLength(scope === "initial" ? 1 : 2));
      const oldRows = view.rows();
      const agentId = scope === "agent" ? "research" : "main";
      const filtered = {
        ...params,
        agentId,
        agentSkillsAgentId: agentId,
        filter: "Cafe\u0301",
        ...(scope === "connection"
          ? { readData: () => ({ ...params.readData(), requestGeneration: 1 }) }
          : {}),
      };
      view.update(filtered);
      await waitForSolid(() => {
        expect(view.rows()).toHaveLength(1);
        expect(container.querySelectorAll(".agent-skill-row input")).toHaveLength(1);
        expect(container.textContent).not.toContain("Unrelated skill");
      });
      if (scope !== "initial") {
        expect(oldRows.every((row) => !container.contains(row))).toBe(true);
      }

      view.update({ ...filtered, filter: "" });
      await waitForSolid(() => expect(view.rows()).toHaveLength(2));
      view.update(filtered);
      await waitForSolid(() => {
        expect(view.rows()).toHaveLength(1);
        expect(container.textContent).not.toContain("Unrelated skill");
      });
    },
  );

  it("retires optimistic reset presentation when the selected agent changes", async () => {
    const completion = deferred();
    const view = mountSkills([createSkill({ name: "github", source: "openclaw-managed" })], {
      configForm: { agents: { entries: { main: { skills: [] }, research: { skills: [] } } } },
      onClear: () => completion.promise,
    });
    const { container, params } = view;
    const checked = () =>
      container.querySelector<HTMLInputElement>(".agent-skill-row input")?.checked;
    view.button("Reset").click();
    await waitForSolid(() => expect(checked()).toBe(true));

    view.update({ ...params, agentId: "research", agentSkillsAgentId: "research" });
    await waitForSolid(() => {
      expect(checked()).toBe(false);
      expect(container.textContent).not.toContain("Saving");
    });
    completion.reject(new Error("Retired reset failed."));
    await completion.promise.catch(() => undefined);
    await waitForSolid(() => {
      expect(checked()).toBe(false);
      expect(container.textContent).not.toContain("Retired reset failed.");
    });
  });

  it.each(["inherited", "explicit without patch access"])(
    "gates clearing a %s allowlist separately from staged edits",
    async (mode) => {
      const inherited = mode === "inherited";
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
      const view = mountSkills(skills, {
        canPatchConfig: inherited,
        configForm: {
          agents: inherited
            ? { defaults: { skills: ["github"] }, entries: { main: {} } }
            : { entries: { main: { skills: ["coding-agent"] } } },
        },
      });
      const { container } = view;
      await view.text(["shown"]);
      if (inherited) {
        expect(container.querySelector(".callout.info")?.textContent).toContain(
          "inherits the default skill allowlist",
        );
        expect(view.checked()).toEqual([true, false]);
      }
      const buttons = container.querySelectorAll<HTMLButtonElement>("button");
      expect(buttons[0]?.disabled).toBe(false);
      expect(buttons[1]?.disabled).toBe(true);
    },
  );
});
