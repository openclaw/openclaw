/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { SkillClawHubLink, SkillStatusReport } from "../../api/types.ts";
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

function mockShowModal(checkConnected = false) {
  const showModal = vi.fn(function (this: HTMLDialogElement) {
    if (checkConnected) {
      expect(this.isConnected).toBe(true);
    }
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

async function createView(
  overrides: Parameters<typeof createProps>[0] = {},
  attachAfterRender = false,
) {
  const container = document.createElement("div");
  if (!attachAfterRender) {
    document.body.append(container);
  }
  dialogRestores.push(() => container.remove());
  const rendered = renderView(container, overrides);
  if (attachAfterRender) {
    document.body.append(container);
  }
  await rendered;
  return {
    container,
    find: container.querySelector.bind(container),
    all: <T extends Element = HTMLElement>(selector: string) => [
      ...container.querySelectorAll<T>(selector),
    ],
    render: (next: Parameters<typeof createProps>[0] = {}) => renderView(container, next),
  };
}

function skillReport(skills: SkillStatusReport["skills"]): SkillStatusReport {
  return { workspaceDir: "/tmp/workspace", managedSkillsDir: "/tmp/skills", skills };
}

function renderView(container: HTMLElement, overrides: Parameters<typeof createProps>[0] = {}) {
  renderSkills(createProps(overrides), container);
  return Promise.resolve();
}

function createLinkedSkill(
  ownerHandle?: string,
  overrides: Partial<Extract<SkillClawHubLink, { valid: true }>> = {},
) {
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
      ...overrides,
    },
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (dialogRestores.length > 0) {
    dialogRestores.pop()?.();
  }
  await i18n.setLocale("en");
});

it.each([
  { editValue: "   ", disabled: true, canUpdate: true },
  { editValue: "  sk-test  ", disabled: false, canUpdate: true },
  { editValue: "", disabled: true, canUpdate: false },
])(
  "gates credential replacement: value=$editValue canUpdate=$canUpdate",
  async ({ editValue, disabled, canUpdate }) => {
    const showModal = mockShowModal(true);
    const onSaveKey = vi.fn();
    const skill = createSkill(
      canUpdate
        ? {}
        : {
            missing: { ...createSkill().missing, bins: ["skill-cli"] },
            install: [
              { id: "skill-cli", kind: "node", label: "Install skill-cli", bins: ["skill-cli"] },
            ],
          },
    );
    const { container, find } = await createView(
      {
        detailKey: "repo-skill",
        report: skillReport([skill]),
        canUpdate,
        canInstall: true,
        edits: { "repo-skill": editValue },
        onSaveKey,
      },
      true,
    );
    await getRenderedModalDialog(container);
    expect(showModal).toHaveBeenCalledTimes(1);
    const input = find<HTMLInputElement>('input[type="password"]');
    const save = buttons(container).find((button) => normalizeText(button) === "Save key");
    expect(input?.required).toBe(true);
    expect(normalizeText(expectDefined(input?.labels?.[0], "API key label"))).toBe(
      "API key (OPENAI_API_KEY)",
    );
    expect(save?.disabled).toBe(disabled);
    if (!canUpdate) {
      expect(find("input.settings-toggle__input")?.hasAttribute("disabled")).toBe(true);
      expect(
        buttons(container).find((button) => normalizeText(button) === "Install skill-cli")
          ?.disabled,
      ).toBe(false);
    }
    save?.click();

    if (disabled) {
      expect(onSaveKey).not.toHaveBeenCalled();
    } else {
      expect(onSaveKey).toHaveBeenCalledWith("repo-skill");
    }
  },
);

it("preserves retained group identity and restores removed groups when filtering", async () => {
  const report = skillReport([
    createSkill({ skillKey: "ws", name: "Workspace Skill", source: "openclaw-workspace" }),
    createSkill({ skillKey: "bi", name: "Weather", bundled: true }),
    createSkill({ skillKey: "inst", name: "Installed Skill", source: "openclaw-managed" }),
  ]);
  const onDetailOpen = vi.fn();
  const { all, render } = await createView({ report, onDetailOpen });
  const groups = all<HTMLDetailsElement>("details.skills-group");
  expect(groups).toMatchObject([{ open: true }, { open: true }, { open: true }]);
  groups[0]!.open = false;
  const row = groups[1]!.querySelector(".settings-row");
  await render({ report, filter: "weather", onDetailOpen });
  const remaining = all<HTMLDetailsElement>("details.skills-group");
  expect(remaining).toHaveLength(1);
  expect(remaining[0]).toBe(groups[1]);
  expect(remaining[0]).toMatchObject({
    open: true,
    textContent: expect.stringContaining("Weather"),
  });
  expect(remaining[0]!.querySelector(".settings-row")).toBe(row);
  remaining[0]!.querySelector<HTMLButtonElement>(".plugins-item__detail-button")!.click();
  expect(onDetailOpen).toHaveBeenCalledExactlyOnceWith("bi");
  await render({ report });
  const restored = all<HTMLDetailsElement>("details.skills-group");
  expect(restored).toMatchObject([{ open: true }, { open: true }, { open: true }]);
});

it("offers only an installer satisfying a missing alternative", async () => {
  const onInstall = vi.fn();
  const skill = createSkill({
    skillKey: "coding-agent",
    name: "Coding Agent",
    eligible: false,
    missing: { ...createSkill().missing, anyBins: ["claude", "codex", "opencode"] },
    install: [
      { id: "node-unrelated", kind: "node", label: "Install unrelated CLI", bins: ["unrelated"] },
      { id: "node-codex", kind: "node", label: "Install Codex CLI", bins: ["codex"] },
    ],
  });
  const { container, find } = await createView({
    report: skillReport([skill]),
    detailKey: "coding-agent",
    onInstall,
  });
  const actions = buttons(container);
  expect(actions.some((button) => normalizeText(button) === "Install unrelated CLI")).toBe(false);
  const install = actions.find((button) => normalizeText(button) === "Install Codex CLI");
  const callout = expectDefined(find(".skill-reader-dialog__body .callout"), "binary requirement");
  expect(normalizeText(callout)).toContain("bin:any of (claude, codex, opencode)");
  expect(install).toBeInstanceOf(HTMLButtonElement);
  install!.click();
  expect(onInstall).toHaveBeenCalledWith("coding-agent", "Coding Agent", "node-codex");
});

it("locks every skill mutation control behind the active mutation", async () => {
  const calendar = createSkill({
    skillKey: "calendar",
    name: "Calendar",
    missing: { anyBins: [], bins: ["calendar-cli"], env: [], config: [], os: [] },
    install: [
      { id: "calendar-cli", kind: "brew", label: "Install calendar-cli", bins: ["calendar-cli"] },
    ],
  });
  const report: SkillStatusReport = skillReport([createSkill(), calendar]);
  const callbacks = {
    onRefresh: vi.fn(),
    onToggle: vi.fn(),
    onSaveKey: vi.fn(),
    onInstall: vi.fn(),
    onClawHubInstall: vi.fn(),
  };

  const props = {
    report,
    detailKey: "calendar",
    operation: { kind: "skill", skillKey: "repo-skill" },
    clawhubResults: [
      { ...githubResult, score: 1, version: "1.0.0", summary: undefined, icon: undefined },
    ],
    ...callbacks,
  };
  const { container, find, all, render } = await createView(props);

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
  for (const callback of Object.values(callbacks)) {
    expect(callback).not.toHaveBeenCalled();
  }

  void render({ ...props, surface: "discovery" });
  const remoteInstall = find<HTMLButtonElement>(".plugin-catalog-card__install");
  expect(remoteInstall?.disabled).toBe(true);
  remoteInstall?.click();
  expect(callbacks.onClawHubInstall).not.toHaveBeenCalled();
});

it("keeps the remaining skill's status and details target when a skill leaves the disabled tab", async () => {
  const password = createSkill({ skillKey: "1password", name: "1Password", disabled: true });
  const notes = createSkill({
    skillKey: "apple-notes",
    name: "Apple Notes",
    disabled: true,
  });
  const report: SkillStatusReport = skillReport([password, notes]);

  const { find, all, render } = await createView({ report, statusFilter: "disabled" });

  expect(all(".plugins-item [role=img]")).toHaveLength(2);

  const updatedReport: SkillStatusReport = skillReport([{ ...password, disabled: false }, notes]);

  const onDetailOpen = vi.fn();
  await render({ report: updatedReport, statusFilter: "disabled", onDetailOpen });

  const row = find(".plugins-item")!;
  expect(all(".plugins-item")).toHaveLength(1);
  expect(row.textContent).toContain("Apple Notes");
  expect(row.querySelector("[role=img]")?.getAttribute("title")).toContain("Disabled");
  row.querySelector<HTMLButtonElement>(".plugins-item__detail-button")!.click();
  expect(onDetailOpen).toHaveBeenCalledWith("apple-notes");
});

it("treats skills blocked by the selected agent filter as needing setup", async () => {
  const report: SkillStatusReport = skillReport([createSkill({ blockedByAgentFilter: true })]);

  const { container, find, all, render } = await createView({ report, statusFilter: "ready" });

  expect(all(".plugins-item")).toHaveLength(0);
  expect(normalizeText(container)).toContain("Ready 0");
  expect(normalizeText(container)).toContain("Needs Setup 1");

  await render({ report, statusFilter: "needs-setup", detailKey: "repo-skill" });

  expect(find(".plugins-item .settings-status--warn")).not.toBeNull();
  expect(normalizeText(container)).toContain("Reason: blocked by agent filter");
  expect(texts(container, ".chip")).toContain("blocked");
});

it("opens detail dialogs and routes ClawHub actions", async () => {
  const onDetailClose = vi.fn();
  const showModal = mockShowModal();
  const onClawHubDetailOpen = vi.fn();
  const onClawHubInstall = vi.fn();

  const { container, find, render } = await createView({
    detailKey: "repo-skill",
    onDetailClose,
  });
  await getRenderedModalDialog(container);

  expect(showModal).toHaveBeenCalledTimes(1);

  const closeButton = find<HTMLButtonElement>(".skill-reader-dialog .exec-approval-header .btn");
  expect(closeButton).toBeInstanceOf(HTMLButtonElement);
  closeButton!.click();

  expect(onDetailClose).toHaveBeenCalledTimes(1);

  await render({
    surface: "discovery",
    clawhubQuery: "git",
    clawhubResults: [githubResult],
    clawhubIconUrls: {
      [`https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`]: "blob:clawhub-search-icon",
    },
    onClawHubDetailOpen,
    onClawHubInstall,
  });

  const resultItem = find(".plugin-catalog-card");
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
  expect(resultItem?.querySelector<HTMLImageElement>("img")?.src).toBe("blob:clawhub-search-icon");
  expect(installButton?.textContent?.trim()).toBe("Install");
  detailButton!.click();
  installButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

  expect(onClawHubDetailOpen).toHaveBeenCalledExactlyOnceWith("@openclaw/github");
  expect(onClawHubInstall).toHaveBeenCalledExactlyOnceWith("@openclaw/github");

  onClawHubInstall.mockClear();
  showModal.mockClear();

  await render({
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

  await vi.waitFor(() => expect(showModal).toHaveBeenCalledTimes(1));
  expect(texts(container, ".callout")).toEqual(["rate limited Retry", "Installed github"]);
  expect(normalizeText(find(".skill-reader-dialog__body")!)).toBe(
    "GitHub integration for OpenClaw By OpenClaw (@openclaw) · Latest: v1.2.3 Added search support Platforms: macos, linux",
  );
  expect(find<HTMLImageElement>(".clawhub-skill-icon--detail")?.src).toBe(
    "blob:clawhub-detail-icon",
  );
  expect(find(".clawhub-skill-icon--profile")).toBeNull();

  const detailInstallButton = find<HTMLButtonElement>(".skill-reader-dialog__actions .btn.primary");
  expect(detailInstallButton).toBeInstanceOf(HTMLButtonElement);
  expect(detailInstallButton?.textContent?.trim()).toBe("Install GitHub");
  detailInstallButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

  expect(onClawHubInstall).toHaveBeenCalledExactlyOnceWith("github");
});

it.each([
  { clawhubDetailLoading: true, clawhubDetailError: null },
  { clawhubDetailLoading: false, clawhubDetailError: "Unable to read skill" },
  { clawhubDetailLoading: false, clawhubDetailError: null },
])("keeps unavailable ClawHub details footer-free: %j", async (state) => {
  const { find } = await createView({ clawhubDetailRef: "guide", ...state });
  expect(find(".skill-reader-dialog__body")).not.toBeNull();
  expect(find(".skill-reader-dialog openclaw-modal-actions")).toBeNull();
});

it.each([false, true])("renders install-only results with installed=%s", async (installed) => {
  const onClawHubDetailOpen = vi.fn();
  const onClawHubInstall = vi.fn();
  const { all } = await createView({
    surface: "discovery",
    clawhubQuery: "pdf",
    clawhubResults: installed
      ? [externalResult]
      : [
          { ...externalResult, trustState: "not-scanned-by-clawhub" },
          {
            score: 1,
            slug: "pdf",
            installRef: "@awspace/pdf",
            registry: "https://clawhub.ai",
            displayName: "Pdf",
          },
        ],
    ...(installed
      ? {
          showInventory: false,
          report: skillReport([
            createSkill({
              clawhub: createLinkedSkill(undefined, {
                slug: "pdf",
                requestedReference: "skills-sh:openai/skills/pdf",
                installedVersion: "0.0.0",
                installedAt: 1,
              }).clawhub,
            }),
          ]),
        }
      : {}),
    onClawHubDetailOpen,
    onClawHubInstall,
  });
  const cards = all(".plugin-catalog-card");
  expect(cards).toHaveLength(installed ? 1 : 2);
  if (installed) {
    expect(cards[0]?.querySelector('[role="img"]')).not.toBeNull();
    expect(cards[0]?.querySelector(".plugin-catalog-card__install")).toBeNull();
    expect(onClawHubInstall).not.toHaveBeenCalled();
  } else {
    expect(cards[0]!.querySelector(".plugin-catalog-card__primary-link")).toBeNull();
    expect(cards[1]!.querySelector(".plugin-catalog-card__primary-link")).not.toBeNull();
    expect(cards[0]!.textContent).toContain("Not scanned by ClawHub");
    for (const card of cards) {
      card
        .querySelector<HTMLButtonElement>(".plugin-catalog-card__install")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    expect(onClawHubInstall.mock.calls.flat()).toEqual([
      "skills-sh:openai/skills/pdf",
      "@awspace/pdf",
    ]);
    expect(onClawHubDetailOpen).not.toHaveBeenCalled();
  }
});

it.each(["suspicious", "loading", "inconsistent"] as const)(
  "renders installed ClawHub verdicts: %s",
  async (mode) => {
    const suspicious = mode === "suspicious";
    const loading = mode === "loading";
    const skill = createLinkedSkill(suspicious ? "openclaw" : undefined);
    if (suspicious) {
      skill.skillCard = {
        present: true,
        path: "/tmp/workspace/skills/agentreceipt/skill-card.md",
        sizeBytes: 30,
      };
    }
    const report = skillReport([skill]);
    const verdictKey = clawhubVerdictKey({
      registry: "https://clawhub.ai",
      slug: "agentreceipt",
      ...(suspicious ? { ownerHandle: "openclaw" } : {}),
      version: "1.2.3",
    });
    const verdict = {
      registry: "https://clawhub.ai",
      ok: false,
      decision: suspicious ? "fail" : "pass",
      reasons: suspicious ? ["security.suspicious"] : [],
      requestedSlug: "agentreceipt",
      requestedVersion: "1.2.3",
      ...(suspicious
        ? {
            requestedOwnerHandle: "openclaw",
            securityAuditUrl:
              "https://clawhub.ai/openclaw/skills/agentreceipt/security-audit?version=1.2.3",
          }
        : {}),
      securityStatus: suspicious ? "suspicious" : "clean",
      securityPassed: !suspicious,
    } satisfies ClawHubSkillSecurityVerdict;
    const onDetailTabChange = vi.fn();
    const { container, find, all, render } = await createView({
      report,
      detailKey: "agentreceipt",
      onDetailTabChange,
      clawhubVerdictsLoading: loading,
      clawhubVerdicts: loading
        ? {}
        : {
            [verdictKey]: { ...verdict, slug: "agentreceipt", version: "1.2.3" },
          },
    });
    if (suspicious) {
      for (const text of ["Review", "@openclaw/agentreceipt@1.2.3", "security.suspicious"]) {
        expect(normalizeText(container)).toContain(text);
      }
      expect(find<HTMLAnchorElement>('a[href*="security-audit"]')?.textContent?.trim()).toBe(
        "Full security report",
      );
      expect(find("#skill-detail-tab-overview")?.hasAttribute("active")).toBe(true);
      find("#skill-detail-tab-card")?.dispatchEvent(
        new MouseEvent("click", { detail: 1, bubbles: true }),
      );
      expect(onDetailTabChange).toHaveBeenCalledWith("card");
      await render({
        report,
        detailKey: "agentreceipt",
        detailTab: "card",
        skillCardContents: { agentreceipt: "# AgentReceipt\n\nLocal **trust** card." },
        clawhubVerdicts: { [verdictKey]: verdict },
      });
      expect(find("#skill-detail-tab-card")?.hasAttribute("active")).toBe(true);
      expect(find(".sidebar-markdown strong")?.textContent).toBe("trust");
      expect(normalizeText(container)).toContain("AgentReceipt Local trust card.");
    } else {
      const label = loading ? "Refreshing…" : "Unavailable";
      const chips = all(".chip");
      const detailVerdict = chips.find((node) => normalizeText(node) === label);
      if (loading) {
        const rowVerdict = all(".settings-status").find((node) => normalizeText(node) === label);
        expect(rowVerdict?.classList.contains("settings-status--warn")).toBe(false);
        expect(detailVerdict?.classList.contains("chip-warn")).toBe(false);
        expect(normalizeText(container).match(/Refreshing…/gu) ?? []).toHaveLength(2);
      } else {
        expect(chips.some((chip) => normalizeText(chip) === "Clean")).toBe(false);
        expect(detailVerdict?.classList.contains("chip-ok")).toBe(false);
      }
    }
  },
);
