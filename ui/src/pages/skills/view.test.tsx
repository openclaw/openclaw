/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred as createDeferredRead, createSignal } from "solid-js";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { SkillStatusReport } from "../../api/types.ts";
import type { ClawHubSearchResult } from "../../lib/skills/clawhub-search.ts";
import {
  clawhubVerdictKey,
  type ClawHubSkillDetail,
  type ClawHubSkillSecurityVerdict,
} from "../../lib/skills/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { cleanupSkillsViews, renderSkills } from "./view.solid.test-support.tsx";
import {
  createDialogMethodInstaller,
  createProps,
  createReport as skillReport,
  createSkill,
  normalizeText,
} from "./view.test-support.ts";
import { Skills } from "./view.tsx";

// Keep short render waits scoped to UI state, after the lazy detail module is compiled.
beforeAll(() => import("./skill-detail.tsx"));
afterEach(cleanupSkillsViews);

const dialogRestores: Array<() => void> = [];
const installDialogMethod = createDialogMethodInstaller(dialogRestores);

function createView(dialog = false) {
  if (dialog) {
    installDialogMethod("showModal", function () {
      this.setAttribute("open", "");
    });
  }
  const container = document.createElement("div");
  document.body.append(container);
  dialogRestores.push(() => container.remove());
  return {
    container,
    query: (selector: string) => container.querySelector<HTMLElement>(selector),
    text: () => normalizeText(container),
    render: (overrides: Parameters<typeof createProps>[0] = {}) => renderView(container, overrides),
  };
}

/** A skill page arrives with its lazily loaded code; wait for it to render. */
async function renderedPage(container: HTMLElement): Promise<HTMLElement> {
  const loaded = () => container.querySelector<HTMLElement>(".skill-page h1, .skill-page__absent");
  await waitForFast(() => expect(loaded()).not.toBeNull());
  return expectDefined(loaded()?.closest<HTMLElement>(".skill-page"), "skill page");
}

function buttons(root: ParentNode) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")];
}

function findButton(root: ParentNode, label: string) {
  return buttons(root).find(
    (node) => normalizeText(node) === label || node.getAttribute("aria-label") === label,
  );
}

function githubDetail(skill: Partial<ClawHubSkillDetail["skill"]> = {}): ClawHubSkillDetail {
  return {
    skill: {
      slug: "github",
      displayName: "GitHub",
      createdAt: 1_700_000_000,
      updatedAt: 1_700_000_100,
      ...skill,
    },
  };
}

function searchResult(overrides: Partial<ClawHubSearchResult> = {}): ClawHubSearchResult {
  return {
    score: 1,
    slug: "pdf",
    installRef: "@fixture/pdf",
    registry: "https://clawhub.ai",
    displayName: "Pdf",
    ...overrides,
  };
}

function verdict(overrides: Partial<ClawHubSkillSecurityVerdict> = {}) {
  return {
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
    ...overrides,
  } satisfies ClawHubSkillSecurityVerdict;
}

function verdicts(value = verdict(), ownerHandle?: string) {
  return {
    [clawhubVerdictKey({
      registry: "https://clawhub.ai",
      slug: "agentreceipt",
      version: "1.2.3",
      ownerHandle,
    })]: value,
  };
}

function renderView(container: HTMLElement, overrides: Parameters<typeof createProps>[0] = {}) {
  renderSkills(createProps(overrides), container);
}

type Verdicts = Record<string, ClawHubSkillSecurityVerdict>;

function mountVerdictView(container: HTMLElement, initial: Promise<Verdicts>) {
  let changeRead: ((next: Promise<Verdicts>) => void) | undefined;
  const owner = mountSolid(
    () => {
      const [receipt, setReceipt] = createSignal(initial);
      changeRead = (next) => {
        void setReceipt(next);
      };
      const read = createDeferredRead(() => receipt());
      const props = createProps({
        report: skillReport([createLinkedSkill()]),
        readClawHubVerdicts: read,
        detailKey: "agentreceipt",
      });
      return <Skills {...props} />;
    },
    { container },
  );
  dialogRestores.push(owner.unmount);
  return (next: Promise<Verdicts>) => expectDefined(changeRead, "verdict receipt callback")(next);
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
  afterEach(() => {
    vi.restoreAllMocks();
    while (dialogRestores.length > 0) {
      dialogRestores.pop()?.();
    }
  });

  const secretRef = { source: "env", provider: "default", id: "KEY" };
  it.each([
    { editValue: "   ", disabled: true },
    { editValue: "  sk-test  ", disabled: false },
    { editValue: "sk-test", disabled: true, apiKey: secretRef, text: "Set by a SecretRef." },
    { editValue: "sk-test", disabled: true, error: "denied", text: "Couldn't read the config" },
  ])(
    "only enables credential replacement for nonblank input over plaintext: %o",
    async ({ editValue, disabled, apiKey, error, text }) => {
      const container = document.createElement("div");
      const onSaveKey = vi.fn();
      const retry = vi.fn();
      const config = { skills: { entries: { "repo-skill": { apiKey } } } };
      const snapshot = error ? null : { config, parsed: config, valid: true };

      renderView(container, {
        detailKey: "repo-skill",
        edits: { "repo-skill": editValue },
        apiKeyConfig: { snapshot: () => snapshot, error: () => error ?? null, retry },
        onSaveKey,
      });
      document.body.append(container);
      dialogRestores.push(() => container.remove());
      await renderedPage(container);

      const input = container.querySelector<HTMLInputElement>('input[type="password"]');
      const save = findButton(container, "Save key");
      expect(input?.required).toBe(true);
      expect(input?.getAttribute("aria-label")).toBe("API key (OPENAI_API_KEY)");
      expect(save?.disabled).toBe(disabled);
      expect(input?.disabled).toBe(Boolean(text));
      expect(`${input?.placeholder} ${container.textContent}`).toContain(text ?? "");
      findButton(container, "Retry")?.click();
      expect(retry).toHaveBeenCalledTimes(error ? 1 : 0);

      save?.click();

      if (disabled) {
        expect(onSaveKey).not.toHaveBeenCalled();
      } else {
        expect(onSaveKey).toHaveBeenCalledWith("repo-skill", expect.any(Function));
      }
    },
  );

  it("distinguishes an empty inventory from a search with no matches", async () => {
    const { container, render } = createView();
    render({ report: skillReport([]) });
    await Promise.resolve();
    expect(container.textContent).toContain("No skills yet. Search ClawHub to add one.");
    render({ report: skillReport([createSkill()]), filter: "no-matching-skill" });
    await Promise.resolve();
    expect(container.textContent).toContain("No skills match your search.");
    expect(container.textContent).not.toContain("No skills yet.");
  });

  it("preserves Unicode matches, raw detail targets and retained groups", async () => {
    const { container, render } = createView();
    const report = skillReport([
      createSkill({ skillKey: "ws", name: "Workspace Skill", source: "openclaw-workspace" }),
      createSkill({ skillKey: "Cafe\u0301-key", name: "Cafe\u0301", bundled: true }),
      createSkill({ skillKey: "inst", name: "Installed Skill", source: "openclaw-managed" }),
    ]);
    const onDetailOpen = vi.fn();
    render({ report, onDetailOpen });
    await waitForFast(() =>
      expect(container.querySelector('.skills-group[aria-busy="true"]')).toBeNull(),
    );
    const groups = [...container.querySelectorAll<HTMLDetailsElement>("details.skills-group")];
    expect(groups).toHaveLength(3);
    expect(groups.every((group) => group.open)).toBe(true);
    groups[0]!.open = false;
    const row = groups[1]!.querySelector(".settings-row");
    render({ report, filter: "CAFÉ", onDetailOpen });
    await Promise.resolve();
    const remaining = container.querySelectorAll<HTMLDetailsElement>("details.skills-group");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe(groups[1]);
    expect(remaining[0]!.open).toBe(true);
    expect(remaining[0]!.querySelector(".settings-row")).toBe(row);
    expect(remaining[0]!.textContent).toContain("Cafe\u0301");
    remaining[0]!.querySelector<HTMLButtonElement>(".plugins-item__detail-button")!.click();
    expect(onDetailOpen).toHaveBeenCalledExactlyOnceWith("Cafe\u0301-key");
    render({ report });
    await Promise.resolve();
    const restored = [...container.querySelectorAll<HTMLDetailsElement>("details.skills-group")];
    expect(restored).toHaveLength(3);
    expect(restored.every((group) => group.open)).toBe(true);
  });

  it("offers only an installer satisfying a missing alternative", async () => {
    const { container, query, render } = createView(true);
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
    const skill = createSkill({
      skillKey: "coding-agent",
      name: "Coding Agent",
      missing: { bins: [], anyBins: ["claude", "codex", "opencode"], env: [], config: [], os: [] },
      eligible: false,
      install: [unrelated, codex],
    });
    render({ report: skillReport([skill]), detailKey: "coding-agent", onInstall });
    await Promise.resolve();
    expect(findButton(container, "Install unrelated CLI")).toBeUndefined();
    const install = findButton(container, "Install Codex CLI");
    expect(query(".skill-requirement")?.textContent).toContain("claude / codex / opencode");
    install!.click();
    expect(onInstall).toHaveBeenCalledWith("coding-agent", "Coding Agent", "node-codex");
  });

  it("keeps update/install permissions independent and locks all controls during a mutation", async () => {
    const { container } = createView(true);
    const calendar = createSkill({
      skillKey: "calendar",
      name: "Calendar",
      missing: { anyBins: [], bins: ["calendar-cli"], env: [], config: [], os: [] },
      install: [
        { id: "calendar-cli", kind: "brew", label: "Install calendar-cli", bins: ["calendar-cli"] },
      ],
    });
    const report: SkillStatusReport = skillReport([createSkill(), calendar]);
    const onMutation = vi.fn();

    const props = createProps({
      report,
      detailKey: "calendar",
      operation: { kind: "skill", skillKey: "repo-skill" },
      clawhubResults: [searchResult({ installRef: "@openclaw/github" })],
      onRefresh: onMutation,
      onToggle: onMutation,
      onSaveKey: onMutation,
      onInstall: onMutation,
      onClawHubInstall: onMutation,
    });
    renderSkills(
      {
        ...props,
        canUpdate: false,
        canInstall: true,
        toggleSavingSkillKey: calendar.skillKey,
        state: { ...props.state, skillOperation: null },
      },
      container,
    );
    await Promise.resolve();
    expect(
      container.querySelector<HTMLInputElement>("input.settings-toggle__input")?.disabled,
    ).toBe(true);
    expect(findButton(container, "Install calendar-cli")?.disabled).toBe(false);
    renderSkills(props, container);
    await Promise.resolve();

    const controls = [
      findButton(container, "Refresh"),
      container.querySelector<HTMLInputElement>("input.settings-toggle__input"),
      container.querySelector<HTMLInputElement>('input[type="password"]'),
      findButton(container, "Install calendar-cli"),
      findButton(container, "Save key"),
    ];
    expect(container.querySelectorAll(".plugins-item input.settings-toggle__input")).toHaveLength(
      0,
    );
    for (const control of controls) {
      expect(control?.disabled).toBe(true);
      control?.click();
    }
    expect(onMutation).not.toHaveBeenCalled();

    renderSkills({ ...props, surface: "discovery" }, container);
    const remoteInstall = container.querySelector<HTMLButtonElement>(
      ".plugin-catalog-card__install",
    );
    expect(remoteInstall?.disabled).toBe(true);
    remoteInstall?.click();
    expect(onMutation).not.toHaveBeenCalled();
  });

  it("leaves focus where it was when discovery opens", async () => {
    const { container, render } = createView();
    render({ surface: "discovery" });
    await Promise.resolve();
    const search = container.querySelector<HTMLInputElement>('input[name="skills-search"]')!;
    expect(search.hasAttribute("autofocus")).toBe(false);
    expect(document.activeElement === search).toBe(false);
  });

  it("keeps status and detail targets after a Unicode-filtered row is enabled", async () => {
    const { container, query, render } = createView();

    const passwordSkill = createSkill({ skillKey: "1password", name: "Café Pass", disabled: true });
    const appleNotesSkill = createSkill({
      skillKey: "apple-notes",
      name: "Café Notes",
      disabled: true,
    });
    const report: SkillStatusReport = skillReport([passwordSkill, appleNotesSkill]);

    render({ report, statusFilter: "disabled", filter: "Cafe\u0301" });
    await waitForFast(() =>
      expect(container.querySelector('.skills-group[aria-busy="true"]')).toBeNull(),
    );

    expect(container.querySelectorAll(".plugins-item [role=img]")).toHaveLength(2);

    const updatedReport: SkillStatusReport = skillReport([
      { ...passwordSkill, disabled: false },
      appleNotesSkill,
    ]);

    const onDetailOpen = vi.fn();
    render({ report: updatedReport, filter: "Cafe\u0301", statusFilter: "disabled", onDetailOpen });
    await Promise.resolve();

    const row = query(".plugins-item")!;
    expect(container.querySelectorAll(".plugins-item")).toHaveLength(1);
    expect(row.textContent).toContain("Café Notes");
    expect(row.querySelector("[role=img]")?.getAttribute("title")).toContain("Disabled");
    row.querySelector<HTMLButtonElement>(".plugins-item__detail-button")!.click();
    expect(onDetailOpen).toHaveBeenCalledWith("apple-notes");
  });

  it("filters by status from the select", async () => {
    const { container, render } = createView(true);
    const onStatusFilterChange = vi.fn();
    render({
      report: skillReport([
        createSkill({ disabled: true }),
        createSkill({ skillKey: "second", name: "Second" }),
      ]),
      onStatusFilterChange,
    });
    await Promise.resolve();

    const select = container.querySelector<HTMLSelectElement>(".skills-toolbar__status")!;
    select.value = "needs-setup";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onStatusFilterChange).toHaveBeenCalledWith("needs-setup");
  });

  it("treats skills blocked by the selected agent filter as needing setup", async () => {
    const { container, query, text, render } = createView(true);
    const report: SkillStatusReport = skillReport([createSkill({ blockedByAgentFilter: true })]);

    render({ report, statusFilter: "ready" });
    await Promise.resolve();

    expect(container.querySelectorAll(".plugins-item")).toHaveLength(0);
    expect(text()).toContain("Ready 0");
    expect(text()).toContain("Needs setup 1");

    render({ report, statusFilter: "needs-setup", detailKey: "repo-skill" });
    await renderedPage(container);

    expect(query(".plugins-item .settings-status--warn")).not.toBeNull();
    expect(text()).toContain("Reason: blocked by agent filter");
    expect(query(".skill-page .settings-status--warn")).not.toBeNull();
  });

  it("gives one signal per meaning and says why the toggle is locked", async () => {
    const { container, query, render } = createView(true);
    render({
      report: skillReport([createLinkedSkill()]),
      detailKey: "agentreceipt",
      canUpdate: false,
    });
    const dialog = await renderedPage(container);
    expect(query(".skill-page h1 .statusDot")).toBeNull();
    const labels = Array.from(dialog.querySelectorAll(".skill-page__facts dt")).map(normalizeText);
    expect(labels).toEqual(expect.arrayContaining(["Package", "Security check", "Source"]));
    expect(normalizeText(dialog)).toContain("You need admin access to change this skill.");
    expect(container.querySelector(".skill-page input[type=checkbox]")).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("leaves installed pages by their way back and installs ClawHub pages with their cached icon", async () => {
    const { container, query, render } = createView();
    const onDetailClose = vi.fn();
    const onClawHubInstall = vi.fn();
    render({ detailKey: "repo-skill", onDetailClose });
    await renderedPage(container);
    // The list stays mounted behind the page, so going back finds it as it was.
    expect(query(".skills-list-surface")?.hidden).toBe(true);
    const back = expectDefined(
      container.querySelector<HTMLAnchorElement>(
        ".skill-page .plugins-settings-breadcrumb__parent",
      ),
      "way back",
    );
    expect(back.getAttribute("href")).toBe("/skills");
    expect(normalizeText(back)).toBe("Skills");
    back.click();
    expect(onDetailClose).toHaveBeenCalledOnce();

    const icon = `https://clawhub.ai/api/v1/skill-icons/${"b".repeat(64)}`;
    render({
      surface: "discovery",
      clawhubSearchError: "rate limited",
      clawhubInstallMessage: { ref: "other", kind: "success", text: "Installed other" },
      clawhubDetailRef: "github",
      clawhubDetail: githubDetail({ icon }),
      clawhubIconUrls: { [icon]: "blob:clawhub-detail-icon" },
      onClawHubInstall,
    });
    await renderedPage(container);
    expect([...container.querySelectorAll(".callout")].map(normalizeText)).toEqual([
      "rate limited Retry",
      "Installed other",
    ]);
    expect(container.querySelector<HTMLImageElement>(".skill-page__tile img")?.src).toBe(
      "blob:clawhub-detail-icon",
    );
    expect(query(".skill-tile--profile")).toBeNull();
    const install = findButton(container, "Add GitHub");
    install!.click();
    expect(onClawHubInstall).toHaveBeenCalledExactlyOnceWith("github");
  });

  it("swaps Installed for the added skill's switch once the inventory names it", async () => {
    const { container, query, render } = createView(true);
    const onToggle = vi.fn();
    const added = createSkill({
      skillKey: "github",
      name: "github",
      clawhub: {
        status: "linked",
        valid: true,
        registry: "https://clawhub.ai",
        slug: "github",
        ownerHandle: "openclaw",
        installedVersion: "1.0.0",
        installedAt: 123,
        originPath: "/tmp/.clawhub/origin.json",
        lockPath: "/tmp/workspace/.clawhub/lock.json",
      },
    });
    const opened = {
      surface: "discovery",
      clawhubInstallMessage: { ref: "@openclaw/github", kind: "success", text: "Installed" },
      clawhubDetailRef: "@openclaw/github",
      clawhubDetail: {
        ...githubDetail(),
        registry: "https://clawhub.ai",
        card: { status: "available", content: "# GitHub skill card" },
      },
      onToggle,
    } satisfies Parameters<typeof createProps>[0];
    // Before the inventory names it, the dialog can only say it was added.
    render({ ...opened, report: skillReport([]), mutationSkills: [] });
    const skillPage = await renderedPage(container);
    expect(normalizeText(expectDefined(query(".plugin-catalog-detail__actions"), "actions"))).toBe(
      "Installed",
    );

    render({ ...opened, report: skillReport([added]), mutationSkills: [added] });
    await Promise.resolve();
    const toggle = expectDefined(
      query('.plugin-catalog-detail__actions input[role="switch"]'),
      "added skill switch",
    );
    expect(normalizeText(expectDefined(query(".plugin-catalog-detail__actions"), "actions"))).toBe(
      "Enabled",
    );
    toggle.click();
    expect(onToggle).toHaveBeenCalledExactlyOnceWith("github", false);

    render({
      ...opened,
      report: skillReport([added]),
      mutationSkills: [added],
      messages: { github: { kind: "error", message: "Could not disable GitHub" } },
    });
    await waitForFast(() => {
      expect(query('.skill-page [role="alert"]')?.textContent ?? "").toContain(
        "Could not disable GitHub",
      );
      expect(skillPage.querySelector(".sidebar-markdown")?.textContent).toContain(
        "GitHub skill card",
      );
      expect(query(".skill-page")).toBe(skillPage);
      expect(skillPage.querySelector('input[role="switch"]')).toBe(toggle);
    });
  });

  it("updates the latest ClawHub version on an open page", async () => {
    const { container, render } = createView();
    const detail = {
      ...githubDetail({ summary: "GitHub integration for OpenClaw" }),
      latestVersion: { version: "1.0.0", createdAt: 1_700_000_200 },
    };
    render({ clawhubDetailRef: "github", clawhubDetail: detail });
    const body = await renderedPage(container);
    const version = () =>
      normalizeText(expectDefined(body.querySelector(".skill-page__facts dd"), "version fact"));
    expect(version()).toBe("1.0.0");

    render({
      clawhubDetailRef: "github",
      clawhubDetail: {
        ...detail,
        latestVersion: { version: "2.0.0", createdAt: 1_700_000_300 },
      },
    });

    expect(await renderedPage(container)).toBe(body);
    expect(version()).toBe("2.0.0");
  });

  it.each([
    [true, 1],
    [undefined, 0],
  ])(
    "marks official ClawHub skills beside their publisher: isOfficial=%s",
    async (isOfficial, count) => {
      const { container, render } = createView();
      render({
        clawhubDetailRef: "@openclaw/github",
        clawhubDetail: { ...githubDetail({ isOfficial }), owner: { handle: "openclaw" } },
      });
      await renderedPage(container);
      const badges = container.querySelectorAll(
        ".skill-page__byline [role='img'][aria-label='Official']",
      );
      expect(badges).toHaveLength(count);
    },
  );

  it("offers install without a detail card for an install-only search result", async () => {
    const { container, render } = createView();
    const onClawHubDetailOpen = vi.fn();
    const onClawHubInstall = vi.fn();
    const icon = `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`;

    render({
      surface: "discovery",
      clawhubQuery: "pdf",
      clawhubResults: [
        searchResult({
          // The Gateway marks external sources install-only; it serves no card for them.
          installRef: "skills-sh:openai/skills/pdf",
          installOnly: true,
          trustState: "not-scanned-by-clawhub",
        }),
        searchResult({ installRef: "@awspace/pdf", summary: "Native PDF integration", icon }),
      ],
      clawhubIconUrls: { [icon]: "blob:clawhub-search-icon" },
      onClawHubDetailOpen,
      onClawHubInstall,
    });
    await Promise.resolve();

    const rows = [...container.querySelectorAll<HTMLElement>(".plugin-catalog-card")];
    expect(rows).toHaveLength(2);
    // A detail button on the external row would open a dialog the Gateway always refuses.
    expect(rows[0]!.querySelector(".plugin-catalog-card__primary-link")).toBeNull();
    expect(rows[1]!.querySelector(".plugin-catalog-card__primary-link")).not.toBeNull();
    const native = rows[1]!;
    const detail = native.querySelector<HTMLButtonElement>(".plugin-catalog-card__primary-link")!;
    expect(detail.getAttribute("aria-label")).toBe("Open Pdf details");
    expect(detail.querySelector(".plugin-catalog-card__install")).toBeNull();
    expect(native.querySelector("h3")?.textContent).toBe("Pdf");
    expect(native.querySelector(".plugin-card-author")?.textContent).toBe("@awspace/pdf");
    expect(native.textContent).toContain("Native PDF integration");
    expect(native.querySelector<HTMLImageElement>("img")?.src).toBe("blob:clawhub-search-icon");
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
    detail.click();
    expect(onClawHubDetailOpen).toHaveBeenCalledExactlyOnceWith("@awspace/pdf");
  });

  it("shows one installed external card without another install action", async () => {
    const { container, render } = createView();
    const onClawHubInstall = vi.fn();

    render({
      surface: "discovery",
      showInventory: false,
      clawhubQuery: "pdf",
      clawhubResults: [
        searchResult({
          installRef: "skills-sh:openai/skills/pdf",
          installOnly: true,
        }),
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

  it("renders installed ClawHub verdicts and the local Skill Card on request", async () => {
    const { container, query, text, render } = createView(true);

    const linkedSkill = createSkill({
      ...createLinkedSkill("openclaw"),
      skillCard: {
        present: true,
        path: "/tmp/workspace/skills/agentreceipt/skill-card.md",
        sizeBytes: 30,
      },
    });
    const report: SkillStatusReport = skillReport([linkedSkill]);
    const suspicious = verdicts(
      verdict({
        ok: false,
        decision: "fail",
        reasons: ["security.suspicious"],
        requestedOwnerHandle: "openclaw",
        securityStatus: "suspicious",
        securityPassed: false,
        securityAuditUrl:
          "https://clawhub.ai/openclaw/skills/agentreceipt/security-audit?version=1.2.3",
      }),
      "openclaw",
    );
    render({
      report,
      detailKey: "agentreceipt",
      clawhubVerdicts: suspicious,
    });
    await renderedPage(container);

    expect(text()).toContain("Review");
    expect(text()).toContain("@openclaw/agentreceipt@1.2.3");
    expect(text()).toContain("security.suspicious");
    expect(
      container
        .querySelector<HTMLAnchorElement>('a[href*="security-audit"]')
        ?.getAttribute("aria-label"),
    ).toBe("Full security report");
    expect(text()).toContain("Skill card");

    render({
      report,
      detailKey: "agentreceipt",
      skillCardContents: {
        agentreceipt: "# AgentReceipt\n\nLocal **trust** card.",
      },
      clawhubVerdicts: suspicious,
    });
    await Promise.resolve();

    expect(query(".sidebar-markdown strong")?.textContent).toBe("trust");
    expect(text()).toContain("AgentReceipt Local trust card.");
  });

  it("updates retained row status after filtering and verdict changes", async () => {
    const { query, render } = createView();
    const skill = createLinkedSkill();
    const report = skillReport([skill]);
    render({ report, clawhubVerdicts: verdicts() });
    const row = query(".plugins-item");
    const status = query(".skill-row-status");
    render({ report, filter: skill.name, clawhubVerdicts: verdicts() });
    expect(query(".plugins-item")).toBe(row);
    expect(query(".skill-row-status")).toBe(status);

    render({
      report,
      filter: skill.name,
      clawhubVerdicts: verdicts(
        verdict({
          ok: false,
          decision: "fail",
          securityStatus: "suspicious",
          reasons: ["security.suspicious"],
        }),
      ),
    });
    expect(query(".skill-row-status")).toBe(status);
    expect(status?.getAttribute("aria-label")).toContain("Review · security.suspicious");

    render({
      report: skillReport([
        { ...skill, eligible: false, missing: { ...skill.missing, bins: ["fixture-cli"] } },
      ]),
      filter: skill.name,
      clawhubVerdicts: verdicts(),
    });
    expect(query(".skill-row-status")).toBe(status);
    expect(status?.getAttribute("title")).toContain("Needs setup · bin:fixture-cli");
  });

  it("retains the toolbar and keyed rows across status reads", async () => {
    const { container, query, render } = createView();
    const initial = createDeferred<{ value: SkillStatusReport | null; error: string | null }>();
    const initialRead = { completion: initial.promise };
    render({ report: null });
    const search = container.querySelector<HTMLInputElement>('input[name="skills-filter"]')!;
    search.focus();
    render({ report: null, loading: true, skillsRead: initialRead });
    expect(query('input[name="skills-filter"]')).toBe(search);
    expect(document.activeElement).toBe(search);
    expect(query(".plugins-item")).toBeNull();
    const report = skillReport([createSkill()]);
    initial.resolve({ value: report, error: null });
    render({ report, skillsRead: initialRead });
    await waitForFast(() => expect(query(".plugins-item")).not.toBeNull());
    const row = query(".plugins-item");
    const pending = createDeferred<{ value: SkillStatusReport | null; error: string | null }>();
    const pendingRead = { completion: pending.promise };
    render({ report, loading: true, skillsRead: pendingRead });
    expect(query(".plugins-item")).toBe(row);
    expect(query('input[name="skills-filter"]')).toBe(search);
    expect(document.activeElement).toBe(search);
    const refresh = () => findButton(container, "Refresh")!;
    expect(refresh().disabled).toBe(true);
    expect(refresh().getAttribute("aria-busy")).toBe("true");
    const updated = skillReport([createSkill({ description: "Updated description" })]);
    pending.resolve({ value: updated, error: null });
    render({ report: updated, skillsRead: pendingRead });
    await waitForFast(() => expect(row?.textContent).toContain("Updated description"));
    expect(query(".plugins-item")).toBe(row);
    expect(refresh().disabled).toBe(false);
    expect(refresh().getAttribute("aria-busy")).toBeNull();
  });

  it("renders card read errors and retries inside the open page", async () => {
    const { container, render } = createView();
    const report = skillReport([
      createSkill({
        skillCard: { present: true, path: "/tmp/skill/SKILL.md", sizeBytes: 12 },
      }),
    ]);
    const pending = createDeferred<{ value: string | undefined; error: string | null }>();
    const read = { cacheKey: "/tmp/skill/SKILL.md\0v1", completion: pending.promise };
    const showCard = (receipt: typeof read, content?: string) =>
      render({
        report,
        detailKey: "repo-skill",
        skillCardReads: { "repo-skill": receipt },
        skillCardContents: content === undefined ? {} : { "repo-skill": content },
      });
    showCard(read);
    const dialog = await renderedPage(container);
    expect(normalizeText(dialog)).toContain("Loading");
    pending.resolve({ value: undefined, error: "Card temporarily unavailable" });
    await waitForFast(() =>
      expect(normalizeText(dialog)).toContain("Card temporarily unavailable"),
    );
    const retry = createDeferred<{ value: string | undefined; error: string | null }>();
    const retriedRead = { cacheKey: read.cacheKey, completion: retry.promise };
    showCard(retriedRead);
    await waitForFast(() => expect(normalizeText(dialog)).toContain("Loading"));
    expect(normalizeText(dialog)).not.toContain("Card temporarily unavailable");
    retry.resolve({ value: "# Restored card", error: null });
    showCard(retriedRead, "# Restored card");
    await waitForFast(() => expect(normalizeText(dialog)).toContain("Restored card"));
    expect(await renderedPage(container)).toBe(dialog);
    expect(dialog.querySelector('[role="alert"]')).toBeNull();
  });

  it("retains inventory and page through missing verdicts, read failure, and retry", async () => {
    const { container, query } = createView();
    const first = createDeferred<Record<string, ClawHubSkillSecurityVerdict>>();
    const changeRead = mountVerdictView(container, first.promise);
    const dialog = await renderedPage(container);
    const row = query(".plugins-item");
    const search = query('input[name="skills-filter"]');
    const verdictLabels = () =>
      [
        ...container.querySelectorAll(
          ".settings-status, .chip, .plugin-catalog-detail__security-verdict",
        ),
      ].map(normalizeText);
    expect(verdictLabels().filter((label) => label === "Refreshing…")).toHaveLength(2);
    first.reject(new Error("Verdicts temporarily unavailable"));
    await waitForFast(() =>
      expect(normalizeText(dialog)).toContain("Verdicts temporarily unavailable"),
    );
    const retry = createDeferred<Record<string, ClawHubSkillSecurityVerdict>>();
    changeRead(retry.promise);
    await waitForFast(() => expect(normalizeText(dialog)).toContain("Refreshing"));
    expect(normalizeText(dialog)).not.toContain("Verdicts temporarily unavailable");
    retry.resolve({});
    await waitForFast(() => expect(normalizeText(dialog)).toContain("Unavailable"));
    expect(verdictLabels().filter((label) => label === "Unavailable")).toHaveLength(2);
    expect(query(".plugins-item")).toBe(row);
    expect(query('input[name="skills-filter"]')).toBe(search);
    expect(await renderedPage(container)).toBe(dialog);
    expect(normalizeText(dialog)).not.toContain("Verdicts temporarily unavailable");
  });

  it("fails closed for inconsistent ClawHub verdict envelopes", async () => {
    const { container, render } = createView(true);

    const report = skillReport([createLinkedSkill()]);
    render({
      report,
      detailKey: "agentreceipt",
      clawhubVerdicts: verdicts(verdict({ ok: false })),
    });
    await renderedPage(container);

    const security = expectDefined(
      container.querySelector(".skill-page .plugin-catalog-detail__security"),
      "security fact",
    );
    expect(normalizeText(security.querySelector("dd")!)).toContain("Unavailable");
    expect(normalizeText(security)).not.toContain("Clean");
    expect(security.classList.contains("plugin-catalog-detail__security--pass")).toBe(false);
  });
});
