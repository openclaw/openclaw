/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillStatusReport } from "../../api/types.ts";
import { i18n } from "../../i18n/index.ts";
import { clawhubVerdictKey, type ClawHubSkillSecurityVerdict } from "../../lib/skills/index.ts";
import { getRenderedModalDialog } from "../../test-helpers/modal-dialog.ts";
import { cleanupSkillsViews, renderSkills } from "./view.solid.test-support.tsx";
import {
  createDialogMethodInstaller,
  createProps,
  createSkill,
  normalizeText,
} from "./view.test-support.ts";
afterEach(cleanupSkillsViews);

const dialogRestores: Array<() => void> = [];
const installDialogMethod = createDialogMethodInstaller(dialogRestores);
const githubResult = {
  score: 0.95,
  slug: "github",
  installRef: "@openclaw/github",
  registry: "https://clawhub.ai",
  displayName: "GitHub",
  summary: "GitHub integration for OpenClaw",
  icon: `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`,
  version: "1.2.3",
};
const externalResult = {
  score: 1,
  slug: "pdf",
  registry: "https://clawhub.ai",
  installRef: "skills-sh:openai/skills/pdf",
  installOnly: true,
  displayName: "Pdf",
};

function mockShowModal() {
  const showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  });
  installDialogMethod("showModal", showModal);
  return showModal;
}

function buttons(container: Element) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")];
}

function texts(container: Element, selector: string) {
  return [...container.querySelectorAll(selector)].map(normalizeText);
}

function expectFinalAction(button: Element | null | undefined) {
  const actions = button?.closest("openclaw-modal-actions");
  expect(actions).not.toBeNull();
  expect(actions?.parentElement?.lastElementChild).toBe(actions);
}

function createContainer() {
  const container = document.createElement("div");
  document.body.append(container);
  dialogRestores.push(() => container.remove());
  return {
    container,
    find: <T extends Element = HTMLElement>(selector: string) =>
      container.querySelector<T>(selector),
    all: <T extends Element = HTMLElement>(selector: string) => [
      ...container.querySelectorAll<T>(selector),
    ],
    render: (overrides: Parameters<typeof createProps>[0] = {}) => renderView(container, overrides),
  };
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
      const save = buttons(container).find((button) => normalizeText(button) === "Save key");
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
    const { all, render } = createContainer();
    const report = skillReport([
      createSkill({ skillKey: "ws", name: "Workspace Skill", source: "openclaw-workspace" }),
      createSkill({ skillKey: "bi", name: "Weather", bundled: true }),
      createSkill({ skillKey: "inst", name: "Installed Skill", source: "openclaw-managed" }),
    ]);
    const onDetailOpen = vi.fn();
    render({ report, onDetailOpen });
    await Promise.resolve();
    const groups = all<HTMLDetailsElement>("details.skills-group");
    expect(groups).toHaveLength(3);
    expect(groups.every((group) => group.open)).toBe(true);
    groups[0]!.open = false;
    const row = groups[1]!.querySelector(".settings-row");
    render({ report, filter: "weather", onDetailOpen });
    await Promise.resolve();
    const remaining = all<HTMLDetailsElement>("details.skills-group");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe(groups[1]);
    expect(remaining[0]!.open).toBe(true);
    expect(remaining[0]!.querySelector(".settings-row")).toBe(row);
    expect(remaining[0]!.textContent).toContain("Weather");
    remaining[0]!.querySelector<HTMLButtonElement>(".plugins-item__detail-button")!.click();
    expect(onDetailOpen).toHaveBeenCalledExactlyOnceWith("bi");
    render({ report });
    await Promise.resolve();
    const restored = all<HTMLDetailsElement>("details.skills-group");
    expect(restored).toHaveLength(3);
    expect(restored.every((group) => group.open)).toBe(true);
  });

  it("offers only an installer satisfying a missing alternative", async () => {
    const { container, find, render } = createContainer();
    mockShowModal();
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
    render({ report: skillReport([skill]), detailKey: "coding-agent", onInstall });
    await Promise.resolve();
    const actions = buttons(container);
    expect(actions.some((button) => normalizeText(button) === "Install unrelated CLI")).toBe(false);
    const install = actions.find((button) => normalizeText(button) === "Install Codex CLI");
    expect(
      normalizeText(
        expectDefined(
          find(".skill-reader-dialog__body .callout"),
          "alternative binary requirement",
        ),
      ),
    ).toContain("bin:any of (claude, codex, opencode)");
    expect(install).toBeInstanceOf(HTMLButtonElement);
    expectFinalAction(install);
    install!.click();
    expect(onInstall).toHaveBeenCalledWith("coding-agent", "Coding Agent", "node-codex");
  });

  it("keeps update and install permissions independent", async () => {
    const { container, find, render } = createContainer();
    mockShowModal();
    const skill = createSkill({
      missing: { anyBins: [], bins: ["skill-cli"], env: [], config: [], os: [] },
      install: [{ id: "skill-cli", kind: "node", label: "Install skill-cli", bins: ["skill-cli"] }],
    });

    render({
      canUpdate: false,
      canInstall: true,
      detailKey: skill.skillKey,
      report: skillReport([skill]),
    });
    await Promise.resolve();

    const toggle = find<HTMLInputElement>("input.settings-toggle__input");
    expect(toggle?.hasAttribute("disabled")).toBe(true);
    const install = buttons(container).find(
      (button) => normalizeText(button) === "Install skill-cli",
    );
    expect(install?.disabled).toBe(false);
  });

  it("locks every skill mutation control behind the active mutation", async () => {
    const { container, find, all } = createContainer();
    mockShowModal();
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
        { ...githubResult, score: 1, version: "1.0.0", summary: undefined, icon: undefined },
      ],
      onRefresh,
      onToggle,
      onSaveKey,
      onInstall,
      onClawHubInstall,
    });
    renderSkills(props, container);
    await Promise.resolve();

    const refresh = buttons(container).find((button) => button.textContent?.trim() === "Refresh");
    expect(refresh?.disabled).toBe(true);
    const toggles = all<HTMLInputElement>("input.settings-toggle__input");
    expect(toggles.every((toggle) => toggle.hasAttribute("disabled"))).toBe(true);
    expect(all(".plugins-item input.settings-toggle__input")).toHaveLength(0);
    const password = find<HTMLInputElement>('input[type="password"]');
    expect(password?.disabled).toBe(true);
    const mutationButtons = buttons(container).filter((button) =>
      /^(Install|Save key)/.test(normalizeText(button)),
    );
    expect(mutationButtons).toHaveLength(2);
    expect(mutationButtons.every((button) => button.disabled)).toBe(true);

    refresh?.click();
    for (const toggle of toggles) {
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
    const remoteInstall = find<HTMLButtonElement>(".plugin-catalog-card__install");
    expect(remoteInstall?.disabled).toBe(true);
    remoteInstall?.click();
    expect(onClawHubInstall).not.toHaveBeenCalled();
  });

  it("keeps the remaining skill's status and details target when a skill leaves the disabled tab", async () => {
    const { find, all, render } = createContainer();

    const passwordSkill = createSkill({ skillKey: "1password", name: "1Password", disabled: true });
    const appleNotesSkill = createSkill({
      skillKey: "apple-notes",
      name: "Apple Notes",
      disabled: true,
    });
    const report: SkillStatusReport = skillReport([passwordSkill, appleNotesSkill]);

    render({ report, statusFilter: "disabled" });
    await Promise.resolve();

    expect(all(".plugins-item [role=img]")).toHaveLength(2);

    const updatedReport: SkillStatusReport = skillReport([
      { ...passwordSkill, disabled: false },
      appleNotesSkill,
    ]);

    const onDetailOpen = vi.fn();
    render({ report: updatedReport, statusFilter: "disabled", onDetailOpen });
    await Promise.resolve();

    const row = find(".plugins-item")!;
    expect(all(".plugins-item")).toHaveLength(1);
    expect(row.textContent).toContain("Apple Notes");
    expect(row.querySelector("[role=img]")?.getAttribute("title")).toContain("Disabled");
    row.querySelector<HTMLButtonElement>(".plugins-item__detail-button")!.click();
    expect(onDetailOpen).toHaveBeenCalledWith("apple-notes");
  });

  it("treats skills blocked by the selected agent filter as needing setup", async () => {
    const { container, find, all, render } = createContainer();
    mockShowModal();
    const report: SkillStatusReport = skillReport([createSkill({ blockedByAgentFilter: true })]);

    render({ report, statusFilter: "ready" });
    await Promise.resolve();

    expect(all(".plugins-item")).toHaveLength(0);
    expect(normalizeText(container)).toContain("Ready 0");
    expect(normalizeText(container)).toContain("Needs Setup 1");

    render({ report, statusFilter: "needs-setup", detailKey: "repo-skill" });
    await Promise.resolve();

    expect(find(".plugins-item .settings-status--warn")).not.toBeNull();
    expect(normalizeText(container)).toContain("Reason: blocked by agent filter");
    expect(texts(container, ".chip")).toContain("blocked");
  });

  it("opens detail dialogs and routes ClawHub actions", async () => {
    const { container, find, render } = createContainer();
    const onDetailClose = vi.fn();
    const showModal = mockShowModal();
    const onClawHubDetailOpen = vi.fn();
    const onClawHubInstall = vi.fn();

    installDialogMethod("close", function (this: HTMLDialogElement) {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    });

    render({
      detailKey: "repo-skill",
      onDetailClose,
    });
    const { dialog } = await getRenderedModalDialog(container);

    expect(showModal).toHaveBeenCalledTimes(1);
    expect(dialog.open).toBe(true);

    const closeButton = find<HTMLButtonElement>(".skill-reader-dialog .exec-approval-header .btn");
    expect(closeButton).toBeInstanceOf(HTMLButtonElement);
    closeButton!.click();

    expect(onDetailClose).toHaveBeenCalledTimes(1);

    render({
      surface: "discovery",
      clawhubQuery: "git",
      clawhubResults: [githubResult],
      clawhubIconUrls: {
        [`https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`]: "blob:clawhub-search-icon",
      },
      onClawHubDetailOpen,
      onClawHubInstall,
    });
    await Promise.resolve();

    const resultItem = find<HTMLElement>(".plugin-catalog-card");
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

    expect(onClawHubDetailOpen).toHaveBeenCalledExactlyOnceWith("@openclaw/github");
    expect(onClawHubInstall).toHaveBeenCalledExactlyOnceWith("@openclaw/github");

    onClawHubInstall.mockClear();
    showModal.mockClear();

    render({
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
    expect(texts(container, ".callout")).toEqual(["rate limited Retry", "Installed github"]);
    expect(normalizeText(find(".skill-reader-dialog__body")!)).toBe(
      "GitHub integration for OpenClaw By OpenClaw (@openclaw) · Latest: v1.2.3 Added search support Platforms: macos, linux",
    );
    expect(find<HTMLImageElement>(".clawhub-skill-icon--detail")?.src).toBe(
      "blob:clawhub-detail-icon",
    );
    expect(find(".clawhub-skill-icon--profile")).toBeNull();

    const detailInstallButton = find<HTMLButtonElement>(
      ".skill-reader-dialog__actions .btn.primary",
    );
    expect(detailInstallButton).toBeInstanceOf(HTMLButtonElement);
    expect(detailInstallButton?.textContent?.trim()).toBe("Install GitHub");
    expectFinalAction(detailInstallButton);
    detailInstallButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onClawHubInstall).toHaveBeenCalledExactlyOnceWith("github");
  });

  it.each([
    { clawhubDetailLoading: true, clawhubDetailError: null },
    { clawhubDetailLoading: false, clawhubDetailError: "Unable to read skill" },
    { clawhubDetailLoading: false, clawhubDetailError: null },
  ])("keeps unavailable ClawHub details footer-free: %j", async (state) => {
    const { find, render } = createContainer();
    mockShowModal();
    render({ clawhubDetailRef: "guide", ...state });
    await Promise.resolve();
    expect(find(".skill-reader-dialog__body")).not.toBeNull();
    expect(find(".skill-reader-dialog openclaw-modal-actions")).toBeNull();
  });

  it("offers install without a detail card for an install-only search result", async () => {
    const { all, render } = createContainer();
    const onClawHubDetailOpen = vi.fn();
    const onClawHubInstall = vi.fn();

    render({
      surface: "discovery",
      clawhubQuery: "pdf",
      clawhubResults: [
        { ...externalResult, trustState: "not-scanned-by-clawhub" },
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

    const rows = all(".plugin-catalog-card");
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
    const { all, render } = createContainer();
    const onClawHubInstall = vi.fn();

    render({
      surface: "discovery",
      showInventory: false,
      clawhubQuery: "pdf",
      clawhubResults: [externalResult],
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

    const cards = all(".plugin-catalog-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]?.querySelector('[role="img"]')).not.toBeNull();
    expect(cards[0]?.querySelector(".plugin-catalog-card__install")).toBeNull();
    expect(onClawHubInstall).not.toHaveBeenCalled();
  });

  it("renders installed ClawHub verdicts and the local Skill Card tab", async () => {
    const { container, find, render } = createContainer();
    mockShowModal();

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
    const verdict = {
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
    } satisfies ClawHubSkillSecurityVerdict;

    render({
      report,
      detailKey: "agentreceipt",
      onDetailTabChange,
      clawhubVerdicts: {
        [verdictKey]: { ...verdict, slug: "agentreceipt", version: "1.2.3" },
      },
    });
    await Promise.resolve();

    expect(normalizeText(container)).toContain("Review");
    expect(normalizeText(container)).toContain("@openclaw/agentreceipt@1.2.3");
    expect(normalizeText(container)).toContain("security.suspicious");
    expect(find<HTMLAnchorElement>('a[href*="security-audit"]')?.textContent?.trim()).toBe(
      "Full security report",
    );
    expect(find("#skill-detail-tab-overview")?.hasAttribute("active")).toBe(true);
    container
      .querySelector("#skill-detail-tab-card")
      ?.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    expect(onDetailTabChange).toHaveBeenCalledWith("card");

    render({
      report,
      detailKey: "agentreceipt",
      detailTab: "card",
      skillCardContents: {
        agentreceipt: "# AgentReceipt\n\nLocal **trust** card.",
      },
      clawhubVerdicts: {
        [verdictKey]: verdict,
      },
    });
    await Promise.resolve();

    expect(find("#skill-detail-tab-card")?.hasAttribute("active")).toBe(true);
    expect(find(".sidebar-markdown strong")?.textContent).toBe("trust");
    expect(normalizeText(container)).toContain("AgentReceipt Local trust card.");
  });

  it("shows Refreshing… consistently for a missing ClawHub verdict while loading", async () => {
    const { container, all, render } = createContainer();
    mockShowModal();
    render({
      report: skillReport([createLinkedSkill()]),
      detailKey: "agentreceipt",
      clawhubVerdictsLoading: true,
    });
    await Promise.resolve();
    const rowVerdict = all(".settings-status").find(
      (node) => normalizeText(node) === "Refreshing…",
    );
    const detailVerdict = all(".chip").find((node) => normalizeText(node) === "Refreshing…");
    expect(rowVerdict).toBeDefined();
    expect(detailVerdict).toBeDefined();
    expect(rowVerdict?.classList.contains("settings-status--warn")).toBe(false);
    expect(detailVerdict?.classList.contains("chip-warn")).toBe(false);
    expect(normalizeText(container).match(/Refreshing…/gu) ?? []).toHaveLength(2);
  });

  it("fails closed for inconsistent ClawHub verdict envelopes", async () => {
    const { all, render } = createContainer();
    mockShowModal();

    const report = skillReport([createLinkedSkill()]);
    const verdictKey = clawhubVerdictKey({
      registry: "https://clawhub.ai",
      slug: "agentreceipt",
      version: "1.2.3",
    });

    render({
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

    const chips = all(".chip");
    const verdictChip = chips.find((chip) => normalizeText(chip) === "Unavailable");
    expect(verdictChip).toBeDefined();
    expect(chips.map((chip) => normalizeText(chip))).toContain("Unavailable");
    expect(chips.some((chip) => normalizeText(chip) === "Clean")).toBe(false);
    expect(verdictChip?.classList.contains("chip-ok")).toBe(false);
  });
});
