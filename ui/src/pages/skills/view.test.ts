/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillStatusReport } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { getRenderedModalDialog } from "../../test-helpers/modal-dialog.ts";
import {
  createDialogMethodInstaller,
  createProps,
  createSkill,
  normalizeText,
} from "./view.test-support.ts";
import { renderSkills } from "./view.ts";

const dialogRestores: Array<() => void> = [];
const installDialogMethod = createDialogMethodInstaller(dialogRestores);

function createContainer() {
  const container = document.createElement("div");
  document.body.append(container);
  dialogRestores.push(() => container.remove());
  return container;
}

function skillReport(skills: SkillStatusReport["skills"]): SkillStatusReport {
  return { workspaceDir: "/tmp/workspace", managedSkillsDir: "/tmp/skills", skills };
}

function createCodingAgentSkill(overrides: Parameters<typeof createSkill>[0] = {}) {
  const requirements = {
    bins: [],
    anyBins: ["claude", "codex", "opencode"],
    env: [],
    config: [],
    os: [],
  };
  return createSkill({
    skillKey: "coding-agent",
    name: "Coding Agent",
    requirements,
    missing: { ...requirements },
    ...overrides,
  });
}

function renderView(container: HTMLElement, overrides: Parameters<typeof createProps>[0] = {}) {
  render(renderSkills(createProps(overrides)), container);
}

describe("renderSkills", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    while (dialogRestores.length > 0) {
      dialogRestores.pop()?.();
    }
    await i18n.setLocale("en");
  });

  it("keeps settings focused on installed skills when remote results are available", () => {
    const container = document.createElement("div");
    renderView(container, {
      surface: "settings",
      clawhubResults: [
        {
          score: 1,
          slug: "remote-skill",
          installRef: "@fixture/remote-skill",
          registry: "https://clawhub.ai",
          displayName: "Remote Skill",
        },
      ],
    });

    expect(container.querySelector('input[name="skills-filter"]')).not.toBeNull();
    expect(container.querySelector("openclaw-agent-select")).toBeNull();
    const group = expectDefined(
      container.querySelector<HTMLDetailsElement>("details.skills-group"),
      "skill group details",
    );
    expect(group.open).toBe(true);
    expect(
      normalizeText(
        expectDefined(
          group.querySelector("summary h2.settings-section__heading"),
          "group summary heading",
        ),
      ),
    ).toContain("1");
    expect(
      normalizeText(
        expectDefined(group.querySelector(".settings-group .settings-row"), "skill row"),
      ),
    ).toContain("Repo Skill");
    expect(container.querySelector('input[name="clawhub-search"]')).toBeNull();
    expect(container.textContent).not.toContain("Remote Skill");
    expect(container.querySelector(".plugin-catalog-card")).toBeNull();
  });

  it.each([
    { editValue: "   ", disabled: true },
    { editValue: "  sk-test  ", disabled: false },
  ])(
    "only enables credential replacement for nonblank input: $editValue",
    async ({ editValue, disabled }) => {
      const container = document.createElement("div");
      const showModal = vi.fn(function (this: HTMLDialogElement) {
        expect(this.isConnected).toBe(true);
        this.setAttribute("open", "");
      });
      installDialogMethod("showModal", showModal);
      const onSaveKey = vi.fn();

      renderView(container, {
        detailKey: "repo-skill",
        edits: { "repo-skill": editValue },
        onSaveKey,
      });
      document.body.append(container);
      dialogRestores.push(() => container.remove());
      const { dialog } = await getRenderedModalDialog(container);
      expect(showModal).toHaveBeenCalledTimes(1);
      expect(dialog.open).toBe(true);

      const input = container.querySelector<HTMLInputElement>('input[type="password"]');
      const save = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) => normalizeText(button) === "Save key",
      );
      expect(input?.required).toBe(true);
      expect(normalizeText(expectDefined(input?.labels?.[0], "API key label"))).toBe(
        "API key (OPENAI_API_KEY)",
      );
      expect(save?.disabled).toBe(disabled);

      save?.click();

      if (disabled) {
        expect(onSaveKey).not.toHaveBeenCalled();
      } else {
        expect(onSaveKey).toHaveBeenCalledWith("repo-skill");
      }
    },
  );

  it("preserves retained group identity and restores removed groups when filtering", async () => {
    const container = createContainer();
    const report = skillReport([
      createSkill({ skillKey: "ws", name: "Workspace Skill", source: "openclaw-workspace" }),
      createSkill({ skillKey: "bi", name: "Weather", bundled: true }),
      createSkill({ skillKey: "inst", name: "Installed Skill", source: "openclaw-managed" }),
    ]);
    const onDetailOpen = vi.fn();
    renderView(container, { report, onDetailOpen });
    await Promise.resolve();
    const groups = [...container.querySelectorAll<HTMLDetailsElement>("details.skills-group")];
    expect(groups).toHaveLength(3);
    expect(groups.every((group) => group.open)).toBe(true);
    groups[0]!.open = false;
    const row = groups[1]!.querySelector(".settings-row");
    renderView(container, { report, filter: "weather", onDetailOpen });
    await Promise.resolve();
    const remaining = container.querySelectorAll<HTMLDetailsElement>("details.skills-group");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe(groups[1]);
    expect(remaining[0]!.open).toBe(true);
    expect(remaining[0]!.querySelector(".settings-row")).toBe(row);
    expect(remaining[0]!.textContent).toContain("Weather");
    remaining[0]!.querySelector<HTMLButtonElement>(".plugins-item__detail-button")!.click();
    expect(onDetailOpen).toHaveBeenCalledExactlyOnceWith("bi");
    renderView(container, { report });
    await Promise.resolve();
    const restored = [...container.querySelectorAll<HTMLDetailsElement>("details.skills-group")];
    expect(restored).toHaveLength(3);
    expect(restored.every((group) => group.open)).toBe(true);
  });

  it.each(["missing", "unrelated", "present"] as const)(
    "offers only an installer satisfying a missing alternative: %s",
    async (mode) => {
      const container = createContainer();
      installDialogMethod("showModal", function () {
        this.setAttribute("open", "");
      });
      const onInstall = vi.fn();
      const unrelated: SkillStatusReport["skills"][number]["install"][number] = {
        id: "node-unrelated",
        kind: "node",
        label: "Install unrelated CLI",
        bins: ["unrelated"],
      };
      const codex: SkillStatusReport["skills"][number]["install"][number] = {
        id: "node-codex",
        kind: "node",
        label: "Install Codex CLI",
        bins: ["codex"],
      };
      const skill = createCodingAgentSkill({
        eligible: mode === "present",
        ...(mode === "present"
          ? { missing: { bins: [], anyBins: [], env: [], config: [], os: [] } }
          : {}),
        install: mode === "unrelated" ? [unrelated] : [unrelated, codex],
      });
      renderView(container, { report: skillReport([skill]), detailKey: "coding-agent", onInstall });
      await Promise.resolve();
      const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
      expect(buttons.some((button) => normalizeText(button) === "Install unrelated CLI")).toBe(
        false,
      );
      const install = buttons.find((button) => normalizeText(button) === "Install Codex CLI");
      if (mode === "present") {
        expect(normalizeText(container)).not.toContain("bin:any of");
      } else {
        expect(
          normalizeText(
            expectDefined(
              container.querySelector(".skill-reader-dialog__body .callout"),
              "alternative binary requirement",
            ),
          ),
        ).toContain("bin:any of (claude, codex, opencode)");
      }
      if (mode === "missing") {
        expect(install).toBeInstanceOf(HTMLButtonElement);
        install!.click();
        expect(onInstall).toHaveBeenCalledWith("coding-agent", "Coding Agent", "node-codex");
      } else {
        expect(install).toBeUndefined();
        expect(onInstall).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps update and install permissions independent", async () => {
    const container = createContainer();
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const skill = createSkill({
      missing: { anyBins: [], bins: ["skill-cli"], env: [], config: [], os: [] },
      install: [{ id: "skill-cli", kind: "node", label: "Install skill-cli", bins: ["skill-cli"] }],
    });

    renderView(container, {
      canUpdate: false,
      canInstall: true,
      detailKey: skill.skillKey,
      report: skillReport([skill]),
    });
    await Promise.resolve();

    expect(
      container.querySelector<HTMLElement>("wa-switch.settings-toggle")?.hasAttribute("disabled"),
    ).toBe(true);
    const install = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => normalizeText(button) === "Install skill-cli",
    );
    expect(install?.disabled).toBe(false);
  });

  it("locks every skill mutation control behind the active mutation", async () => {
    const container = createContainer();
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const calendar = createSkill({
      skillKey: "calendar",
      name: "Calendar",
      missing: { anyBins: [], bins: ["calendar-cli"], env: [], config: [], os: [] },
      install: [
        { id: "calendar-cli", kind: "brew", label: "Install calendar-cli", bins: ["calendar-cli"] },
      ],
    });
    const report: SkillStatusReport = skillReport([createSkill(), calendar]);
    const onRefresh = vi.fn();
    const onToggle = vi.fn();
    const onSaveKey = vi.fn();
    const onInstall = vi.fn();
    const onClawHubInstall = vi.fn();

    const props = createProps({
      report,
      detailKey: "calendar",
      operation: { kind: "skill", skillKey: "repo-skill" },
      clawhubResults: [
        {
          score: 1,
          slug: "github",
          installRef: "@openclaw/github",
          registry: "https://clawhub.ai",
          displayName: "GitHub",
          version: "1.0.0",
        },
      ],
      onRefresh,
      onToggle,
      onSaveKey,
      onInstall,
      onClawHubInstall,
    });
    render(renderSkills(props), container);
    await Promise.resolve();

    const refresh = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Refresh",
    );
    expect(refresh?.disabled).toBe(true);
    expect(
      Array.from(
        container.querySelectorAll<HTMLElement & { disabled: boolean }>(
          "wa-switch.settings-toggle",
        ),
      ).every((toggle) => toggle.hasAttribute("disabled")),
    ).toBe(true);
    expect(container.querySelectorAll(".plugins-item wa-switch")).toHaveLength(0);
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.disabled).toBe(
      true,
    );
    const mutationButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((button) => /^(Install|Save key)/.test(normalizeText(button)));
    expect(mutationButtons).toHaveLength(2);
    expect(mutationButtons.every((button) => button.disabled)).toBe(true);

    refresh?.click();
    for (const toggle of container.querySelectorAll<HTMLElement>("wa-switch.settings-toggle")) {
      toggle.click();
    }
    for (const button of mutationButtons) {
      button.click();
    }
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
    expect(onSaveKey).not.toHaveBeenCalled();
    expect(onInstall).not.toHaveBeenCalled();

    render(renderSkills({ ...props, surface: "discovery" }), container);
    const remoteInstall = container.querySelector<HTMLButtonElement>(
      ".plugin-catalog-card__install",
    );
    expect(remoteInstall?.disabled).toBe(true);
    remoteInstall?.click();
    expect(onClawHubInstall).not.toHaveBeenCalled();
  });

  it("keeps the remaining skill's status and details target when a skill leaves the disabled tab", async () => {
    const container = createContainer();

    const passwordSkill = createSkill({ skillKey: "1password", name: "1Password", disabled: true });
    const appleNotesSkill = createSkill({
      skillKey: "apple-notes",
      name: "Apple Notes",
      disabled: true,
    });
    const report: SkillStatusReport = skillReport([passwordSkill, appleNotesSkill]);

    renderView(container, { report, statusFilter: "disabled" });
    await Promise.resolve();

    expect(container.querySelectorAll(".plugins-item [role=img]")).toHaveLength(2);

    const updatedReport: SkillStatusReport = skillReport([
      { ...passwordSkill, disabled: false },
      appleNotesSkill,
    ]);

    const onDetailOpen = vi.fn();
    renderView(container, { report: updatedReport, statusFilter: "disabled", onDetailOpen });
    await Promise.resolve();

    const row = container.querySelector(".plugins-item")!;
    expect(container.querySelectorAll(".plugins-item")).toHaveLength(1);
    expect(row.textContent).toContain("Apple Notes");
    expect(row.querySelector("[role=img]")?.getAttribute("title")).toContain("Disabled");
    row.querySelector<HTMLButtonElement>(".plugins-item__detail-button")!.click();
    expect(onDetailOpen).toHaveBeenCalledWith("apple-notes");
  });

  it("treats skills blocked by the selected agent filter as needing setup", async () => {
    const container = createContainer();
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const report: SkillStatusReport = skillReport([createSkill({ blockedByAgentFilter: true })]);

    renderView(container, { report, statusFilter: "ready" });
    await Promise.resolve();

    expect(container.querySelectorAll(".plugins-item")).toHaveLength(0);
    expect(normalizeText(container)).toContain("Ready 0");
    expect(normalizeText(container)).toContain("Needs Setup 1");

    renderView(container, { report, statusFilter: "needs-setup", detailKey: "repo-skill" });
    await Promise.resolve();

    expect(container.querySelector(".plugins-item .settings-status--warn")).not.toBeNull();
    expect(normalizeText(container)).toContain("Reason: blocked by agent filter");
    expect(
      Array.from(container.querySelectorAll(".chip")).map((chip) => normalizeText(chip)),
    ).toContain("blocked");
  });
});
