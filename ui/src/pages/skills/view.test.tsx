/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred as createDeferredRead, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { SkillStatusReport } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { clawhubVerdictKey, type ClawHubSkillSecurityVerdict } from "../../lib/skills/index.ts";
import { getRenderedModalDialog } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { cleanupSkillsViews, renderSkills } from "./view.solid.test-support.tsx";
import {
  createDialogMethodInstaller,
  createProps,
  createSkill,
  normalizeText,
} from "./view.test-support.ts";
import { Skills } from "./view.tsx";
afterEach(cleanupSkillsViews);

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
  renderSkills(createProps(overrides), container);
}

function createLinkedSkill(ownerHandle?: string) {
  return createSkill({
    skillKey: "agentreceipt",
    name: "AgentReceipt",
    clawhub: {
      status: "linked",
      valid: true,
      registry: "https://clawhub.ai",
      slug: "agentreceipt",
      ownerHandle,
      installedVersion: "1.2.3",
      installedAt: 123,
      originPath: "/tmp/.clawhub/origin.json",
      lockPath: "/tmp/workspace/.clawhub/lock.json",
    },
  });
}

describe("renderSkills", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    while (dialogRestores.length > 0) {
      dialogRestores.pop()?.();
    }
    await i18n.setLocale("en");
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
      const actions = container.querySelector(".skill-reader-dialog__actions");
      expect(save?.closest("openclaw-modal-actions")).toBe(actions);
      expect(actions?.parentElement?.lastElementChild).toBe(actions);
      expect(container.querySelector(".skill-reader-dialog__body")?.contains(save!)).toBe(false);

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

  it("offers only an installer satisfying a missing alternative", async () => {
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
      eligible: false,
      install: [unrelated, codex],
    });
    renderView(container, { report: skillReport([skill]), detailKey: "coding-agent", onInstall });
    await Promise.resolve();
    const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.some((button) => normalizeText(button) === "Install unrelated CLI")).toBe(false);
    const install = buttons.find((button) => normalizeText(button) === "Install Codex CLI");
    expect(
      normalizeText(
        expectDefined(
          container.querySelector(".skill-reader-dialog__body .callout"),
          "alternative binary requirement",
        ),
      ),
    ).toContain("bin:any of (claude, codex, opencode)");
    expect(install).toBeInstanceOf(HTMLButtonElement);
    expect(install?.closest("openclaw-modal-actions")?.parentElement?.lastElementChild).toBe(
      install?.closest("openclaw-modal-actions"),
    );
    install!.click();
    expect(onInstall).toHaveBeenCalledWith("coding-agent", "Coding Agent", "node-codex");
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
      toggleSavingSkillKey: skill.skillKey,
      detailKey: skill.skillKey,
      report: skillReport([skill]),
    });
    await Promise.resolve();

    expect(
      container.querySelector<HTMLInputElement>("input.settings-toggle__input")?.disabled,
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
    renderSkills(props, container);
    await Promise.resolve();

    const refresh = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent?.trim() === "Refresh",
    );
    expect(refresh?.disabled).toBe(true);
    expect(
      Array.from(
        container.querySelectorAll<HTMLInputElement>("input.settings-toggle__input"),
      ).every((toggle) => toggle.disabled),
    ).toBe(true);
    expect(container.querySelectorAll(".plugins-item input.settings-toggle__input")).toHaveLength(
      0,
    );
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.disabled).toBe(
      true,
    );
    const mutationButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    ).filter((button) => /^(Install|Save key)/.test(normalizeText(button)));
    expect(mutationButtons).toHaveLength(2);
    expect(mutationButtons.every((button) => button.disabled)).toBe(true);

    refresh?.click();
    for (const toggle of container.querySelectorAll<HTMLInputElement>(
      "input.settings-toggle__input",
    )) {
      toggle.click();
    }
    for (const button of mutationButtons) {
      button.click();
    }
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
    expect(onSaveKey).not.toHaveBeenCalled();
    expect(onInstall).not.toHaveBeenCalled();

    renderSkills({ ...props, surface: "discovery" }, container);
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

  it("opens detail dialogs and routes ClawHub actions", async () => {
    const container = createContainer();
    const onDetailClose = vi.fn();
    const showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const onClawHubDetailOpen = vi.fn();
    const onClawHubInstall = vi.fn();

    installDialogMethod("showModal", showModal);
    installDialogMethod("close", function (this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    });

    renderView(container, {
      detailKey: "repo-skill",
      onDetailClose,
    });
    const { dialog } = await getRenderedModalDialog(container);

    expect(showModal).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBe(true);

    const closeButton = container.querySelector<HTMLButtonElement>(
      ".skill-reader-dialog .exec-approval-header .btn",
    );
    expect(closeButton).toBeInstanceOf(HTMLButtonElement);
    closeButton!.click();

    expect(onDetailClose).toHaveBeenCalledTimes(1);

    renderView(container, {
      surface: "discovery",
      clawhubQuery: "git",
      clawhubResults: [
        {
          score: 0.95,
          slug: "github",
          installRef: "@openclaw/github",
          registry: "https://clawhub.ai",
          displayName: "GitHub",
          summary: "GitHub integration for OpenClaw",
          icon: `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`,
          version: "1.2.3",
        },
      ],
      clawhubIconUrls: {
        [`https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`]: "blob:clawhub-search-icon",
      },
      onClawHubDetailOpen,
      onClawHubInstall,
    });
    await Promise.resolve();

    const resultItem = container.querySelector<HTMLElement>(".plugin-catalog-card");
    const detailButton = resultItem?.querySelector<HTMLButtonElement>(
      ".plugin-catalog-card__primary-link",
    );
    const installButton = resultItem?.querySelector<HTMLButtonElement>(
      ".plugin-catalog-card__install",
    );
    expect(resultItem).toBeInstanceOf(HTMLElement);
    expect(installButton).toBeInstanceOf(HTMLButtonElement);
    expect(detailButton).toBeInstanceOf(HTMLButtonElement);
    expect(detailButton?.getAttribute("aria-label")).toBe("Open GitHub details");
    expect(detailButton?.contains(installButton!)).toBe(false);
    expect(resultItem?.querySelector("h2")?.textContent?.trim()).toBe("GitHub");
    expect(resultItem?.querySelector(".plugin-card-author")?.textContent?.trim()).toBe(
      "@openclaw/github",
    );
    expect(resultItem?.textContent).toContain("GitHub integration for OpenClaw");
    expect(resultItem?.querySelector<HTMLImageElement>("img")?.src).toBe(
      "blob:clawhub-search-icon",
    );
    expect(installButton?.textContent?.trim()).toBe("Install");
    detailButton!.click();
    installButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClawHubDetailOpen).toHaveBeenCalledTimes(1);
    expect(onClawHubDetailOpen).toHaveBeenCalledWith("@openclaw/github");
    expect(onClawHubInstall).toHaveBeenCalledTimes(1);
    expect(onClawHubInstall).toHaveBeenCalledWith("@openclaw/github");

    onClawHubInstall.mockClear();
    showModal.mockClear();

    renderView(container, {
      surface: "discovery",
      clawhubSearchError: "rate limited",
      clawhubInstallMessage: { kind: "success", text: "Installed github" },
      clawhubDetailRef: "github",
      clawhubDetail: {
        skill: {
          slug: "github",
          displayName: "GitHub",
          summary: "GitHub integration for OpenClaw",
          icon: `https://clawhub.ai/api/v1/skill-icons/${"b".repeat(64)}`,
          createdAt: 1_700_000_000,
          updatedAt: 1_700_000_100,
        },
        latestVersion: {
          version: "1.2.3",
          createdAt: 1_700_000_200,
          changelog: "Added search support",
        },
        metadata: {
          os: ["macos", "linux"],
        },
        owner: {
          displayName: "OpenClaw",
          handle: "openclaw",
        },
      },
      clawhubIconUrls: {
        [`https://clawhub.ai/api/v1/skill-icons/${"b".repeat(64)}`]: "blob:clawhub-detail-icon",
      },
      onClawHubInstall,
    });
    await Promise.resolve();

    await vi.waitFor(() => expect(showModal).toHaveBeenCalledTimes(1));
    expect(
      Array.from(container.querySelectorAll(".callout")).map((node) => normalizeText(node)),
    ).toEqual(["rate limited Retry", "Installed github"]);
    expect(normalizeText(container.querySelector(".skill-reader-dialog__body")!)).toBe(
      "GitHub integration for OpenClaw By OpenClaw (@openclaw) · Latest: v1.2.3 Added search support Platforms: macos, linux",
    );
    expect(container.querySelector<HTMLImageElement>(".clawhub-skill-icon--detail")?.src).toBe(
      "blob:clawhub-detail-icon",
    );
    expect(container.querySelector(".clawhub-skill-icon--profile")).toBeNull();

    const detailInstallButton = container.querySelector<HTMLButtonElement>(
      ".skill-reader-dialog__actions .btn.primary",
    );
    expect(detailInstallButton).toBeInstanceOf(HTMLButtonElement);
    expect(detailInstallButton?.textContent?.trim()).toBe("Install GitHub");
    expect(
      detailInstallButton?.closest("openclaw-modal-actions")?.parentElement?.lastElementChild,
    ).toBe(detailInstallButton?.closest("openclaw-modal-actions"));
    detailInstallButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClawHubInstall).toHaveBeenCalledTimes(1);
    expect(onClawHubInstall).toHaveBeenCalledWith("github");
  });

  it("updates the latest ClawHub version in an open detail dialog", async () => {
    const container = createContainer();
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const detail = {
      skill: {
        slug: "github",
        displayName: "GitHub",
        summary: "GitHub integration for OpenClaw",
        createdAt: 1_700_000_000,
        updatedAt: 1_700_000_100,
      },
      latestVersion: { version: "1.0.0", createdAt: 1_700_000_200 },
    };
    renderView(container, { clawhubDetailRef: "github", clawhubDetail: detail });
    const { dialog } = await getRenderedModalDialog(container);
    const body = expectDefined(
      container.querySelector(".skill-reader-dialog__body"),
      "ClawHub detail body",
    );
    expect(normalizeText(body)).toContain("Latest: v1.0.0");

    renderView(container, {
      clawhubDetailRef: "github",
      clawhubDetail: {
        ...detail,
        latestVersion: { version: "2.0.0", createdAt: 1_700_000_300 },
      },
    });

    expect((await getRenderedModalDialog(container)).dialog).toBe(dialog);
    expect(container.querySelector(".skill-reader-dialog__body")).toBe(body);
    expect(normalizeText(body)).toContain("Latest: v2.0.0");
    expect(normalizeText(body)).not.toContain("Latest: v1.0.0");
  });

  it.each([
    [true, 1],
    [undefined, 0],
  ])(
    "marks official ClawHub skills in the detail title: isOfficial=%s",
    async (isOfficial, count) => {
      const container = createContainer();
      installDialogMethod("showModal", function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      });
      renderView(container, {
        clawhubDetailRef: "@openclaw/github",
        clawhubDetail: {
          skill: {
            slug: "github",
            displayName: "GitHub",
            createdAt: 1_700_000_000,
            updatedAt: 1_700_000_100,
            isOfficial,
          },
        },
      });
      await getRenderedModalDialog(container);
      const badges = container.querySelectorAll(
        ".clawhub-skill-detail__identity [role='img'][aria-label='Official']",
      );
      expect(badges).toHaveLength(count);
    },
  );

  it.each(["Unable to read skill", null])(
    "keeps unavailable ClawHub details footer-free: %s",
    async (clawhubDetailError) => {
      const container = createContainer();
      installDialogMethod("showModal", function (this: HTMLDialogElement) {
        this.setAttribute("open", "");
      });
      renderView(container, { clawhubDetailRef: "guide", clawhubDetailError });
      await Promise.resolve();
      expect(container.querySelector(".skill-reader-dialog__body")).not.toBeNull();
      expect(container.querySelector(".skill-reader-dialog openclaw-modal-actions")).toBeNull();
      expect(container.querySelector(".skill-reader-dialog__body")?.textContent).toContain(
        clawhubDetailError ?? "Skill not found",
      );
    },
  );

  it("offers install without a detail card for an install-only search result", async () => {
    const container = createContainer();
    const onClawHubDetailOpen = vi.fn();
    const onClawHubInstall = vi.fn();

    renderView(container, {
      surface: "discovery",
      clawhubQuery: "pdf",
      clawhubResults: [
        {
          score: 1,
          slug: "pdf",
          // The Gateway marks external sources install-only; it serves no card for them.
          registry: "https://clawhub.ai",
          installRef: "skills-sh:openai/skills/pdf",
          installOnly: true,
          trustState: "not-scanned-by-clawhub",
          displayName: "Pdf",
        },
        {
          score: 1,
          slug: "pdf",
          installRef: "@awspace/pdf",
          registry: "https://clawhub.ai",
          displayName: "Pdf",
        },
      ],
      onClawHubDetailOpen,
      onClawHubInstall,
    });
    await Promise.resolve();

    const rows = [...container.querySelectorAll<HTMLElement>(".plugin-catalog-card")];
    expect(rows).toHaveLength(2);
    // A detail button on the external row would open a dialog the Gateway always refuses.
    expect(rows[0]!.querySelector(".plugin-catalog-card__primary-link")).toBeNull();
    expect(rows[1]!.querySelector(".plugin-catalog-card__primary-link")).not.toBeNull();
    // The row is the only place left to say the source was never scanned.
    expect(rows[0]!.textContent).toContain("Not scanned by ClawHub");

    for (const row of rows) {
      row
        .querySelector<HTMLButtonElement>(".plugin-catalog-card__install")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }

    // Install keeps the exact source the operator picked instead of a same-slug native skill.
    expect(onClawHubInstall.mock.calls.flat()).toEqual([
      "skills-sh:openai/skills/pdf",
      "@awspace/pdf",
    ]);
    expect(onClawHubDetailOpen).not.toHaveBeenCalled();
  });

  it("shows one installed external card without another install action", async () => {
    const container = createContainer();
    const onClawHubInstall = vi.fn();

    renderView(container, {
      surface: "discovery",
      showInventory: false,
      clawhubQuery: "pdf",
      clawhubResults: [
        {
          score: 1,
          slug: "pdf",
          installRef: "skills-sh:openai/skills/pdf",
          registry: "https://clawhub.ai",
          installOnly: true,
          displayName: "Pdf",
        },
      ],
      report: skillReport([
        createSkill({
          clawhub: {
            status: "linked",
            valid: true,
            registry: "https://clawhub.ai",
            slug: "pdf",
            requestedReference: "skills-sh:openai/skills/pdf",
            installedVersion: "0.0.0",
            installedAt: 1,
            originPath: "/tmp/.clawhub/origin.json",
            lockPath: "/tmp/workspace/.clawhub/lock.json",
          },
        }),
      ]),
      onClawHubInstall,
    });
    await Promise.resolve();

    const cards = container.querySelectorAll(".plugin-catalog-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.querySelector('[role="img"]')).not.toBeNull();
    expect(cards[0]?.querySelector(".plugin-catalog-card__install")).toBeNull();
    expect(onClawHubInstall).not.toHaveBeenCalled();
  });

  it("renders installed ClawHub verdicts and the local Skill Card tab", async () => {
    const container = createContainer();
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });

    const linkedSkill = createSkill({
      ...createLinkedSkill("openclaw"),
      skillCard: {
        present: true,
        path: "/tmp/workspace/skills/agentreceipt/skill-card.md",
        sizeBytes: 30,
      },
    });
    const report: SkillStatusReport = skillReport([linkedSkill]);
    const verdictKey = clawhubVerdictKey({
      registry: "https://clawhub.ai",
      slug: "agentreceipt",
      ownerHandle: "openclaw",
      version: "1.2.3",
    });
    const onDetailTabChange = vi.fn();

    renderView(container, {
      report,
      detailKey: "agentreceipt",
      onDetailTabChange,
      clawhubVerdicts: {
        [verdictKey]: {
          registry: "https://clawhub.ai",
          ok: false,
          decision: "fail",
          reasons: ["security.suspicious"],
          requestedSlug: "agentreceipt",
          requestedOwnerHandle: "openclaw",
          requestedVersion: "1.2.3",
          slug: "agentreceipt",
          version: "1.2.3",
          securityAuditUrl:
            "https://clawhub.ai/openclaw/skills/agentreceipt/security-audit?version=1.2.3",
          securityStatus: "suspicious",
          securityPassed: false,
        },
      },
    });
    await Promise.resolve();

    expect(normalizeText(container)).toContain("Review");
    expect(normalizeText(container)).toContain("@openclaw/agentreceipt@1.2.3");
    expect(normalizeText(container)).toContain("security.suspicious");
    expect(
      container.querySelector<HTMLAnchorElement>('a[href*="security-audit"]')?.textContent?.trim(),
    ).toBe("Full security report");
    expect(container.querySelector("#skill-detail-tab-overview")?.hasAttribute("active")).toBe(
      true,
    );
    container
      .querySelector("#skill-detail-tab-card")
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    expect(onDetailTabChange).toHaveBeenCalledWith("card");

    renderView(container, {
      report,
      detailKey: "agentreceipt",
      detailTab: "card",
      skillCardContents: {
        agentreceipt: "# AgentReceipt\n\nLocal **trust** card.",
      },
      clawhubVerdicts: {
        [verdictKey]: {
          registry: "https://clawhub.ai",
          ok: false,
          decision: "fail",
          reasons: ["security.suspicious"],
          requestedSlug: "agentreceipt",
          requestedOwnerHandle: "openclaw",
          requestedVersion: "1.2.3",
          securityAuditUrl:
            "https://clawhub.ai/openclaw/skills/agentreceipt/security-audit?version=1.2.3",
          securityStatus: "suspicious",
          securityPassed: false,
        },
      },
    });
    await Promise.resolve();

    expect(container.querySelector("#skill-detail-tab-card")?.hasAttribute("active")).toBe(true);
    expect(container.querySelector(".sidebar-markdown strong")?.textContent).toBe("trust");
    expect(normalizeText(container)).toContain("AgentReceipt Local trust card.");
  });

  it("retains the toolbar and keyed rows across status reads", async () => {
    const container = createContainer();
    const initial = createDeferred<{ value: SkillStatusReport | null; error: string | null }>();
    const initialRead = { completion: initial.promise };
    renderView(container, { report: null });
    const search = container.querySelector<HTMLInputElement>('input[name="skills-filter"]')!;
    search.focus();
    renderView(container, { report: null, loading: true, skillsRead: initialRead });
    expect(container.querySelector('input[name="skills-filter"]')).toBe(search);
    expect(document.activeElement).toBe(search);
    expect(container.querySelector(".plugins-item")).toBeNull();
    const report = skillReport([createSkill()]);
    initial.resolve({ value: report, error: null });
    renderView(container, { report, skillsRead: initialRead });
    await waitForFast(() => expect(container.querySelector(".plugins-item")).not.toBeNull());
    const row = container.querySelector(".plugins-item");
    const pending = createDeferred<{ value: SkillStatusReport | null; error: string | null }>();
    const pendingRead = { completion: pending.promise };
    renderView(container, { report, loading: true, skillsRead: pendingRead });
    expect(container.querySelector(".plugins-item")).toBe(row);
    expect(container.querySelector('input[name="skills-filter"]')).toBe(search);
    expect(document.activeElement).toBe(search);
    const refresh = () =>
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
        (button) =>
          button.textContent?.trim() === "Loading…" || button.textContent?.trim() === "Refresh",
      )!;
    expect(refresh().disabled).toBe(true);
    expect(refresh().textContent).toContain("Loading");
    const updated = skillReport([createSkill({ description: "Updated description" })]);
    pending.resolve({ value: updated, error: null });
    renderView(container, { report: updated, skillsRead: pendingRead });
    await waitForFast(() => expect(row?.textContent).toContain("Updated description"));
    expect(container.querySelector(".plugins-item")).toBe(row);
    expect(refresh().disabled).toBe(false);
    expect(refresh().textContent).toContain("Refresh");
  });

  it("renders card read errors and retries inside the existing detail dialog", async () => {
    const container = createContainer();
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const report = skillReport([
      createSkill({
        skillCard: { present: true, path: "/tmp/skill/SKILL.md", sizeBytes: 12 },
      }),
    ]);
    const pending = createDeferred<{ value: string | undefined; error: string | null }>();
    const read = { cacheKey: "/tmp/skill/SKILL.md\0v1", completion: pending.promise };
    renderView(container, {
      report,
      detailKey: "repo-skill",
      detailTab: "card",
      skillCardReads: { "repo-skill": read },
    });
    const { dialog } = await getRenderedModalDialog(container);
    expect(normalizeText(dialog)).toContain("Loading");
    pending.resolve({ value: undefined, error: "Card temporarily unavailable" });
    await waitForFast(() =>
      expect(normalizeText(dialog)).toContain("Card temporarily unavailable"),
    );
    const retry = createDeferred<{ value: string | undefined; error: string | null }>();
    const retriedRead = { cacheKey: read.cacheKey, completion: retry.promise };
    renderView(container, {
      report,
      detailKey: "repo-skill",
      detailTab: "card",
      skillCardReads: { "repo-skill": retriedRead },
    });
    await waitForFast(() => expect(normalizeText(dialog)).toContain("Loading"));
    expect(normalizeText(dialog)).not.toContain("Card temporarily unavailable");
    retry.resolve({ value: "# Restored card", error: null });
    renderView(container, {
      report,
      detailKey: "repo-skill",
      detailTab: "card",
      skillCardReads: { "repo-skill": retriedRead },
      skillCardContents: { "repo-skill": "# Restored card" },
    });
    await waitForFast(() => expect(normalizeText(dialog)).toContain("Restored card"));
    expect((await getRenderedModalDialog(container)).dialog).toBe(dialog);
    expect(dialog.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps the inventory and detail dialog while missing verdicts load", async () => {
    const container = createContainer();
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const pending = createDeferred<Record<string, ClawHubSkillSecurityVerdict>>();
    const owner = mountSolid(
      () => {
        const verdicts = createDeferredRead(() => pending.promise);
        return (
          <Skills
            {...createProps({
              report: skillReport([createLinkedSkill()]),
              detailKey: "agentreceipt",
              readClawHubVerdicts: verdicts,
            })}
          />
        );
      },
      { container },
    );
    dialogRestores.push(owner.unmount);
    const row = container.querySelector(".plugins-item");
    const { dialog } = await getRenderedModalDialog(container);
    const search = container.querySelector('input[name="skills-filter"]');
    const verdictLabels = () =>
      [...container.querySelectorAll(".settings-status, .chip")].map(normalizeText);
    expect(verdictLabels().filter((label) => label === "Refreshing…")).toHaveLength(2);

    pending.resolve({});
    await waitForFast(() =>
      expect(verdictLabels().filter((label) => label === "Unavailable")).toHaveLength(2),
    );
    expect(container.querySelector(".plugins-item")).toBe(row);
    expect(container.querySelector('input[name="skills-filter"]')).toBe(search);
    expect((await getRenderedModalDialog(container)).dialog).toBe(dialog);
  });

  it("replaces the detail selection while a retained verdict read is pending", async () => {
    const container = createContainer();
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const report = skillReport([createLinkedSkill(), createSkill()]);
    const verdictKey = clawhubVerdictKey({
      registry: "https://clawhub.ai",
      slug: "agentreceipt",
      version: "1.2.3",
    });
    const verdicts: Record<string, ClawHubSkillSecurityVerdict> = {
      [verdictKey]: {
        registry: "https://clawhub.ai",
        ok: true,
        decision: "pass",
        reasons: [],
        requestedSlug: "agentreceipt",
        requestedVersion: "1.2.3",
        slug: "agentreceipt",
        version: "1.2.3",
        securityStatus: "clean",
        securityPassed: true,
      },
    };
    const pending = createDeferred<Record<string, ClawHubSkillSecurityVerdict>>();
    let beginRead: (() => void) | undefined;
    let selectOther: (() => void) | undefined;
    const owner = mountSolid(
      () => {
        const [refreshing, setRefreshing] = createSignal(false);
        const [selected, setSelected] = createSignal("agentreceipt");
        const read = createDeferredRead(() =>
          refreshing() ? pending.promise : Promise.resolve(verdicts),
        );
        beginRead = () => setRefreshing(true);
        selectOther = () => setSelected("repo-skill");
        const props = createProps({
          report,
          clawhubVerdicts: verdicts,
          readClawHubVerdicts: read,
        });
        return <Skills {...props} state={{ ...props.state, skillsDetailKey: selected() }} />;
      },
      { container },
    );
    dialogRestores.push(owner.unmount);
    const { dialog } = await getRenderedModalDialog(container);
    await waitForFast(() => expect(normalizeText(dialog)).toContain("Clean"));
    expectDefined(beginRead, "verdict refresh callback")();
    await waitForFast(() => expect(normalizeText(dialog)).toContain("Refreshing"));
    expectDefined(selectOther, "skill selection callback")();
    await waitForFast(() => expect(normalizeText(dialog)).toContain("Repo Skill"));
    expect(normalizeText(dialog)).not.toContain("AgentReceipt");
    expect((await getRenderedModalDialog(container)).dialog).toBe(dialog);
    pending.resolve(verdicts);
  });

  it("shows verdict read failures and held retries without replacing the dialog", async () => {
    const container = createContainer();
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    const first = createDeferred<Record<string, ClawHubSkillSecurityVerdict>>();
    let changeRead:
      | ((next: Promise<Record<string, ClawHubSkillSecurityVerdict>>) => void)
      | undefined;
    const owner = mountSolid(
      () => {
        const [receipt, setReceipt] = createSignal(first.promise);
        changeRead = (next) => {
          void setReceipt(next);
        };
        const read = createDeferredRead(() => receipt());
        return (
          <Skills
            {...createProps({
              report: skillReport([createLinkedSkill()]),
              detailKey: "agentreceipt",
              readClawHubVerdicts: read,
            })}
          />
        );
      },
      { container },
    );
    dialogRestores.push(owner.unmount);
    const { dialog } = await getRenderedModalDialog(container);
    first.reject(new Error("Verdicts temporarily unavailable"));
    await waitForFast(() =>
      expect(normalizeText(dialog)).toContain("Verdicts temporarily unavailable"),
    );
    const retry = createDeferred<Record<string, ClawHubSkillSecurityVerdict>>();
    expectDefined(changeRead, "verdict receipt callback")(retry.promise);
    await waitForFast(() => expect(normalizeText(dialog)).toContain("Refreshing"));
    expect(normalizeText(dialog)).not.toContain("Verdicts temporarily unavailable");
    retry.resolve({});
    await waitForFast(() => expect(normalizeText(dialog)).toContain("Unavailable"));
    expect((await getRenderedModalDialog(container)).dialog).toBe(dialog);
    expect(normalizeText(dialog)).not.toContain("Verdicts temporarily unavailable");
  });

  it("fails closed for inconsistent ClawHub verdict envelopes", async () => {
    const container = createContainer();
    installDialogMethod("showModal", function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });

    const report = skillReport([createLinkedSkill()]);
    const verdictKey = clawhubVerdictKey({
      registry: "https://clawhub.ai",
      slug: "agentreceipt",
      version: "1.2.3",
    });

    renderView(container, {
      report,
      detailKey: "agentreceipt",
      clawhubVerdicts: {
        [verdictKey]: {
          registry: "https://clawhub.ai",
          ok: false,
          decision: "pass",
          reasons: [],
          requestedSlug: "agentreceipt",
          requestedVersion: "1.2.3",
          slug: "agentreceipt",
          version: "1.2.3",
          securityStatus: "clean",
          securityPassed: true,
        },
      },
    });
    await Promise.resolve();

    const chips = Array.from(container.querySelectorAll(".chip"));
    const verdictChip = chips.find((chip) => normalizeText(chip) === "Unavailable");
    expect(verdictChip).toBeDefined();
    expect(chips.map((chip) => normalizeText(chip))).toContain("Unavailable");
    expect(chips.some((chip) => normalizeText(chip) === "Clean")).toBe(false);
    expect(verdictChip?.classList.contains("chip-ok")).toBe(false);
  });
});
