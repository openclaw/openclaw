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
          registry: "https://clawhub.ai",
          displayName: "Remote Skill",
        },
      ],
    });

    expect(container.querySelector('input[name="skills-filter"]')).not.toBeNull();
    expect(container.querySelector("openclaw-agent-select")).toBeNull();
    expect(container.querySelector(".skills-group")?.textContent).toContain("Repo Skill");
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
      const container = createContainer();
      installDialogMethod("showModal", function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      });
      const onSaveKey = vi.fn();

      renderView(container, {
        detailKey: "repo-skill",
        edits: { "repo-skill": editValue },
        onSaveKey,
      });
      await Promise.resolve();

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

  it("renders skill groups as open collapsible sections with heading summaries", async () => {
    const container = createContainer();

    renderView(container);
    await Promise.resolve();

    const group = container.querySelector<HTMLDetailsElement>("details.skills-group");
    expect(expectDefined(group, "skill group details").open).toBe(true);
    const heading = group?.querySelector("summary h2.settings-section__heading");
    expect(normalizeText(expectDefined(heading, "group summary heading"))).toContain("1");
    expect(normalizeText(group!.querySelector(".settings-group .settings-row")!)).toContain(
      "Repo Skill",
    );
  });

  it.each([true, false])(
    "preserves retained group open=%s when an earlier group is filtered away",
    async (retainedOpen) => {
      const container = document.createElement("div");
      document.body.append(container);
      dialogRestores.push(() => container.remove());

      const workspaceSkill = createSkill({
        skillKey: "ws-skill",
        name: "Workspace Skill",
        source: "openclaw-workspace",
      });
      const builtInSkill = createSkill({
        skillKey: "bi-skill",
        name: "Weather",
        bundled: true,
      });
      const report: SkillStatusReport = {
        workspaceDir: "/tmp/workspace",
        managedSkillsDir: "/tmp/skills",
        skills: [workspaceSkill, builtInSkill],
      };

      const onDetailOpen = vi.fn();
      render(renderSkills(createProps({ report, onDetailOpen })), container);
      await Promise.resolve();

      const groups = container.querySelectorAll<HTMLDetailsElement>("details.skills-group");
      expect(groups).toHaveLength(2);
      expect(groups[0]!.open).toBe(true);
      expect(groups[1]!.open).toBe(true);

      groups[0]!.open = false;
      groups[1]!.open = retainedOpen;
      const row = groups[1]!.querySelector(".settings-row");

      render(renderSkills(createProps({ report, filter: "weather", onDetailOpen })), container);
      await Promise.resolve();

      const remaining = container.querySelectorAll<HTMLDetailsElement>("details.skills-group");
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.querySelector(".settings-row")?.textContent).toContain("Weather");
      expect(remaining[0]).toBe(groups[1]);
      expect(remaining[0]!.open).toBe(retainedOpen);
      expect(remaining[0]!.querySelector(".settings-row")).toBe(row);
      remaining[0]!.querySelector<HTMLButtonElement>(".plugins-item__detail-button")!.click();
      expect(onDetailOpen).toHaveBeenCalledExactlyOnceWith("bi-skill");
    },
  );

  it("preserves retained group expansion when a middle group is filtered away", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());

    const workspaceSkill = createSkill({
      skillKey: "ws-skill",
      name: "Keep Workspace",
      source: "openclaw-workspace",
    });
    const builtInSkill = createSkill({
      skillKey: "bi-skill",
      name: "Weather",
      bundled: true,
    });
    const installedSkill = createSkill({
      skillKey: "inst-skill",
      name: "Keep Installed",
      source: "openclaw-managed",
    });
    const report: SkillStatusReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [workspaceSkill, builtInSkill, installedSkill],
    };

    render(renderSkills(createProps({ report })), container);
    await Promise.resolve();

    const groups = container.querySelectorAll<HTMLDetailsElement>("details.skills-group");
    expect(groups).toHaveLength(3);
    groups[1]!.open = false;

    render(renderSkills(createProps({ report, filter: "keep" })), container);
    await Promise.resolve();

    const remaining = container.querySelectorAll<HTMLDetailsElement>("details.skills-group");
    expect(remaining).toHaveLength(2);
    expect(remaining[0]!.querySelector(".settings-row")?.textContent).toContain("Keep Workspace");
    expect(remaining[0]).toBe(groups[0]);
    expect(remaining[1]).toBe(groups[2]);
    expect(remaining[0]!.open).toBe(true);
    expect(remaining[1]!.open).toBe(true);
    expect(remaining[1]!.textContent).toContain("Keep Installed");
  });

  it("restores a removed group as initially open after filter is cleared", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());

    const workspaceSkill = createSkill({
      skillKey: "ws-skill",
      name: "Workspace Skill",
      source: "openclaw-workspace",
    });
    const builtInSkill = createSkill({
      skillKey: "bi-skill",
      name: "Weather",
      bundled: true,
    });
    const report: SkillStatusReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [workspaceSkill, builtInSkill],
    };

    render(renderSkills(createProps({ report })), container);
    await Promise.resolve();

    const groups = container.querySelectorAll<HTMLDetailsElement>("details.skills-group");
    groups[0]!.open = false;

    render(renderSkills(createProps({ report, filter: "weather" })), container);
    await Promise.resolve();

    expect(container.querySelectorAll("details.skills-group")).toHaveLength(1);

    render(renderSkills(createProps({ report })), container);
    await Promise.resolve();

    const restored = container.querySelectorAll<HTMLDetailsElement>("details.skills-group");
    expect(restored).toHaveLength(2);
    expect(restored[0]!.open).toBe(true);
    expect(restored[1]!.open).toBe(true);
  });

  it("preserves built-in group expansion when status filtering removes the workspace group", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());

    const workspaceSkill = createSkill({
      skillKey: "ws-skill",
      name: "Workspace Skill",
      source: "openclaw-workspace",
      blockedByAgentFilter: true,
    });
    const builtInSkill = createSkill({
      skillKey: "bi-skill",
      name: "Weather",
      bundled: true,
    });
    const report: SkillStatusReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [workspaceSkill, builtInSkill],
    };

    render(renderSkills(createProps({ report })), container);
    await Promise.resolve();

    const groups = container.querySelectorAll<HTMLDetailsElement>("details.skills-group");
    expect(groups).toHaveLength(2);
    groups[0]!.open = false;

    render(renderSkills(createProps({ report, statusFilter: "ready" })), container);
    await Promise.resolve();

    const remaining = container.querySelectorAll<HTMLDetailsElement>("details.skills-group");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.querySelector(".settings-row")?.textContent).toContain("Weather");
    expect(remaining[0]!.open).toBe(true);
  });

  it("recovers from empty filter results and restores groups as initially open", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());

    const workspaceSkill = createSkill({
      skillKey: "ws-skill",
      name: "Workspace Skill",
      source: "openclaw-workspace",
    });
    const builtInSkill = createSkill({
      skillKey: "bi-skill",
      name: "Weather",
      bundled: true,
    });
    const report: SkillStatusReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [workspaceSkill, builtInSkill],
    };

    render(renderSkills(createProps({ report })), container);
    await Promise.resolve();

    const groups = container.querySelectorAll<HTMLDetailsElement>("details.skills-group");
    groups[0]!.open = false;

    render(renderSkills(createProps({ report, filter: "zzzz-no-match" })), container);
    await Promise.resolve();

    expect(container.querySelectorAll("details.skills-group")).toHaveLength(0);

    render(renderSkills(createProps({ report })), container);
    await Promise.resolve();

    const restored = container.querySelectorAll<HTMLDetailsElement>("details.skills-group");
    expect(restored).toHaveLength(2);
    expect(restored[0]!.open).toBe(true);
    expect(restored[1]!.open).toBe(true);
  });

  it("preserves built-in group expansion when an earlier group is filtered away with retained query", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    dialogRestores.push(() => container.remove());

    const workspaceSkill = createSkill({
      skillKey: "ws-skill",
      name: "Workspace Skill",
      source: "openclaw-workspace",
    });
    const builtInSkill = createSkill({
      skillKey: "bi-skill",
      name: "Weather",
      bundled: true,
    });
    const report: SkillStatusReport = {
      workspaceDir: "/tmp/workspace",
      managedSkillsDir: "/tmp/skills",
      skills: [workspaceSkill, builtInSkill],
    };

    render(renderSkills(createProps({ report, filter: "skill" })), container);
    await Promise.resolve();

    const groups = container.querySelectorAll<HTMLDetailsElement>("details.skills-group");
    expect(groups).toHaveLength(2);
    groups[0]!.open = false;

    render(renderSkills(createProps({ report, filter: "weather" })), container);
    await Promise.resolve();

    const remaining = container.querySelectorAll<HTMLDetailsElement>("details.skills-group");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.querySelector(".settings-row")?.textContent).toContain("Weather");
    expect(remaining[0]!.open).toBe(true);
  });

  it("renders alternative missing binaries and exposes their installer", async () => {
    const container = createContainer();
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const onInstall = vi.fn();
    const skill = createCodingAgentSkill({
      eligible: false,
      install: [
        {
          id: "node-unrelated",
          kind: "node",
          label: "Install unrelated CLI",
          bins: ["unrelated"],
        },
        { id: "node-codex", kind: "node", label: "Install Codex CLI", bins: ["codex"] },
      ],
    });

    renderView(container, {
      report: skillReport([skill]),
      detailKey: "coding-agent",
      onInstall,
    });
    await Promise.resolve();

    const warning = container.querySelector(".skill-reader-dialog__body .callout");
    expect(normalizeText(expectDefined(warning, "alternative binary requirement"))).toContain(
      "bin:any of (claude, codex, opencode)",
    );
    const installButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => normalizeText(button) === "Install Codex CLI",
    );
    expect(installButton).toBeInstanceOf(HTMLButtonElement);
    installButton?.click();
    expect(onInstall).toHaveBeenCalledWith("coding-agent", "Coding Agent", "node-codex");
  });

  it("does not offer an installer that cannot satisfy a missing alternative", async () => {
    const container = createContainer();
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const skill = createCodingAgentSkill({
      eligible: false,
      install: [
        {
          id: "node-unrelated",
          kind: "node",
          label: "Install unrelated CLI",
          bins: ["unrelated"],
        },
      ],
    });

    renderView(container, {
      report: skillReport([skill]),
      detailKey: "coding-agent",
    });
    await Promise.resolve();

    expect(normalizeText(container)).toContain("bin:any of (claude, codex, opencode)");
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).some(
        (button) => normalizeText(button) === "Install unrelated CLI",
      ),
    ).toBe(false);
  });

  it("does not offer an installer once an alternative binary is present", async () => {
    const container = createContainer();
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const skill = createCodingAgentSkill({
      missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
      install: [{ id: "node-codex", kind: "node", label: "Install Codex CLI", bins: ["codex"] }],
    });

    renderView(container, {
      report: skillReport([skill]),
      detailKey: "coding-agent",
    });
    await Promise.resolve();

    expect(normalizeText(container)).not.toContain("bin:any of");
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).some(
        (button) => normalizeText(button) === "Install Codex CLI",
      ),
    ).toBe(false);
  });

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

  it("defers detail dialog opening until the dialog is connected", async () => {
    const container = document.createElement("div");
    const showModal = vi.fn(function (this: HTMLDialogElement) {
      expect(this.isConnected).toBe(true);
      this.setAttribute("open", "");
    });

    installDialogMethod("showModal", showModal);

    renderView(container, { detailKey: "repo-skill" });
    document.body.append(container);
    dialogRestores.push(() => container.remove());

    const { dialog } = await getRenderedModalDialog(container);

    expect(showModal).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBe(true);
  });
});
