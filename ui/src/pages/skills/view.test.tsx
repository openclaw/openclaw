/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred as createDeferredRead, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { SkillStatusReport } from "../../api/types.ts";
import type { ClawHubSearchResult } from "../../lib/skills/clawhub-search.ts";
import {
  clawhubVerdictKey,
  type ClawHubSkillDetail,
  type ClawHubSkillSecurityVerdict,
} from "../../lib/skills/index.ts";
import { getRenderedModalDialog } from "../../test-helpers/modal-dialog.ts";
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

function buttons(root: ParentNode) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")];
}

function findButton(root: ParentNode, label: string) {
  return buttons(root).find((node) => normalizeText(node) === label);
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

  it.each([
    { editValue: "   ", disabled: true },
    { editValue: "  sk-test  ", disabled: false },
  ])(
    "only enables credential replacement for nonblank input: $editValue",
    async ({ editValue, disabled }) => {
      const container = document.createElement("div");
      installDialogMethod("showModal", function () {
        expect(this.isConnected).toBe(true);
        this.setAttribute("open", "");
      });
      const onSaveKey = vi.fn();

      renderView(container, {
        detailKey: "repo-skill",
        edits: { "repo-skill": editValue },
        onSaveKey,
      });
      document.body.append(container);
      dialogRestores.push(() => container.remove());
      const { dialog } = await getRenderedModalDialog(container);
      expect(dialog.open).toBe(true);

      const input = container.querySelector<HTMLInputElement>('input[type="password"]');
      const save = findButton(container, "Save key");
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
    const { container, render } = createView();
    const report = skillReport([
      createSkill({ skillKey: "ws", name: "Workspace Skill", source: "openclaw-workspace" }),
      createSkill({ skillKey: "bi", name: "Weather", bundled: true }),
      createSkill({ skillKey: "inst", name: "Installed Skill", source: "openclaw-managed" }),
    ]);
    const onDetailOpen = vi.fn();
    render({ report, onDetailOpen });
    await Promise.resolve();
    const groups = [...container.querySelectorAll<HTMLDetailsElement>("details.skills-group")];
    expect(groups).toHaveLength(3);
    expect(groups.every((group) => group.open)).toBe(true);
    groups[0]!.open = false;
    const row = groups[1]!.querySelector(".settings-row");
    render({ report, filter: "weather", onDetailOpen });
    await Promise.resolve();
    const remaining = container.querySelectorAll<HTMLDetailsElement>("details.skills-group");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toBe(groups[1]);
    expect(remaining[0]!.open).toBe(true);
    expect(remaining[0]!.querySelector(".settings-row")).toBe(row);
    expect(remaining[0]!.textContent).toContain("Weather");
    remaining[0]!.querySelector<HTMLButtonElement>(".plugins-item__detail-button")!.click();
    expect(onDetailOpen).toHaveBeenCalledExactlyOnceWith("bi");
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
    expect(query(".callout")?.textContent).toContain("bin:any of (claude, codex, opencode)");
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

  it("keeps the remaining skill's status and details target when a skill leaves the disabled tab", async () => {
    const { container, query, render } = createView();

    const passwordSkill = createSkill({ skillKey: "1password", name: "1Password", disabled: true });
    const appleNotesSkill = createSkill({
      skillKey: "apple-notes",
      name: "Apple Notes",
      disabled: true,
    });
    const report: SkillStatusReport = skillReport([passwordSkill, appleNotesSkill]);

    render({ report, statusFilter: "disabled" });
    await Promise.resolve();

    expect(container.querySelectorAll(".plugins-item [role=img]")).toHaveLength(2);

    const updatedReport: SkillStatusReport = skillReport([
      { ...passwordSkill, disabled: false },
      appleNotesSkill,
    ]);

    const onDetailOpen = vi.fn();
    render({ report: updatedReport, statusFilter: "disabled", onDetailOpen });
    await Promise.resolve();

    const row = query(".plugins-item")!;
    expect(container.querySelectorAll(".plugins-item")).toHaveLength(1);
    expect(row.textContent).toContain("Apple Notes");
    expect(row.querySelector("[role=img]")?.getAttribute("title")).toContain("Disabled");
    row.querySelector<HTMLButtonElement>(".plugins-item__detail-button")!.click();
    expect(onDetailOpen).toHaveBeenCalledWith("apple-notes");
  });

  it("treats skills blocked by the selected agent filter as needing setup", async () => {
    const { container, query, text, render } = createView(true);
    const report: SkillStatusReport = skillReport([createSkill({ blockedByAgentFilter: true })]);

    render({ report, statusFilter: "ready" });
    await Promise.resolve();

    expect(container.querySelectorAll(".plugins-item")).toHaveLength(0);
    expect(text()).toContain("Ready 0");
    expect(text()).toContain("Needs Setup 1");

    render({ report, statusFilter: "needs-setup", detailKey: "repo-skill" });
    await Promise.resolve();

    expect(query(".plugins-item .settings-status--warn")).not.toBeNull();
    expect(text()).toContain("Reason: blocked by agent filter");
    expect(
      Array.from(container.querySelectorAll(".chip")).map((chip) => normalizeText(chip)),
    ).toContain("blocked");
  });

  it("closes installed details and installs ClawHub details with their cached icon", async () => {
    const { container, query, render } = createView(true);
    const onDetailClose = vi.fn();
    const onClawHubInstall = vi.fn();
    installDialogMethod("close", function () {
      this.removeAttribute("open");
      this.dispatchEvent(new Event("close"));
    });
    render({ detailKey: "repo-skill", onDetailClose });
    expect((await getRenderedModalDialog(container)).dialog.open).toBe(true);
    container
      .querySelector<HTMLButtonElement>('.skill-reader-dialog [aria-label="Close"]')!
      .click();
    expect(onDetailClose).toHaveBeenCalledOnce();

    const icon = `https://clawhub.ai/api/v1/skill-icons/${"b".repeat(64)}`;
    render({
      surface: "discovery",
      clawhubSearchError: "rate limited",
      clawhubInstallMessage: { kind: "success", text: "Installed github" },
      clawhubDetailRef: "github",
      clawhubDetail: githubDetail({ icon }),
      clawhubIconUrls: { [icon]: "blob:clawhub-detail-icon" },
      onClawHubInstall,
    });
    await getRenderedModalDialog(container);
    expect([...container.querySelectorAll(".callout")].map(normalizeText)).toEqual([
      "rate limited Retry",
      "Installed github",
    ]);
    expect(container.querySelector<HTMLImageElement>(".clawhub-skill-icon--detail")?.src).toBe(
      "blob:clawhub-detail-icon",
    );
    expect(query(".clawhub-skill-icon--profile")).toBeNull();
    const install = findButton(container, "Install GitHub");
    install!.click();
    expect(onClawHubInstall).toHaveBeenCalledExactlyOnceWith("github");
  });

  it("updates the latest ClawHub version in an open detail dialog", async () => {
    const { container, query, render } = createView(true);
    const detail = {
      ...githubDetail({ summary: "GitHub integration for OpenClaw" }),
      latestVersion: { version: "1.0.0", createdAt: 1_700_000_200 },
    };
    render({ clawhubDetailRef: "github", clawhubDetail: detail });
    const { dialog } = await getRenderedModalDialog(container);
    const body = expectDefined(query(".skill-reader-dialog__body"), "ClawHub detail body");
    expect(normalizeText(body)).toContain("Latest: v1.0.0");

    render({
      clawhubDetailRef: "github",
      clawhubDetail: {
        ...detail,
        latestVersion: { version: "2.0.0", createdAt: 1_700_000_300 },
      },
    });

    expect((await getRenderedModalDialog(container)).dialog).toBe(dialog);
    expect(query(".skill-reader-dialog__body")).toBe(body);
    expect(normalizeText(body)).toContain("Latest: v2.0.0");
    expect(normalizeText(body)).not.toContain("Latest: v1.0.0");
  });

  it.each([
    [true, 1],
    [undefined, 0],
  ])(
    "marks official ClawHub skills in the detail title: isOfficial=%s",
    async (isOfficial, count) => {
      const { container, render } = createView(true);
      render({
        clawhubDetailRef: "@openclaw/github",
        clawhubDetail: githubDetail({ isOfficial }),
      });
      await getRenderedModalDialog(container);
      const badges = container.querySelectorAll(
        ".clawhub-skill-detail__identity [role='img'][aria-label='Official']",
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
    expect(native.querySelector("h2")?.textContent).toBe("Pdf");
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

  it("renders installed ClawHub verdicts and the local Skill Card tab", async () => {
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
    const onDetailTabChange = vi.fn();

    render({
      report,
      detailKey: "agentreceipt",
      onDetailTabChange,
      clawhubVerdicts: suspicious,
    });
    await Promise.resolve();

    expect(text()).toContain("Review");
    expect(text()).toContain("@openclaw/agentreceipt@1.2.3");
    expect(text()).toContain("security.suspicious");
    expect(
      container.querySelector<HTMLAnchorElement>('a[href*="security-audit"]')?.textContent?.trim(),
    ).toBe("Full security report");
    expect(query("#skill-detail-tab-overview")?.hasAttribute("active")).toBe(true);
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
      clawhubVerdicts: suspicious,
    });
    await Promise.resolve();

    expect(query("#skill-detail-tab-card")?.hasAttribute("active")).toBe(true);
    expect(query(".sidebar-markdown strong")?.textContent).toBe("trust");
    expect(text()).toContain("AgentReceipt Local trust card.");
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
    const refresh = () => findButton(container, "Loading…") ?? findButton(container, "Refresh")!;
    expect(refresh().disabled).toBe(true);
    expect(refresh().textContent).toContain("Loading");
    const updated = skillReport([createSkill({ description: "Updated description" })]);
    pending.resolve({ value: updated, error: null });
    render({ report: updated, skillsRead: pendingRead });
    await waitForFast(() => expect(row?.textContent).toContain("Updated description"));
    expect(query(".plugins-item")).toBe(row);
    expect(refresh().disabled).toBe(false);
    expect(refresh().textContent).toContain("Refresh");
  });

  it("renders card read errors and retries inside the existing detail dialog", async () => {
    const { container, render } = createView(true);
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
        detailTab: "card",
        skillCardReads: { "repo-skill": receipt },
        skillCardContents: content === undefined ? {} : { "repo-skill": content },
      });
    showCard(read);
    const { dialog } = await getRenderedModalDialog(container);
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
    expect((await getRenderedModalDialog(container)).dialog).toBe(dialog);
    expect(dialog.querySelector('[role="alert"]')).toBeNull();
  });

  it("retains inventory and dialog through missing verdicts, read failure, and retry", async () => {
    const { container, query } = createView(true);
    const first = createDeferred<Record<string, ClawHubSkillSecurityVerdict>>();
    const changeRead = mountVerdictView(container, first.promise);
    const { dialog } = await getRenderedModalDialog(container);
    const row = query(".plugins-item");
    const search = query('input[name="skills-filter"]');
    const verdictLabels = () =>
      [...container.querySelectorAll(".settings-status, .chip")].map(normalizeText);
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
    expect((await getRenderedModalDialog(container)).dialog).toBe(dialog);
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
    await Promise.resolve();

    const chips = Array.from(container.querySelectorAll(".chip"));
    const verdictChip = chips.find((chip) => normalizeText(chip) === "Unavailable");
    expect(verdictChip).toBeDefined();
    expect(chips.some((chip) => normalizeText(chip) === "Clean")).toBe(false);
    expect(verdictChip?.classList.contains("chip-ok")).toBe(false);
  });
});
